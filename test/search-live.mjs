/**
 * 联网冒烟：用真实 GitHub API 跑一次搜索，并审计实际发出的请求。
 *
 * 与 search-unit 的分工：那边全离线（stub fetch 断言行为），这边**真的发请求**，
 * 用来回答「改完之后真实搜索还出得来结果吗」——尤其是输出里那句「以上是全部 N 条
 * 结果」到底对不对。审计靠包一层 fetch：只观察 URL，不改写响应。
 *
 * 需要已登录（`$DSH_HOME/github.json` 或环境变量 GITHUB_TOKEN）。没登录时跳过并退出 0，
 * 这样放进测试套件也不会因为环境不同而变红。
 *
 * 运行：node test/search-live.mjs
 *
 * @module @ptfm/dsh-github/test/search-live
 */

import { readToken, statusOf } from '../lib/store.mjs'

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

const { token, source } = readToken()
if (token === '') {
  console.log('跳过：本机还没有登录 GitHub（未找到 token）。')
  process.exit(0)
}
console.log(`使用 ${source === 'env' ? '环境变量' : '凭据文件'}里的 token，登录名记录为 ${statusOf().login || '(未记录)'}\n`)

/** 审计到的请求 URL。 */
const seen = []
const realFetch = globalThis.fetch
globalThis.fetch = async (url, init) => {
  seen.push(String(url))
  return await realFetch(url, init)
}

const { runTool } = await import('../lib/tools.mjs')

console.log('== 真实搜索：公开仓库里的 issue')
const issues = await runTool('github-search', {
  query: 'repo:octocat/Hello-World is:issue state:open',
  kind: 'issues',
  limit: 3,
  sort: 'updated',
})
console.log(issues.text.split('\n').slice(0, 4).join('\n'))
ok(seen.length === 1, '恰好发出一次请求', `实际 ${String(seen.length)} 次`)
ok(seen[0].startsWith('https://api.github.com/search/issues?'), '打到搜索 issue 端点', seen[0])
const firstUrl = new URL(seen[0])
ok(firstUrl.searchParams.get('q') === 'repo:octocat/Hello-World is:issue state:open', '查询原样送达', String(firstUrl.searchParams.get('q')))
ok(firstUrl.searchParams.get('per_page') === '3', 'per_page 透传')
ok(!firstUrl.href.includes(token), 'token 不出现在 URL 里（防泄漏）')
ok(/共 \d+ 条命中/.test(issues.text), '输出里有命中总数', issues.text.split('\n')[0])
ok(issues.text.includes('octocat/Hello-World'), '输出里有仓库名')
ok(/以上是全部|还有更多结果/.test(issues.text), '给出明确的分页/收尾说明')

console.log('\n== 缓存：同一查询第二次不再打 API')
const before = seen.length
await runTool('github-search', { query: 'repo:octocat/Hello-World is:issue state:open', kind: 'issues', limit: 3, sort: 'updated' })
ok(seen.length === before, '第二次命中 90 秒缓存', `请求数 ${String(seen.length)}`)

console.log('\n== 真实搜索：仓库')
const repos = await runTool('github-search', { query: 'topic:dsh-plugin', kind: 'repositories', limit: 3 })
ok(seen.length === before + 1, '仓库搜索发出一次请求')
ok(/共 \d+ 条命中/.test(repos.text), '仓库搜索有命中总数')
console.log(repos.text.split('\n').slice(0, 3).join('\n'))

console.log('\n== 真实搜索：错误路径（不存在的仓库限定）')
const empty = await runTool('github-search', { query: 'zzz-nothing-here-31415926 repo:definitely/not-a-real-repo-31415926', kind: 'issues', limit: 3 })
ok(/0 条命中|没有命中|失败/.test(empty.text), '无结果或失败都有明确说明')
console.log(empty.text.split('\n').slice(0, 3).join('\n'))

console.log(`\n结果：${String(passed)} 通过，${String(failed)} 失败`)
process.exit(failed === 0 ? 0 : 1)
