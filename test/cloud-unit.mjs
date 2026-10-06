/**
 * `github-cloud` 的离线行为测试。
 *
 * 这个工具的特点是「失败路径比成功路径更常见」——Codespaces / Packages / Models 都
 * 需要独立的 token scope，用户手上往往没有。所以测试重点不是「能列出多少台机器」，
 * 而是**403/404 时必须给出「缺哪个 scope、去哪儿补」**，而不是一句干巴巴的失败。
 *
 * 全程 stub `globalThis.fetch`，不发真实请求。
 *
 * 运行：node test/cloud-unit.mjs
 *
 * @module @ptfm/dsh-github/test/cloud-unit
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

const home = mkdtempSync(join(tmpdir(), 'dsh-github-cloud-'))
process.env.DSH_HOME = home
delete process.env.GITHUB_TOKEN
delete process.env.DSH_GITHUB_TOKEN
writeFileSync(join(home, 'github.json'), JSON.stringify({
  token: 'ghp_cloudtest0000000000000000000000000000',
  tokenKind: 'pat',
  login: 'octocat',
  scopes: ['repo', 'workflow'],
  defaultRepo: 'acme/widget',
}), 'utf8')

const { runTool } = await import('../lib/tools.mjs')
const { githubFetch } = await import('../lib/rest.mjs')

/** 审计到的请求。 */
const calls = []
/** 按 URL 片段决定响应。 */
let routes = []

globalThis.fetch = async (url, init = {}) => {
  const href = String(url)
  calls.push({ url: href, method: String(init.method ?? 'GET') })
  const match = routes.find((route) => href.includes(route.match))
  const spec = match ?? { status: 404, body: { message: 'Not Found' } }
  // 204/304 这类状态不允许带 body，Response 会直接拒绝构造——必须传 null。
  const body = spec.body === '' || spec.status === 204 || spec.status === 304
    ? null
    : JSON.stringify(spec.body)
  return new Response(body, {
    status: spec.status,
    headers: {
      'content-type': 'application/json',
      'x-ratelimit-remaining': '4990',
      'x-ratelimit-limit': '5000',
      'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
      'x-oauth-scopes': 'repo, workflow',
    },
  })
}

console.log('== 未知 action 给出用法清单')
{
  const result = await runTool('github-cloud', { action: 'nope' })
  ok(result.text.includes('未知 action'), '拒绝未知 action')
  ok(result.text.includes('codespaces'), '列出可用 action')
  ok(result.text.includes('计费') || result.text.includes('models'), '用法清单足够完整')
}

console.log('\n== Codespaces：端点正确性与 403 指引')
{
  calls.length = 0
  routes = [{ match: '/user/codespaces', status: 200, body: { codespaces: [], total_count: 0 } }]
  const empty = await runTool('github-cloud', { action: 'codespaces' })
  ok(calls[0].url === 'https://api.github.com/user/codespaces?per_page=30', '打的是 /user/codespaces（不是 /users/{login}/…）', calls[0].url)
  ok(empty.text.includes('名下没有 Codespaces'), '空列表也有明确说明')
  ok(empty.text.includes('action=machines'), '给出下一步动作')

  calls.length = 0
  routes = [{ match: '/codespaces', status: 403, body: { message: 'You must have the codespace scope' } }]
  const result = await runTool('github-cloud', { action: 'codespaces' })
  ok(result.text.includes('403'), '保留原始状态码')
  ok(result.text.includes('codespace'), '点明需要 codespace scope')
  ok(result.text.includes('settings/tokens'), '给出补权限的链接')
  ok(result.text.includes('action=machines'), '给出「现在就能用」的替代动作')
  ok(calls.length === 1, '只请求一次')
}

