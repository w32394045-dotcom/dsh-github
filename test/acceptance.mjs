/**
 * 端到端验收：在**真实 DSH 宿主进程内**驱动插件，用真账号拉一次 GitHub 数据。
 *
 * 这是唯一能覆盖「设置页 → 宿主路由 → 凭据落盘 → agent 真实调用 GitHub API」
 * 整条链路的验收方式：脚本以插件身份加载，通过 `connection.createSharedFetchHandler('/api')`
 * 调用 `/api/github`（与浏览器设置页走同一个处理器，只是绕过了 web 服务器的信任栅栏），
 * 再用 `ctx.tools.get(name).execute(...)` 走 agent 真正会走的那条工具执行路径。
 *
 * 用法（作为独立条目挂进 profile，宿主启动时自动跑一次）：
 *   # 可选：把 PAT 写进 $DSH_HOME/.github-accept-token 即会「登录 + 验收」，
 *   #      不写则只验收已存在的登录态。文件用毕删除。
 *   # 环境变量 DSH_GITHUB_ACCEPT_KEEP=1 可保留登录态，默认验收后退出登录。
 *
 * 结果打印并写入 `$DSH_HOME/github-acceptance.json`。
 *
 * @module @ptfm/dsh-github/test/acceptance
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome, storePath } from '../lib/store.mjs'

/** 插件名（挂载到宿主）。 */
export const name = 'github-acceptance'

/** 需要 connection 与 tools：一个用来打路由，一个用来走真实工具执行路径。 */
export const inject = ['connection', 'tools']

/** 断言记录。 */
const results = []

/**
 * 记一条断言。
 * @param {string} label
 * @param {boolean} ok
 * @param {string} [detail]
 */
