/**
 * GitHub 接入 —— 宿主半边。
 *
 * 这是一个零依赖的 DSH 插件：只通过 Cordis 服务工作，不 import 任何
 * `@deepseek-ai/*` 包（profile 插件目录里也解析不到它们），因此不受插件 peer
 * 版本检查影响，也能在 `patchReload: live` 的 profile 里立即生效。
 *
 * 它负责四件事：
 *  1. **凭据**：token 落在 `$DSH_HOME/github.json`（0600、原子写）；环境变量
 *     `GITHUB_TOKEN` / `DSH_GITHUB_TOKEN` 优先级更高，方便临时切换身份。
 *  2. **登录**：手填 PAT、OAuth Device Flow 两条路径，都对 token 做一次真实
 *     `/user` 校验后才落盘，并把 `x-oauth-scopes` 记下来展示给用户。
 *  3. **agent 能力**：在 `ctx.tools` 注册 `github-*` 工具；同一份实现也挂在
 *     `/api/github` 的 `action=tool` 上，供界面/CLI 或已认证的其它客户端复用。
 *  4. **shell 环境**：通过 `ctx.shellEnv` 注入 `DSH_GITHUB_TOKEN`，让 agent 在
 *     shell 里跑 `git` / `curl` / `gh` 时带着登录态，而 token 不进模型上下文。
 *
 * 权限模型：不对 token 做任何二次裁剪。token 背后是什么权限，插件就有什么能力。
 *
 * @module @ptfm/dsh-github
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pollDeviceFlowOnce, startDeviceFlow, DEFAULT_SCOPE } from './device-flow.mjs'
import { whoami } from './rest.mjs'
import { clearToken, dshHome, readToken, statusOf, storePath, writeStore } from './store.mjs'
import { TOOL_TABLE, TOOL_TIMEOUT_MS, runTool, toJsonSchema } from './tools.mjs'

/** 本文件所在目录（`lib/`），用于给设置页算出 CLI 的真实路径。 */
const LIB_DIR = fileURLToPath(new URL('.', import.meta.url))

/**
 * 收集「界面能直接拿去显示」的运行时路径。
 *
 * 设置页里的 CLI 命令不能用写死的绝对路径——那玩意只在作者机器上成立，插件一旦被
 * 别人安装就变成一串误导信息。这里统一从运行时推导，Windows / macOS / Linux 都对。
 *
 * @returns {{ home: string, profileDir: string, nodePath: string, cliPath: string, selfPath: string, platform: string, cliCommand: string }}
 */