console.log('\n== Codespaces 机型：现有 scope 即可读')
{
  calls.length = 0
  routes = [{
    match: '/codespaces/machines',
    status: 200,
    body: {
      // 真实响应没有 default_machine 字段，只有 machines / total_count。
      total_count: 2,
      machines: [
        { name: 'basicLinux32gb', display_name: '2 cores, 8 GB RAM, 32 GB storage', cpus: 2, memory_in_bytes: 8589934592, storage_in_bytes: 34359738368, operating_system: 'linux' },
        { name: 'standardLinux32gb', display_name: '4 cores, 16 GB RAM, 32 GB storage', cpus: 4, memory_in_bytes: 17179869184, storage_in_bytes: 34359738368, operating_system: 'linux' },
      ],
    },
  }]
  const result = await runTool('github-cloud', { action: 'machines' })
  ok(result.text.includes('standardLinux32gb'), '列出机型名')
  ok(result.text.includes('4 cores, 16 GB RAM, 32 GB storage'), '展示官方 display_name（不再重复输出 name）', result.text.split('\n')[1])
  ok(result.text.includes('4 vCPU'), '换算 CPU 数')
  ok(result.text.includes('16 GB'), '换算内存')
  ok(result.text.includes('32 GB'), '换算存储')
  ok(result.text.includes('默认 basicLinux32gb'), '默认机型取列表第一项（接口没有 default_machine）')
  ok(result.text.includes('系统 linux'), '展示操作系统')
  ok(result.text.includes('计费提示'), '给出计费提醒')
  ok(calls[0].url.includes('/repos/acme/widget/codespaces/machines'), '打到正确端点（用默认仓库）', calls[0].url)
}

console.log('\n== 创建 Codespace：403 时强调计费与 scope')
{
  calls.length = 0
  // create 之前会先做一次预检（GET /user/codespaces），所以不能假设 calls[0] 就是创建请求。
  routes = [
    { match: '/user/codespaces', status: 200, body: { codespaces: [], total_count: 0 } },
    { match: '/codespaces', status: 403, body: { message: 'Codespaces is not enabled' } },
  ]
  const result = await runTool('github-cloud', { action: 'create', repo: 'acme/widget', machine: 'standardLinux32gb' })
  ok(result.text.includes('codespace'), '提示 scope')
  ok(result.text.includes('计费'), '提示会开始计费')
  const create = calls.find((call) => call.method === 'POST' && call.url.endsWith('/codespaces'))
  ok(create !== undefined, '用 POST 创建', calls.map((call) => `${call.method} ${call.url}`).join(' | '))
  ok(calls[0].url.includes('/user/codespaces'), '创建前先做预检（GET 现有环境）', calls[0].url)

  // 成功路径：预检内容与「会自动停机」的说明都要出现在回执里。
  calls.length = 0
  routes = [
    { match: '/user/codespaces', status: 200, body: { total_count: 1, codespaces: [{ name: 'burning', state: 'Available', created_at: new Date(Date.now() - 2 * 3600000).toISOString(), last_used_at: new Date(Date.now() - 2 * 3600000).toISOString(), machine: { name: 'standardLinux32gb' } }] } },
    { match: '/codespaces', status: 201, body: { name: 'new-one', state: 'Starting', machine: { name: 'standardLinux32gb' }, idle_timeout_minutes: 15 } },
  ]
  const created = await runTool('github-cloud', { action: 'create', repo: 'acme/widget' })
  ok(created.text.includes('预检'), '成功回执里带预检', created.text.split('\n')[0])
  ok(created.text.includes('burning'), '预检点名正在烧钱的机器')
  ok(created.text.includes('空闲自动停止：15 分钟'), '回执说明会自动停机')
}