function check(label, ok, detail = '') {
  results.push({ label, ok, detail })
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `　→ ${detail}`}`)
}

/**
 * 用共享 fetch 处理器调插件自己的路由（等价于浏览器设置页的请求）。
 * @param {{ fetch: (request: Request) => Promise<Response> }} shared
 * @param {'GET'|'POST'} method
 * @param {object} [body]
 * @returns {Promise<any>}
 */
async function callRoute(shared, method, body) {
  const response = await shared.fetch(new Request('http://127.0.0.1/api/github', {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  }))
  return await response.json()
}

/**
 * 读取验收用的临时 token 文件。
 *
 * 故意用文件而不是环境变量或命令行参数：环境变量会被所有子进程继承、命令行会留在
 * shell 历史和进程列表里，而这个脚本在验收结束后会立刻删掉该文件。
 * @returns {string} 空串表示没提供（只验收已存在的登录态）。
 */
function readAcceptToken() {
  try {
    const file = join(dshHome(), '.github-accept-token')
    if (!existsSync(file)) return ''
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '').trim()
  } catch {
    return ''
  }
}

/**
 * 插件主体。
 * @param {object} ctx
 */
export function apply(ctx) {
  const run = async () => {
    const tokenFile = join(dshHome(), '.github-accept-token')
    const token = readAcceptToken()
    const keep = process.env.DSH_GITHUB_ACCEPT_KEEP === '1'
    console.log(`\n=== GitHub 插件端到端验收（${new Date().toISOString()}）`)
    console.log(`    模式：${token === '' ? '仅验收已登录态' : '登录后验收'}${keep ? '（保留登录态）' : ''}`)

    let shared
    try {
      shared = ctx.get('connection').createSharedFetchHandler('/api')
      check('拿到 /api 共享 fetch 处理器', true)
    } catch (error) {
      check('拿到 /api 共享 fetch 处理器', false, String(error?.message ?? error))
      finish()
      return
    }

    let status
    try {
      status = await callRoute(shared, 'GET')
    } catch (error) {
      check('GET /api/github 可达（宿主半边已激活）', false, String(error?.message ?? error))
      finish()
      return
    }
    check('GET /api/github 可达（宿主半边已激活）', status?.ok === true, `ok=${String(status?.ok)}`)
    if (status?.ok !== true) {
      finish()
      return
    }
    check('状态接口声明 8 个工具', Array.isArray(status.tools) && status.tools.length === 8, `tools=${String(status.tools?.length)}`)
    check('状态接口不含明文 token 字段', JSON.stringify(status).includes('"token"') === false)

    /* ---------------------------------------------------------- 1. 登录 */

    if (token !== '') {
      const saved = await callRoute(shared, 'POST', { action: 'saveToken', token })
      check(
        '登录：token 经 GitHub 校验后落盘',
        saved?.ok === true,
        saved?.ok === true ? `login=${String(saved.account?.login)}` : String(saved?.error?.message),
      )
      if (saved?.ok !== true) {
        finish()
        return
      }
      check('登录：记录账号名', typeof saved.account?.login === 'string' && saved.account.login !== '', `login=${String(saved.account?.login)}`)
      check('登录：记录 token 实际 scope', Array.isArray(saved.status?.scopes), `scopes=${JSON.stringify(saved.status?.scopes)}`)
    } else {
      check('已存在登录态（未提供 token）', status.status?.configured === true, `configured=${String(status.status?.configured)}`)
    }

    /* ------------------------------------------------- 2. 凭据落盘与复用 */

    const file = storePath()
    check('凭据文件位于 $DSH_HOME', existsSync(file), file)
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8')
      check('凭据文件里确实写入了 token', /"token"\s*:\s*"[^"]+"/.test(raw))
      check('凭据文件里含账号与 scope', raw.includes('"login"') && raw.includes('"scopes"'))
    }

    const reread = await callRoute(shared, 'GET')
    const login = String(reread?.account?.login ?? '')
    check(
      '复用：重新读取仍是已登录（同一份落盘凭据）',
      reread?.status?.configured === true && reread?.account?.ok === true,
      `configured=${String(reread?.status?.configured)} account=${login}`,
    )
    check('复用：实时校验拿到真实账号', login !== '', `login=${login}`)
    check('复用：token 仅以掩码出现', typeof reread?.status?.preview === 'string' && /…/.test(reread.status.preview), `preview=${String(reread?.status?.preview)}`)
    check('复用：返回 API 速率限制', typeof reread?.account?.rate?.remaining === 'number', `remaining=${String(reread?.account?.rate?.remaining)}`)
    check('复用：权限跟随 token（scope 可枚举）', Array.isArray(reread?.status?.scopes), `scopes=${JSON.stringify(reread?.status?.scopes)}`)

    /* --------------------------------------------- 3. agent 工具真实调用 */

    const tools = ctx.get('tools')
    const schemas = tools.schemas().map((schema) => schema.name)
    const expected = ['github-status', 'github-account', 'github-repo', 'github-issues', 'github-pulls', 'github-actions', 'github-search', 'github-api']
    check('全部 8 个 github-* 工具已注册给 agent', expected.every((toolName) => schemas.includes(toolName)), expected.filter((toolName) => !schemas.includes(toolName)).join(',') || '全部就位')

    /** 走真实工具执行路径并取回文本。 */
    const execTool = async (toolName, args) => {
      const definition = tools.get(toolName)
      if (definition === undefined) return { text: `（工具 ${toolName} 未注册）`, ok: false }
      const value = await definition.execute(args, { signal: AbortSignal.timeout(30_000) })
      return { text: typeof value?.text === 'string' ? value.text : JSON.stringify(value), ok: true }
    }

    const account = await execTool('github-account', {})
    check('agent 工具 github-account 真实返回账号数据', account.ok && account.text.includes(login), account.text.split('\n')[0])

    const repo = await execTool('github-repo', { repo: 'octocat/Hello-World' })
    check('agent 工具 github-repo 读到公开仓库', repo.ok && repo.text.includes('octocat/Hello-World'), repo.text.split('\n')[0])

    const search = await execTool('github-search', { query: 'repo:octocat/Hello-World is:issue', kind: 'issues', limit: 3 })
    check('agent 工具 github-search 命中真实数据', search.ok && /命中/.test(search.text), search.text.split('\n')[0])

    check('工具输出里没有明文 token', token === '' || (!account.text.includes(token) && !repo.text.includes(token) && !search.text.includes(token)))

    /* --------------------------------------------------------- 4. 收尾 */

    if (!keep && token !== '') {
      const out = await callRoute(shared, 'POST', { action: 'logout' })
      check('退出登录：清除本地凭据', out?.ok === true && out?.status?.configured === false)
    }

    // 无论如何都删掉临时 token 文件：它只服务于这一次验收。
    try {
      if (existsSync(tokenFile)) {
        rmSync(tokenFile, { force: true })
        console.log(`    已删除临时 token 文件：${tokenFile}`)
      }
    } catch (error) {
      console.log(`    删除临时 token 文件失败：${String(error?.message ?? error)}`)
    }

    finish()
  }

  /** 汇总并落盘。 */
  const finish = () => {
    const passed = results.filter((item) => item.ok).length
    const failed = results.length - passed
    const report = { at: new Date().toISOString(), passed, failed, results }
    try {
      writeFileSync(join(dshHome(), 'github-acceptance.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    } catch (error) {
      console.log(`  （写入验收报告失败：${String(error?.message ?? error)}）`)
    }
    console.log(`\n验收结果：${String(passed)} 通过，${String(failed)} 失败`)
    console.log(`报告：${join(dshHome(), 'github-acceptance.json')}\n`)
  }

  void run()
}
