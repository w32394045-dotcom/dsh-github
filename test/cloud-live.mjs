/**
 * `github-cloud` 的联网冒烟：用真实 token 逐个跑 action，看哪条能通、哪条给的是 scope 指引。
 *
 * 这个脚本的价值在于**把「权限边界」变成可见的事实**：Codespaces 管理与 Packages 发布
 * 需要额外 scope，用户在真实调用前就能看到自己缺什么、去哪儿补。
 * 未登录时跳过（退出 0），因此放进测试套件不会因环境不同而变红。
 *
 * 运行：node test/cloud-live.mjs
 *
 * @module @ptfm/dsh-github/test/cloud-live
 */

import { readToken, statusOf } from '../lib/store.mjs'

const { token } = readToken()
if (token === '') {
  console.log('跳过：本机还没有登录 GitHub。')
  process.exit(0)
}
const status = statusOf()
console.log(`账号 ${status.login || '(未记录)'}　scope：${status.scopes.length === 0 ? '(未返回，可能是 fine-grained)' : status.scopes.join(', ')}\n`)

const { runTool } = await import('../lib/tools.mjs')

/** 打印一个 action 的结果摘要。 */
async function show(label, args, lines = 4) {
  const result = await runTool('github-cloud', args)
  const head = result.text.split('\n').slice(0, lines)
  console.log(`── ${label}`)
  console.log(head.map((line) => `   ${line}`).join('\n'))
  console.log('')
  return result.text
}

const usesRepo = process.argv.includes('--repo') ? process.argv[process.argv.indexOf('--repo') + 1] : 'w32394045-dotcom/ncm-decrypt'

await show('codespaces（需 codespace scope）', { action: 'codespaces' }, 5)
await show(`machines（${usesRepo}）`, { action: 'machines', repo: usesRepo }, 5)
await show('runners（自托管算力节点）', { action: 'runners', repo: usesRepo }, 6)
await show('quota（Actions 配置）', { action: 'quota', repo: usesRepo }, 6)
await show('pages', { action: 'pages', repo: usesRepo }, 6)
await show('packages（容器/包）', { action: 'packages', repo: usesRepo }, 6)
await show('models（模型推理目录）', { action: 'models' }, 6)

console.log('提示：以上输出即为 agent 真实看到的内容；403/404 的段落会带上「缺哪个 scope、去哪儿补」。')