console.log('\n== start/stop/delete 需要 name')
{
  calls.length = 0
  const missing = await runTool('github-cloud', { action: 'stop' })
  ok(missing.text.includes('需要参数 name'), '缺 name 时明确报错')
  ok(calls.length === 0, '缺参数不发请求')

  routes = [{ match: '/user/codespaces/abc/stop', status: 200, body: { state: 'ShuttingDown' } }]
  const stopped = await runTool('github-cloud', { action: 'stop', name: 'abc' })
  ok(stopped.text.includes('正在停止'), '停止成功有反馈')
  const stopCall = calls.find((call) => call.url.includes('/user/codespaces/abc/stop'))
  ok(stopCall !== undefined, '打到正确端点', calls.map((call) => call.url).join(' | '))
  ok(stopCall?.method === 'POST', 'stop 用 POST', String(stopCall?.method))

  routes = [{ match: '/user/codespaces/abc', status: 204, body: '' }]
  const deleted = await runTool('github-cloud', { action: 'delete', name: 'abc' })
  ok(deleted.text.includes('已删除'), '删除有反馈（真实 DELETE 返回 204 空 body）', deleted.text)
  ok(calls.some((call) => call.method === 'DELETE'), 'delete 用 DELETE 方法')
}

console.log('\n== Pages：未启用时的 404 要解释清楚')
{
  calls.length = 0
  routes = [{ match: '/pages', status: 404, body: { message: 'Not Found' } }]
  const result = await runTool('github-cloud', { action: 'pages' })
  ok(result.text.includes('没有启用 GitHub Pages'), '404 解释成「未启用」')
  ok(result.text.includes('gh-pages'), '给出启用方式')
  ok(result.text.includes('action=pages'), '给出后续动作')

  routes = [{ match: '/pages/builds', status: 200, body: [{ status: 'built', created_at: '2026-09-30T10:00:00Z', commit: 'abcdef1234567890' }] },
    { match: '/pages', status: 200, body: { html_url: 'https://acme.github.io/widget/', status: 'built', build_type: 'workflow', https_enforced: true } }]
  const live = await runTool('github-cloud', { action: 'pages' })
  ok(live.text.includes('https://acme.github.io/widget/'), '展示站点 URL')
  ok(live.text.includes('强制 HTTPS：是'), '展示 HTTPS 状态')
  ok(live.text.includes('最近部署'), '展示部署记录')
}

console.log('\n== Packages：404 时给出 ghcr.io 发布指引')
{
  calls.length = 0
  routes = [{ match: '/packages', status: 404, body: { message: 'Not Found' } }]
  const result = await runTool('github-cloud', { action: 'packages' })
  ok(result.text.includes('404'), '保留状态码')
  ok(result.text.includes('ghcr.io'), '给出 ghcr.io')
  ok(result.text.includes('docker login ghcr.io'), '给出登录命令')
  ok(result.text.includes('DSH_GITHUB_TOKEN'), '说明可以直接用注入的 token 登录')
  ok(result.text.includes('read:packages'), '提示 scope')

  // 仓库维度的 packages 端点只在传了 repo 时才用，这里显式传一个，验证端点形状。
  routes = [{ match: '/repos/acme/widget/packages', status: 200, body: [{ name: 'widget', package_type: 'container', visibility: 'public', version_count: 3, html_url: 'https://github.com/users/octocat/packages/container/widget' }] }]
  const list = await runTool('github-cloud', { action: 'packages', repo: 'acme/widget', packageType: 'container' })
  ok(calls.some((call) => call.url.includes('/repos/acme/widget/packages')), '指定 repo 时用仓库维度的端点', calls.map((call) => call.url).join(' | '))
  ok(list.text.includes('widget'), '列出包名')
  ok(list.text.includes('3 个版本'), '展示版本数', list.text.split('\n')[0])
}

console.log('\n== Runners：仓库级与组织级都读，并解释 GitHub 托管 runner 不在其中')
{
  calls.length = 0
  routes = [
    { match: '/orgs/acme/actions/runners', status: 200, body: { runners: [{ name: 'org-runner-1', status: 'online', busy: false }] } },
    { match: '/actions/runners', status: 200, body: { runners: [{ name: 'self-hosted-1', status: 'online', busy: true, labels: [{ name: 'linux' }, { name: 'x64' }] }] } },
  ]
  const result = await runTool('github-cloud', { action: 'runners' })
  ok(result.text.includes('self-hosted-1'), '列出仓库级运行器')
  ok(result.text.includes('忙碌'), '展示忙闲状态')
  ok(result.text.includes('linux,x64'), '展示标签')
  ok(result.text.includes('org-runner-1'), '列出组织级运行器')
  ok(result.text.includes('GitHub 托管的 runner'), '解释托管 runner 不在此列')
}