function runtimeInfo() {
  const home = dshHome()
  const profileDir = typeof process.env.DSH_PROFILE_DIR === 'string' && process.env.DSH_PROFILE_DIR !== ''
    ? process.env.DSH_PROFILE_DIR
    : join(home, 'profiles', typeof process.env.DSH_PROFILE === 'string' ? process.env.DSH_PROFILE : 'default')
  // 跑 CLI 用哪个可执行文件：
  //   1. 优先用 dsh 自带的 node（如果有）——不依赖用户 PATH 里有没有 node；
  //   2. 退到当前进程的 execPath（Electron 下配合 ELECTRON_RUN_AS_NODE=1 也能跑 ESM）；
  //   3. 最后才是裸 `node`，让 PATH 决定。
  const bundled = join(home, 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', process.platform === 'win32' ? 'node.exe' : 'node')
  const nodePath = existsSync(bundled) ? bundled : process.execPath
  const cliPath = join(LIB_DIR, 'cli.mjs')
  const quote = (value) => (value.includes(' ') ? `"${value}"` : value)
  return {
    home,
    profileDir,
    nodePath,
    cliPath,
    selfPath: LIB_DIR,
    platform: process.platform,
    cliCommand: `${quote(nodePath)} ${quote(cliPath)}`,
  }
}

/** Cordis 插件名。 */
export const name = 'github'

/**
 * 硬依赖的宿主服务：`connection`（HTTP 路由）、`tools`（agent 工具）、
 * `shellEnv`（DSH_GITHUB_TOKEN 注入）。这三个在 dsh-base 里都由核心提供。
 *
 * 声明了就一定要能取到；取用时**一律走 `ctx.get(name)`**，不要写成 `ctx.tools`
 * 这种属性读取：Cordis 的 ctx 代理只把声明过的 inject 装成属性，未声明的属性读取
 * 会直接抛「cannot get property ... without inject」。而且那条报错文案用的是外层
 * 代理的 target，属性名可能是**上一次**非法访问的残留——真凶与文案里的名字未必一致，
 * 排障时以栈里的行号为准。
 */
export const inject = ['connection', 'tools', 'shellEnv']

/** 主路由。路径必须精确：`/api/` 开头、段内只允许 `[A-Za-z0-9_$.-]`、不能有尾斜杠（会被拒）。 */
const ROUTE_PATH = '/api/github'

/** token 校验超时（毫秒）。 */
const VERIFY_TIMEOUT_MS = 20_000

/** 统一的 JSON 响应。 */
function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/** 失败响应。`extra` 里带上 GitHub 的原始错误码，界面据此分支而不是匹配文案。 */
function fail(code, message, status = 400, extra = {}) {
  return json({ ok: false, error: { code, message, ...extra } }, status)
}

/** 读取请求体里的字符串字段。 */
function stringField(body, key) {
  const value = body?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 校验一个 token 是否是活的，并取回身份与 scope。
 * @param {string} token
 * @returns {Promise<{ ok: true, login: string, name: string, scopes: string[] } | { ok: false, status: number, message: string }>}
 */
async function verifyToken(token) {
  const result = await whoami(token, AbortSignal.timeout(VERIFY_TIMEOUT_MS))
  if (result.ok === false) {
    const status = result.status === 0 ? 0 : result.status
    const hint = status === 401
      ? 'token 无效或已被撤销'
      : status === 403
        ? '被 GitHub 拒绝（可能是速率限制）'
        : status === 0
          ? '无法连接 api.github.com，请检查网络或代理'
          : `HTTP ${String(status)}`
    return { ok: false, status, message: `${hint}：${result.error.message}` }
  }
  return { ok: true, login: result.login, name: result.name, scopes: result.scopes }
}

/**
 * 插件主体。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ defaultRepo?: string, requestTimeoutMs?: number }} [config]
 */
export function apply(ctx, config) {
  const settings = config !== null && typeof config === 'object' ? config : {}

  /**
   * 日志是可选增强：一句日志不该让整块插件加载失败，所以整体包一层。
   * `logger` 故意不写进 `inject`，取不到就静默。
   */
  const log = (level, message) => {
    try {
      ctx.get('logger')?.[level]?.(message)
    } catch {
      // 没有日志服务时静默。
    }
  }

  // 首次运行时把 profile 里的默认仓库带进存储（不覆盖用户已填的值）。
  if (typeof settings.defaultRepo === 'string' && settings.defaultRepo.trim() !== '' && statusOf().defaultRepo === '') {
    try {
      writeStore({ defaultRepo: settings.defaultRepo.trim() })
    } catch (error) {
      log('warn', `github: 写入默认仓库失败：${String(error?.message ?? error)}`)
    }
  }

  /** 正在进行中的设备流授权（同一时刻只允许一个）。 */
  let attempt = undefined

  /* ------------------------------------------------------------ 路由处理 */

  /**
   * 组装界面需要的状态快照（永不包含明文 token）。
   *
   * `verify` 控制是否额外打一次 GitHub `/user`：写操作（保存 token、退出登录、
   * 保存配置）刚刚才校验过、或本来就不需要校验，再打一次纯属浪费速率限制——而
   * 5000 次/小时是所有调用共享的。只有 GET / status / refresh 才带校验。
   *
   * @param {{ verify?: boolean }} [options]
   */
  const buildStatus = async (options = {}) => {
    const verify = options.verify !== false
    const status = statusOf()
    const { token } = readToken()
    let account = null
    if (verify && token !== '') {
      const result = await whoami(token, AbortSignal.timeout(VERIFY_TIMEOUT_MS))
      account = result.ok === true
        ? {
          ok: true,
          login: result.login,
          name: result.name,
          scopes: result.scopes,
          rate: result.rate,
          avatarUrl: typeof result.user?.avatar_url === 'string' ? result.user.avatar_url : '',
          htmlUrl: typeof result.user?.html_url === 'string' ? result.user.html_url : '',
        }
        : { ok: false, status: result.status, message: result.error.message }
      if (account.ok === true) {
        // 顺带把 login / scope 刷新到存储：界面与 CLI 读到的就是最新事实。
        try {
          writeStore({ login: account.login, scopes: account.scopes.length > 0 ? account.scopes : status.scopes })
        } catch {
          // 刷新失败不影响本次响应。
        }
      }
    } else if (token !== '' && status.login !== '') {
      // 不校验时用落盘记录兜底：界面仍能显示账号与 scope，只是没有速率限制。
      account = { ok: true, login: status.login, scopes: status.scopes, cached: true }
    }
    return {
      status: statusOf(),
      account,
      deviceFlow: attempt === undefined
        ? null
        : {
          userCode: attempt.userCode,
          verificationUri: attempt.verificationUri,
          startedAt: attempt.startedAt,
          intervalSec: attempt.intervalSec,
        },
      deviceScope: DEFAULT_SCOPE,
      storeFile: storePath(),
      tools: TOOL_TABLE.map((tool) => tool.name),
      runtime: runtimeInfo(),
    }
  }

  const handleRoot = async (request) => {
    // connection 的精确路由只支持 GET / HEAD / POST，所以「退出登录」也是一个 POST action。
    if (request.method === 'GET') return json({ ok: true, ...(await buildStatus()) })
    if (request.method !== 'POST') return fail('METHOD', '仅支持 GET 与 POST', 405)

    let body
    try {
      body = await request.json()
    } catch {
      return fail('BAD_JSON', '请求体不是合法 JSON')
    }
    const action = stringField(body, 'action')

    if (action === 'status') return json({ ok: true, ...(await buildStatus()) })

    if (action === 'tool') {
      const toolName = stringField(body, 'tool')
      if (toolName === '') return fail('NO_TOOL', '缺少 tool 字段')
      const args = body?.args !== null && typeof body?.args === 'object' ? body.args : {}
      const result = await runTool(toolName, args)
      return json({ ok: true, tool: toolName, text: result.text })
    }

    if (action === 'saveToken') {
      const token = stringField(body, 'token')
      if (token === '') return fail('EMPTY_TOKEN', 'token 不能为空')
      const checked = await verifyToken(token)
      if (checked.ok === false) return fail('INVALID_TOKEN', checked.message, 400, { githubStatus: checked.status })
      const kind = stringField(body, 'kind') === 'device' ? 'device' : 'pat'
      writeStore({ token, tokenKind: kind, login: checked.login, scopes: checked.scopes })
      log('info', `github: 已登录为 ${checked.login}（${kind}），scope=${checked.scopes.join(',') || '无（fine-grained token）'}`)
      return json({ ok: true, ...(await buildStatus({ verify: false })) })
    }

    if (action === 'saveConfig') {
      const patch = {}
      if (typeof body?.clientId === 'string') patch.clientId = body.clientId.trim()
      if (typeof body?.defaultRepo === 'string') patch.defaultRepo = body.defaultRepo.trim()
      // 云端成本策略：模式 id 与创建环境时的空闲自动停止分钟数。
      if (typeof body?.costMode === 'string') patch.costMode = body.costMode.trim()
      if (body?.createIdleTimeout !== undefined) patch.createIdleTimeout = Number(body.createIdleTimeout)
      if (Object.keys(patch).length === 0) return fail('NO_FIELDS', '没有可保存的字段')
      writeStore(patch)
      const next = statusOf()
      log('info', `github: 配置已更新（成本模式 ${next.costMode}，创建时空闲超时 ${String(next.createIdleTimeout)} 分钟）`)
      return json({ ok: true, ...(await buildStatus({ verify: false })) })
    }

    if (action === 'startDevice') {
      if (attempt !== undefined) return json({ ok: true, resumed: true, ...(await buildStatus()) })
      const clientId = stringField(body, 'clientId') !== '' ? stringField(body, 'clientId') : statusOf().clientId
      const started = await startDeviceFlow(clientId, DEFAULT_SCOPE)
      if (started.ok === false) return fail('DEVICE_START_FAILED', started.error.message, 400, { githubStatus: started.status })
      attempt = {
        clientId,
        deviceCode: started.deviceCode,
        userCode: started.userCode,
        verificationUri: started.verificationUri,
        intervalSec: started.intervalSec,
        expiresAt: Date.now() + started.expiresIn * 1000,
        startedAt: new Date().toISOString(),
        controller: new AbortController(),
      }
      if (statusOf().clientId === '' && clientId !== '') writeStore({ clientId })
      log('info', `github: 已申请设备码 ${started.userCode}（有效期 ${String(started.expiresIn)}s）`)
      return json({ ok: true, ...(await buildStatus({ verify: false })) })
    }

    if (action === 'pollDevice') {
      if (attempt === undefined) return fail('NO_ATTEMPT', '当前没有进行中的设备流授权，请先点击「开始授权」', 409, { githubCode: 'no_attempt' })
      if (Date.now() > attempt.expiresAt) {
        attempt = undefined
        return fail('EXPIRED', '设备码已过期，请重新开始授权', 410, { githubCode: 'expired_token' })
      }
      let polled
      try {
        polled = await pollDeviceFlowOnce(attempt.clientId, attempt.deviceCode, attempt.controller.signal)
      } catch (error) {
        attempt = undefined
        return fail('CANCELLED', `授权已取消：${error instanceof Error ? error.message : String(error)}`, 409, { githubCode: 'cancelled' })
      }
      if (polled.ok === false && polled.pending === true) {
        // 「还没确认」不是错误：把 GitHub 的原始码回给界面，由界面决定何时再问。
        return json({ ok: true, pending: true, githubCode: polled.code, ...(await buildStatus({ verify: true })) })
      }
      if (polled.ok === false) {
        if (polled.status === 410 || polled.status === 403) attempt = undefined
        return fail(
          polled.code === 'expired_token' ? 'EXPIRED' : 'DEVICE_POLL_FAILED',
          polled.error.message,
          400,
          { githubCode: polled.code, githubStatus: polled.status },
        )
      }
      const checked = await verifyToken(polled.token)
      if (checked.ok === false) {
        attempt = undefined
        return fail('INVALID_TOKEN', `拿到 token 但校验失败：${checked.message}`)
      }
      const scopes = polled.scope !== ''
        ? polled.scope.split(',').map((scope) => scope.trim()).filter((scope) => scope !== '')
        : checked.scopes
      writeStore({ token: polled.token, tokenKind: 'device', login: checked.login, scopes })
      attempt = undefined
      log('info', `github: 设备流授权完成，已登录为 ${checked.login}`)
      return json({ ok: true, ...(await buildStatus({ verify: false })) })
    }

    if (action === 'cancelDevice') {
      if (attempt === undefined) return json({ ok: true, cancelled: false, ...(await buildStatus({ verify: false })) })
      attempt.controller.abort()
      attempt = undefined
      return json({ ok: true, cancelled: true, ...(await buildStatus({ verify: false })) })
    }

    if (action === 'logout') {
      const { removed } = clearToken()
      log('info', `github: 已清除本地登录凭据（${removed ? '原有一条' : '原本就没有'}）`)
      return json({ ok: true, removed, ...(await buildStatus({ verify: false })) })
    }

    if (action === 'refresh') {
      const status = statusOf()
      const { token } = readToken()
      if (token === '') return fail('NOT_LOGGED_IN', '还没有登录 GitHub')
      const checked = await verifyToken(token)
      if (checked.ok === false) return fail('INVALID_TOKEN', checked.message, 400, { githubStatus: checked.status })
      writeStore({ login: checked.login, scopes: checked.scopes })
      return json({ ok: true, ...(await buildStatus()) })
    }

    return fail('UNKNOWN_ACTION', `未知 action：${action}`)
  }

  ctx.effect(
    () => ctx.get('connection').fetch.register({
      path: ROUTE_PATH,
      methods: ['GET', 'POST'],
      requestBody: 'buffered',
      fetch: handleRoot,
    }),
    `github: ${ROUTE_PATH}`,
  )

  /* -------------------------------------------------------------- agent 工具 */

  let registered = 0
  const tools = ctx.get('tools')
  if (tools === undefined) {
    log('warn', 'github: 当前组合没有 tools 服务，agent 工具未注册（设置页与 /api/github 仍然可用）')
  } else {
    for (const tool of TOOL_TABLE) {
      try {
        const disposer = tools.register({
          name: tool.name,
          description: tool.description,
          // DSH 对 parameters 是原样透传给模型的，所以这里必须是真正的 JSON Schema。
          parameters: toJsonSchema(tool.parameters),
          timeoutMs: TOOL_TIMEOUT_MS,
          output: {
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: { text: { type: 'string', description: '结果文本' } },
              required: ['text'],
            },
            render: (_args, value) => [{ type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value) }],
          },
          // 返回「已声明的 JSON 值」本身：DSH 会用 output.schema 校验它再交给 render。
          execute: async (args) => runTool(tool.name, args ?? {}),
        })
        ctx.effect(() => disposer, `github: tool ${tool.name}`)
        registered += 1
      } catch (error) {
        // 单个工具注册失败不应该拖垮整张表：记清楚，其余继续。
        log('warn', `github: 注册工具 ${tool.name} 失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }

  /* ---------------------------------------------------------- shell 环境变量 */

  const shellEnv = ctx.get('shellEnv')
  if (shellEnv === undefined) {
    log('warn', 'github: 当前组合没有 shellEnv 服务，DSH_GITHUB_TOKEN 未注入（其余功能不受影响）')
  } else {
    ctx.effect(
      () => shellEnv.register({
        name: 'github-token',
        variables: {
          DSH_GITHUB_TOKEN: {
            description: '当前 GitHub 登录 token（来自「设置 → GitHub」或环境变量 GITHUB_TOKEN）',
          },
        },
        resolve: () => {
          const { token } = readToken()
          return token === '' ? {} : { DSH_GITHUB_TOKEN: token }
        },
      }),
      'github: DSH_GITHUB_TOKEN',
    )
  }

  const status = statusOf()
  const detail = status.configured
    ? `已登录为 ${status.login === '' ? '(未校验)' : status.login}，来源 ${status.tokenKind === 'env' ? '环境变量' : '本地存储'}`
    : '未登录'
  log('info', `github: 已挂载 ${ROUTE_PATH}，注册 ${String(registered)}/${String(TOOL_TABLE.length)} 个工具，${detail}`)
}
