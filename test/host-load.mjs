/**
 * 宿主半边的离线加载测试：用一个最小 Cordis 替身真实调用 `apply(ctx, config)`，
 * 断言路由、工具、shell 环境变量都被注册，且**任何地方都不会把 token 写进日志或
 * 响应**。
 *
 * 这不是单元测试的替代品，而是「插件能不能在真实 DSH 组合里挂上去」的护栏：
 * 插件里最容易出错的地方是服务形状（`ctx.get` 的名字、`register` 的参数、
 * `ctx.effect` 的返回值），这些都只有在真正调用一次时才会暴露。
 *
 * 运行：
 *   node test/host-load.mjs
 *
 * @module @ptfm/dsh-github/test/host-load
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TOOL_TABLE } from '../lib/tools.mjs'
import { deleteStoreFile } from '../lib/store.mjs'

/** 断言计数。 */
let passed = 0
/** 失败计数。 */
let failed = 0

/**
 * 断言一个条件。
 * @param {boolean} condition
 * @param {string} label
 */
function ok(condition, label) {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${label}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label}`)
  }
}

/**
 * 把「未声明 inject 时直接读 ctx.<service>」变成硬错误。
 *
 * 真实的 Cordis ctx 是个代理：没在 `inject` 里声明过的服务，属性读取会抛
 * 「cannot get property "X" without inject」。而它的报错文案用的是外层代理的 target，
 * 属性名可能是上一次非法访问的残留——真凶和报错里的名字可能不一致。这条 mock 让
 * 同样的错误在离线测试里就能炸出来，而且报错点名的是真正被读的那个属性。
 */
function guardedCtx(inner) {
  const declared = new Set(mod.inject ?? [])
  const services = ['connection', 'tools', 'shellEnv', 'logger', 'credentials', 'llm', 'settings']
  return new Proxy(inner, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && services.includes(prop) && !declared.has(prop) && !Object.hasOwn(target, prop)) {
        throw new Error(`cannot get property "${prop}" without inject（请改用 ctx.get('${prop}') 并在 inject 里声明）`)
      }
      return Reflect.get(target, prop, receiver)
    },
  })
}

/**
 * 先把存储指到临时目录，避免碰到真实登录态。
 *
 * 还要显式清掉 `GITHUB_TOKEN` / `DSH_GITHUB_TOKEN`：`readToken()` 让环境变量优先于
 * 落盘值，如果这台机器上刚好有真实 token，测试就会「以已登录身份」运行，从而
 * 测不到未登录分支（这个坑真的踩过一次）。
 */
const home = mkdtempSync(join(tmpdir(), 'dsh-github-hostload-'))
process.env.DSH_HOME = home
delete process.env.GITHUB_TOKEN
delete process.env.DSH_GITHUB_TOKEN
// 双保险：确认临时 home 里没有凭据文件。
deleteStoreFile()
console.log(`临时 DSH_HOME：${home}（环境变量已清空，凭据文件已确保不存在）\n`)

/** 记录注册进 ctx.effect 的清理函数，用于验证卸载路径。 */
const disposers = []
/** 收集注册的路由。 */
const routes = []
/** 收集注册的工具。 */
const tools = []
/** 收集 shell 环境贡献者。 */
const envContributors = []
/** 收集日志。 */
const logs = []

const ctx = {
  logger: {
    info: (message) => logs.push(`info: ${message}`),
    warn: (message) => logs.push(`warn: ${message}`),
    error: (message) => logs.push(`error: ${message}`),
  },
  connection: {
    fetch: {
      register: (route) => {
        routes.push(route)
        return () => {}
      },
    },
  },
  tools: {
    register: (definition) => {
      tools.push(definition)
      return () => {}
    },
  },
  shellEnv: {
    register: (contributor) => {
      envContributors.push(contributor)
      return () => {}
    },
  },
  get(name) {
    if (name === 'tools') return ctx.tools
    if (name === 'shellEnv') return ctx.shellEnv
    if (name === 'connection') return ctx.connection
    if (name === 'logger') return ctx.logger
    return undefined
  },
  effect(factory, label) {
    disposers.push({ label, dispose: factory() })
    return () => {}
  },
}

console.log('== 模块加载与 apply 调用')
const mod = await import('../lib/index.js')
ok(typeof mod.apply === 'function', '导出 apply 函数')
ok(mod.name === 'github', '导出插件名 github')
ok(mod.inject === undefined || Array.isArray(mod.inject), 'inject 形态合法（数组或未声明）')
ok(Array.isArray(mod.inject) && mod.inject.includes('connection'), 'inject 声明了 connection（isolate 边界要求）')
ok(Array.isArray(mod.inject) && mod.inject.includes('tools'), 'inject 声明了 tools')
ok(Array.isArray(mod.inject) && mod.inject.includes('shellEnv'), 'inject 声明了 shellEnv')

let applyError
try {
  mod.apply(guardedCtx(ctx), { defaultRepo: 'octocat/Hello-World' })
} catch (error) {
  applyError = error
}
ok(applyError === undefined, `apply 正常返回${applyError === undefined ? '' : `（实际抛错：${String(applyError?.message)}）`}`)

console.log('\n== 路由注册')
ok(routes.length === 1, `只注册 1 条精确路由（实际 ${String(routes.length)}）`)
ok(routes.some((route) => route.path === '/api/github'), '路由为 /api/github')
ok(routes.every((route) => typeof route.fetch === 'function'), '路由带 fetch 处理函数')
ok(routes.every((route) => route.requestBody === 'buffered'), '路由声明 requestBody=buffered')
ok(routes.every((route) => route.methods.every((method) => ['GET', 'HEAD', 'POST'].includes(method))), 'methods 只使用 connection 支持的 GET/HEAD/POST')
ok(routes.every((route) => !route.path.endsWith('/')), '路由没有尾斜杠（会被 assertFetchRoute 拒绝）')

console.log('\n== agent 工具注册')
const names = tools.map((tool) => tool.name)
// 数量必须与工具表一致，但不断言某个魔数——新增工具时这条仍然成立。
ok(tools.length === TOOL_TABLE.length, `注册的工具数与工具表一致（表 ${String(TOOL_TABLE.length)}，注册 ${String(tools.length)}）`)
for (const expected of TOOL_TABLE.map((entry) => entry.name)) {
  ok(names.includes(expected), `工具 ${expected}`)
}
ok(tools.every((tool) => typeof tool.description === 'string' && tool.description.length > 10), '每个工具都有描述')
ok(tools.every((tool) => typeof tool.execute === 'function'), '每个工具都有 execute')
ok(tools.every((tool) => tool.output?.schema?.type === 'object' && typeof tool.output?.render === 'function'), '每个工具都有 output.schema 与 output.render')

// parameters 必须是原生 JSON Schema：DSH 会把它原样交给模型，不做 DSL 编译。
ok(tools.every((tool) => tool.parameters?.type === 'object'), '每个工具的 parameters 都是 JSON Schema 对象节点')
ok(tools.every((tool) => tool.parameters?.properties !== undefined), '每个工具都声明了 properties')
ok(tools.every((tool) => tool.parameters?.required === undefined || Array.isArray(tool.parameters.required)), 'required 是顶层数组（不是每个参数上的布尔）')
ok(tools.every((tool) => Object.values(tool.parameters.properties).every((node) => typeof node.type === 'string' && node.required === undefined)), '参数节点只带 type/description/enum 等合法关键字')
const apiParams = tools.find((tool) => tool.name === 'github-api')?.parameters
ok(Array.isArray(apiParams?.required) && apiParams.required.includes('path'), 'github-api 的 path 在 required 数组里')
const searchParams = tools.find((tool) => tool.name === 'github-search')?.parameters
ok(Array.isArray(searchParams?.required) && searchParams.required.includes('query'), 'github-search 的 query 在 required 数组里')
const issuesParams = tools.find((tool) => tool.name === 'github-issues')?.parameters
ok(issuesParams?.properties?.action?.enum !== undefined, 'github-issues 的 action 带 enum')
ok(Array.isArray(issuesParams?.required) === false, '没有必填参数的工具不写 required 字段')

console.log('\n== shell 环境变量')
ok(envContributors.length === 1, '注册了 1 个 shellEnv 贡献者')
const contributor = envContributors[0]
ok(contributor?.name === 'github-token', '贡献者名为 github-token')
ok(contributor?.variables?.DSH_GITHUB_TOKEN !== undefined, '声明了 DSH_GITHUB_TOKEN')
ok(typeof contributor?.variables?.DSH_GITHUB_TOKEN?.description === 'string', 'DSH_GITHUB_TOKEN 带 description')
ok(JSON.stringify(contributor?.resolve({})) === '{}', '未登录时 resolve 返回空对象（不注入空 token）')

console.log('\n== effect 清理')
ok(disposers.length === TOOL_TABLE.length + 2, `effect 数量 = 1 条路由 + 工具数 + 1 个环境变量（期望 ${String(TOOL_TABLE.length + 2)}，实际 ${String(disposers.length)}）`)

console.log('\n== 工具执行（未登录路径，不触网）')
const statusTool = tools.find((tool) => tool.name === 'github-status')
const statusResult = await statusTool.execute({}, {})
ok(typeof statusResult?.text === 'string', 'github-status 返回 text')
ok(String(statusResult.text).includes('未登录'), '未登录时明确提示未登录')
ok(String(statusResult.text).includes('设置 → GitHub'), '提示里给出登录入口')

const apiTool = tools.find((tool) => tool.name === 'github-api')
const apiResult = await apiTool.execute({ path: 'https://evil.example.com/x' }, {})
ok(String(apiResult.text).includes('相对路径'), 'github-api 拒绝绝对 URL（防 SSRF）')
const apiResult2 = await apiTool.execute({ path: '/user/../../etc' }, {})
ok(String(apiResult2.text).includes('..'), 'github-api 拒绝包含 .. 的路径')

console.log('\n== 日志不含敏感内容')
const joined = logs.join('\n')
ok(!/ghp_|github_pat_/.test(joined), '日志里没有 token 形态的字符串')
ok(joined.includes('已挂载 /api/github'), '启动日志说明已挂载路由')

console.log(`\n结果：${String(passed)} 通过，${String(failed)} 失败`)
rmSync(home, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