console.log('\n== Quota：Actions 配置（两个端点合并）')
{
  calls.length = 0
  routes = [
    { match: '/actions/permissions/workflow', status: 200, body: { default_workflow_permissions: 'read', can_approve_pull_request_reviews: false } },
    { match: '/actions/permissions', status: 200, body: { enabled: true, allowed_actions: 'all', sha_pinning_required: true } },
    { match: '/actions/runners', status: 200, body: { total_count: 0 } },
  ]
  const result = await runTool('github-cloud', { action: 'quota' })
  ok(result.text.includes('启用：是'), '展示是否启用')
  ok(result.text.includes('默认工作流权限：read'), '从 /permissions/workflow 取默认权限', result.text)
  ok(result.text.includes('PR 可批准 fork 的工作流：否'), '取到 PR 批准开关')
  ok(result.text.includes('要求 SHA 固定：是'), '展示 SHA 固定要求')
  ok(result.text.includes('自托管运行器数量：0'), '展示运行器数量')
  ok(result.text.includes('免费'), '说明计费口径')
  ok(calls.some((call) => call.url.includes('/actions/permissions/workflow')), '确实打了 workflow 子端点')

  routes = [
    { match: '/actions/permissions/workflow', status: 200, body: {} },
    { match: '/actions/permissions', status: 200, body: { enabled: false } },
    { match: '/actions/runners', status: 200, body: { total_count: 0 } },
  ]
  const disabled = await runTool('github-cloud', { action: 'quota' })
  ok(disabled.text.includes('Actions 当前被禁用'), '禁用时给出开启方式')
}

console.log('\n== Models：空目录说明是缺 models:read')
{
  calls.length = 0
  routes = [{ match: 'models.github.ai/catalog/models', status: 200, body: [] }]
  const result = await runTool('github-cloud', { action: 'models' })
  ok(result.text.includes('models:read'), '点明缺 models:read')
  ok(calls[0].url.startsWith('https://models.github.ai/'), '打到 models 域而不是 api.github.com', calls[0].url)

  routes = [{ match: 'models.github.ai/catalog/models', status: 200, body: [{ id: 'openai/gpt-4o-mini', publisher: 'openai', summary: '小模型' }] }]
  const list = await runTool('github-cloud', { action: 'models' })
  ok(list.text.includes('openai/gpt-4o-mini'), '有权限时列出模型')
  ok(list.text.includes('models.github.ai/inference'), '给出推理端点', list.text.split('\n').slice(-2).join(' / '))
}

console.log('\n== 空 body 的成功响应（DELETE 常返回 204）')
{
  routes = [{ match: '/user/codespaces/abc', status: 204, body: '' }]
  const direct = await githubFetch('token', '/user/codespaces/abc', { method: 'DELETE' })
  ok(direct.ok === true, '204 空 body 视为成功而不是解析失败', JSON.stringify(direct).slice(0, 120))
  ok(direct.status === 204, '保留状态码 204')
  ok(direct.data === undefined, '空 body 解析为 undefined')
}

console.log('\n== fine-grained token 的 scope 提示走另一条文案')
{
  calls.length = 0
  writeFileSync(join(home, 'github.json'), JSON.stringify({
    token: 'github_pat_cloudtest0000000000000000000000',
    tokenKind: 'pat',
    login: 'octocat',
    scopes: [],
    defaultRepo: 'acme/widget',
  }), 'utf8')
  routes = [{ match: '/codespaces', status: 403, body: { message: 'You must have the codespace scope' } }]
  const result = await runTool('github-cloud', { action: 'codespaces' })
  ok(result.text.includes('fine-grained'), '识别 fine-grained token')
  ok(result.text.includes('personal-access-tokens'), '给出 fine-grained 的编辑入口')
}

console.log(`\n结果：${String(passed)} 通过，${String(failed)} 失败`)
rmSync(home, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
