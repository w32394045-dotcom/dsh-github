/**
 * `github-search` 的离线行为测试。
 *
 * 这是全套工具里调用最频繁的一个，所以它比其他工具多做了查询增强、分页、缓存与
 * 错误翻译——每一条都必须被测到，否则「搜索悄悄返回错东西」这类问题只会在真实
 * 使用中才暴露。测试全程 stub 掉 `globalThis.fetch`，不消耗任何 API 额度。
 *
 * 运行：node test/search-unit.mjs
 *
 * @module @ptfm/dsh-github/test/search-unit
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 通过计数。 */
let passed = 0
/** 失败计数。 */
let failed = 0

/**
 * 断言。
 * @param {boolean} condition
 * @param {string} label
 * @param {string} [detail]
 */
function ok(condition, label, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}${detail === '' ? '' : `　→ ${detail}`}`)
  }
}

/* ------------------------------------------------------------- 隔离环境 */

// 临时 home：写入一次「已登录」状态，让 @me 能展开、状态查询能取到登录名。
const home = mkdtempSync(join(tmpdir(), 'dsh-github-search-'))
process.env.DSH_HOME = home
delete process.env.GITHUB_TOKEN
delete process.env.DSH_GITHUB_TOKEN
writeFileSync(join(home, 'github.json'), JSON.stringify({
  token: 'ghp_testtoken0000000000000000000000000000',
  tokenKind: 'pat',
  login: 'octocat',
  scopes: ['repo'],
}), 'utf8')

// 造一个「当前工作目录所属的 git 仓库」，用来验证自动限定仓库。
const workRoot = join(home, 'work')
const repoDir = join(workRoot, 'widget')
mkdirSync(join(repoDir, '.git'), { recursive: true })
mkdirSync(join(repoDir, 'src', 'deep'), { recursive: true })
writeFileSync(
  join(repoDir, '.git', 'config'),
  '[remote "origin"]\n\turl = https://github.com/acme/widget.git\n',
  'utf8',
)
process.chdir(repoDir)

const { runTool } = await import('../lib/tools.mjs')

/* --------------------------------------------------------- fetch 桩 */

/** 记录每次请求的 URL 与方法。 */
const calls = []
/** 下一次响应要返回的内容。 */
let nextResponse = { status: 200, body: { total_count: 0, items: [] } }

globalThis.fetch = async (url, init = {}) => {
  calls.push({ url: String(url), method: String(init.method ?? 'GET') })
  const response = nextResponse
  return new Response(JSON.stringify(response.body), {
    status: response.status,
    headers: {
      'content-type': 'application/json',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-remaining': '4999',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      'x-oauth-scopes': 'repo',
      ...(response.headers ?? {}),
    },
  })
}

/** 取最后一次请求的 query string 参数。 */
function lastQuery() {
  const url = new URL(calls[calls.length - 1].url)
  return url.searchParams
}

/* ------------------------------------------------------------- 用例 */

console.log('== 空关键词与未知 kind（不触网）')
{
  const before = calls.length
  const empty = await runTool('github-search', { query: '' })
  ok(calls.length === before, '空 query 不发请求')
  ok(empty.text.includes('关键词不能为空'), '空 query 给出明确原因')
  ok(empty.text.includes('repo:owner/name'), '空 query 给出可用示例')

  const bad = await runTool('github-search', { query: 'x', kind: 'wikis' })
  ok(bad.text.includes('未知 kind'), '未知 kind 被拒绝')
  ok(calls.length === before, '未知 kind 不发请求')
}

console.log('\n== 自动限定到当前目录的 git 仓库')
{
  calls.length = 0
  nextResponse = {
    status: 200,
    body: {
      total_count: 2,
      incomplete_results: false,
      items: [
        {
          number: 7,
          title: '崩溃：导入大文件时 OOM',
          state: 'open',
          labels: [{ name: 'bug' }, { name: 'P1' }],
          comments: 3,
          updated_at: '2026-09-30T12:00:00Z',
          html_url: 'https://github.com/acme/widget/issues/7',
          user: { login: 'reporter' },
          repository_url: 'https://api.github.com/repos/acme/widget',
        },
        {
          number: 9,
          title: '已合并的修复 PR',
          state: 'closed',
          labels: [],
          comments: 0,
          updated_at: '2026-09-29T12:00:00Z',
          html_url: 'https://github.com/acme/widget/pull/9',
          user: { login: 'dev' },
          repository_url: 'https://api.github.com/repos/acme/widget',
          pull_request: { merged_at: '2026-09-29T13:00:00Z' },
        },
      ],
    },
  }
  const result = await runTool('github-search', { query: 'OOM', kind: 'issues' })
  ok(calls.length === 1, '只发一次请求')
  ok(lastQuery().get('q') === 'OOM repo:acme/widget', '查询自动补上当前仓库', String(lastQuery().get('q')))
  ok(result.text.includes('自动限定到 acme/widget'), '输出里说明了自动限定')
  ok(result.text.includes('共 2 条命中'), '输出里给出命中总数')
  ok(result.text.includes('issue #7'), 'issue 结果带类型前缀与序号')
  ok(result.text.includes('{bug,P1}'), '标签被折叠展示')
  ok(result.text.includes('💬3'), '评论数被展示')
  ok(result.text.includes('PR  #9 [merged]'), 'PR 结果识别出 merged 状态')
  ok(result.text.includes('以上是全部 2 条结果'), '一页放下时说明这就是全部', result.text.split('\n').slice(-3).join(' / '))
}

console.log('\n== 显式限定词优先于自动限定')
{
  calls.length = 0
  await runTool('github-search', { query: 'user:octocat is:open', kind: 'issues' })
  ok(lastQuery().get('q') === 'user:octocat is:open', '已有限定词时不加 repo', String(lastQuery().get('q')))
}

console.log('\n== @me 展开与 type: 别名')
{
  calls.length = 0
  nextResponse = { status: 200, body: { total_count: 0, items: [] } }
  const r1 = await runTool('github-search', { query: 'author:@me type:pr', kind: 'issues' })
  ok(lastQuery().get('q').includes('author:octocat'), '@me 展开成登录名', String(lastQuery().get('q')))
  ok(lastQuery().get('q').includes('is:pr'), 'type:pr 归一成 is:pr', String(lastQuery().get('q')))
  ok(r1.text.includes('@me → octocat'), '输出里说明了 @me 的展开')
  ok(r1.text.includes('没有命中'), '0 命中时给出提示而不是空文本')
  ok(r1.text.includes('关键词为空'), '0 命中的提示里列出常见原因')
}

console.log('\n== days 参数与分页、排序')
{
  calls.length = 0
  nextResponse = { status: 200, body: { total_count: 500, incomplete_results: false, items: [{ number: 1, title: 'x', state: 'open', labels: [], comments: 0, updated_at: '2026-09-30T00:00:00Z', html_url: 'u', user: { login: 'a' }, repository_url: 'https://api.github.com/repos/a/b' }] } }
  const result = await runTool('github-search', { query: 'bug repo:a/b', days: 7, page: 3, limit: 10, sort: 'updated', order: 'desc', kind: 'issues' })
  ok(/updated:>=\d{4}-\d{2}-\d{2}/.test(lastQuery().get('q')), 'days 被翻译成 updated:>=日期', String(lastQuery().get('q')))
  ok(lastQuery().get('page') === '3', 'page 透传')
  ok(lastQuery().get('per_page') === '10', 'limit 透传为 per_page')
  ok(lastQuery().get('sort') === 'updated' && lastQuery().get('order') === 'desc', 'sort/order 透传')
  ok(result.text.includes('第 3 页'), '输出标明页码')
  ok(result.text.includes('page 设为 4'), '输出给出翻页指引')
  ok(result.text.includes('github-issues action=get'), 'issues 结果给出下一步建议')
}

console.log('\n== 90 秒缓存（同一查询不重复打 API）')
{
  calls.length = 0
  await runTool('github-search', { query: 'cache-me repo:a/b', kind: 'issues', limit: 5 })
  const afterFirst = calls.length
  await runTool('github-search', { query: 'cache-me repo:a/b', kind: 'issues', limit: 5 })
  ok(afterFirst === 1 && calls.length === 1, '相同查询第二次命中缓存', `第一次 ${String(afterFirst)} 次，两次共 ${String(calls.length)} 次`)
  await runTool('github-search', { query: 'cache-me repo:a/b', kind: 'issues', limit: 6 })
  ok(calls.length === 2, '参数不同则不吃缓存', String(calls.length))
}

console.log('\n== 422 与限流的错误翻译')
{
  calls.length = 0
  nextResponse = { status: 422, body: { message: 'Validation Failed', errors: [{ message: 'is:merged and is:open are mutually exclusive' }] } }
  const invalid = await runTool('github-search', { query: 'is:merged is:open repo:a/b', kind: 'issues' })
  ok(invalid.text.includes('Validation Failed'), '422 原话被保留', invalid.text.split('\n')[0])
  ok(invalid.text.includes('422 通常是查询语法问题'), '422 给出语法排查建议')
  ok(invalid.text.includes('查询：'), '422 回显实际发出的查询')

  calls.length = 0
  nextResponse = { status: 403, body: { message: 'You have exceeded a secondary rate limit' } }
  const limited = await runTool('github-search', { query: 'limit repo:a/b', kind: 'issues' })
  ok(limited.text.includes('30 次/分钟'), '限流时说明搜索接口的独立限制')
}

console.log('\n== 结果不完整标记')
{
  calls.length = 0
  nextResponse = { status: 200, body: { total_count: 1, incomplete_results: true, items: [{ number: 1, title: 'x', state: 'open', labels: [], comments: 0, updated_at: '2026-09-30T00:00:00Z', html_url: 'u', user: { login: 'a' }, repository_url: 'https://api.github.com/repos/a/b' }] } }
  const result = await runTool('github-search', { query: 'incomplete repo:a/b', kind: 'issues' })
  ok(result.text.includes('结果不完整'), 'incomplete_results 被明确标注')
}

console.log('\n== repositories / commits 渲染')
{
  calls.length = 0
  nextResponse = { status: 200, body: { total_count: 1, items: [{ full_name: 'acme/widget', stargazers_count: 12, forks_count: 3, language: 'TypeScript', archived: false, fork: false, description: '一个控件库', html_url: 'https://github.com/acme/widget', pushed_at: '2026-09-30T00:00:00Z' }] } }
  const repos = await runTool('github-search', { query: 'widget', kind: 'repositories' })
  ok(repos.text.includes('★12'), '仓库结果展示星标')
  ok(repos.text.includes('TypeScript'), '仓库结果展示语言')
  ok(lastQuery().get('q') === 'widget', 'repositories 不做仓库自动限定', String(lastQuery().get('q')))

  calls.length = 0
  nextResponse = { status: 200, body: { total_count: 1, items: [{ sha: 'abcdef1234567890', commit: { message: 'fix: 修复崩溃\n\n详情', author: { name: 'Dev', date: '2026-09-30T00:00:00Z' } }, author: { login: 'dev' }, html_url: 'https://github.com/acme/widget/commit/abcdef1', repository: { full_name: 'acme/widget' } }] } }
  const commits = await runTool('github-search', { query: 'crash', kind: 'commits' })
  ok(commits.text.includes('abcdef12'), '提交结果展示短 sha')
  ok(commits.text.includes('fix: 修复崩溃'), '提交结果只取首行消息')
  ok(!commits.text.includes('详情'), '多行消息不整段塞进结果')
}

console.log(`\n结果：${String(passed)} 通过，${String(failed)} 失败`)
process.chdir(tmpdir())
rmSync(home, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
