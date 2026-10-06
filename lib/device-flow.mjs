/**
 * GitHub OAuth Device Flow（RFC 8628 在 GitHub 上的实现）。
 *
 * 选它而不是 Web Flow 的原因：**不需要 client_secret**。device flow 是给无法保密的
 * 客户端设计的，所以插件里只放 `client_id`（本来就不是秘密），不会出现「把 secret
 * 塞进桌面应用」这种必然泄露的写法。代价是授权动作发生在浏览器里（用户输入 8 位码），
 * 插件这边只负责轮询。
 *
 * 需要用户做一次的事：在 GitHub 上建一个 OAuth App 并勾选 **Enable Device Flow**。
 * 界面里有引导，`client_id` 存在设置里。
 *
 * @module @ptfm/dsh-github/device-flow
 */

/** 申请设备码的端点。 */
export const DEVICE_CODE_URL = 'https://github.com/login/device/code'

/** 换取 token 的端点。 */
export const TOKEN_URL = 'https://github.com/login/oauth/access_token'

/** 用户输入 8 位码的页面。 */
export const VERIFY_URL = 'https://github.com/login/device'

/** 请求的 scope。注意：**token 的实际权限以 GitHub 授权页为准**；
 *  这里要的是「能用账号干活」的常用集合：仓库读写、组织只读、Actions、gist。 */
export const DEFAULT_SCOPE = 'repo read:org workflow gist'

/** 默认轮询间隔（秒）；GitHub 通常在响应里给出更准确的值。 */
export const DEFAULT_INTERVAL_SEC = 5

/**
 * 申请设备码与用户码。
 * @param {string} clientId - OAuth App 的 client_id。
 * @param {string} [scope] - 空格分隔的 scope。
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ ok: true, deviceCode: string, userCode: string, verificationUri: string,
 *   expiresIn: number, intervalSec: number }
 *   | { ok: false, status: number, error: { status: number, message: string, docsUrl?: string } }>}
 */
export async function startDeviceFlow(clientId, scope = DEFAULT_SCOPE, signal) {
  const id = typeof clientId === 'string' ? clientId.trim() : ''
  if (id === '') {
    return { ok: false, status: 0, error: { status: 0, message: '还没有 client_id：请先填写 GitHub OAuth App 的 Client ID（并勾选 Enable Device Flow）' } }
  }
  const body = new URLSearchParams({ client_id: id, scope })
  let response
  try {
    response = await fetch(DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'dsh-github-plugin',
      },
      body: body.toString(),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, status: 0, error: { status: 0, message: `无法连接 github.com：${reason}` } }
  }

  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = {}
  }
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: {
        status: response.status,
        message: typeof parsed.error_description === 'string'
          ? parsed.error_description
          : `申请设备码失败（HTTP ${String(response.status)}）`,
      },
    }
  }
  const intervalSec = Number.isFinite(Number(parsed.interval)) && Number(parsed.interval) > 0
    ? Number(parsed.interval)
    : DEFAULT_INTERVAL_SEC
  return {
    ok: true,
    deviceCode: String(parsed.device_code ?? ''),
    userCode: String(parsed.user_code ?? ''),
    verificationUri: String(parsed.verification_uri ?? VERIFY_URL),
    expiresIn: Number.isFinite(Number(parsed.expires_in)) ? Number(parsed.expires_in) : 900,
    intervalSec,
  }
}

/** 让出指定的秒数，可被 signal 打断。 */
function sleep(seconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('aborted'))
      return
    }
    function onAbort() {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort)
      resolve()
    }, seconds * 1000)
    signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/**
 * 单次轮询。刻意不做循环：节奏由调用方决定（界面每 5 秒调一次、CLI 在同一个进程里
 * 自己循环），这样「取消」永远能在一次 HTTP 调用内生效，宿主路由也因此保持无状态。
 *
 * @param {string} clientId
 * @param {string} deviceCode
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ ok: true, token: string, scope: string }
 *   | { ok: false, pending: true, code: 'authorization_pending' | 'slow_down' }
 *   | { ok: false, pending: false, status: number, code: string, error: { status: number, message: string } }>}
 *   `pending: true` 不是失败，只是「GitHub 侧还没确认」；`code` 是 GitHub 的 error
 *   码原样透传，调用方据此分支——永远不要匹配错误文案。
 */
export async function pollDeviceFlowOnce(clientId, deviceCode, signal) {
  const body = new URLSearchParams({
    client_id: typeof clientId === 'string' ? clientId.trim() : '',
    device_code: deviceCode,
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  })

  let response
  try {
    response = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': 'dsh-github-plugin',
      },
      body: body.toString(),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    if (signal?.aborted === true) throw error
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, pending: false, status: 0, code: 'network', error: { status: 0, message: `轮询 token 失败：${reason}` } }
  }

  const text = await response.text()
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = {}
  }

  if (typeof parsed.access_token === 'string' && parsed.access_token !== '') {
    return { ok: true, token: parsed.access_token, scope: String(parsed.scope ?? '') }
  }

  const code = String(parsed.error ?? '')
  if (code === 'authorization_pending' || code === 'slow_down') {
    return { ok: false, pending: true, code }
  }
  if (code === 'expired_token') {
    return { ok: false, pending: false, status: 410, code, error: { status: 410, message: '设备码已过期，请重新开始授权' } }
  }
  if (code === 'access_denied') {
    return { ok: false, pending: false, status: 403, code, error: { status: 403, message: '你在 GitHub 上拒绝了本次授权' } }
  }
  if (code === 'incorrect_device_code' || code === 'device_flow_disabled') {
    return {
      ok: false,
      pending: false,
      status: 400,
      code,
      error: {
        status: 400,
        message: typeof parsed.error_description === 'string'
          ? parsed.error_description
          : '设备流不可用：请确认 OAuth App 已勾选 Enable Device Flow',
      },
    }
  }
  // 未知的 error 码：上报原文，不猜。
  const status = response.ok ? 400 : response.status
  return {
    ok: false,
    pending: false,
    status,
    code: code === '' ? 'unknown' : code,
    error: {
      status,
      message: typeof parsed.error_description === 'string'
        ? parsed.error_description
        : `未预期的响应：${code === '' ? `HTTP ${String(response.status)}` : code}`,
    },
  }
}

/**
 * 循环轮询直到用户授权、拒绝、超时或被取消（CLI 用；宿主路由走
 * {@link pollDeviceFlowOnce}，由界面控制节奏）。
 *
 * @param {string} clientId
 * @param {string} deviceCode
 * @param {number} intervalSec - 初次间隔；收到 `slow_down` 后每次 +5 秒（GitHub 要求）。
 * @param {AbortSignal} [signal]
 * @param {(attempt: number, intervalSec: number) => void} [onTick] - 每次轮询前回调，供界面显示进度。
 * @returns {Promise<{ ok: true, token: string, scope: string }
 *   | { ok: false, pending: false, status: number, code: string, error: { status: number, message: string } }>}
 */
export async function pollDeviceFlow(clientId, deviceCode, intervalSec = DEFAULT_INTERVAL_SEC, signal, onTick) {
  let interval = Number.isFinite(intervalSec) && intervalSec > 0 ? intervalSec : DEFAULT_INTERVAL_SEC
  for (let attempt = 1; attempt <= 400; attempt += 1) {
    if (typeof onTick === 'function') onTick(attempt, interval)
    await sleep(interval, signal)
    const result = await pollDeviceFlowOnce(clientId, deviceCode, signal)
    if (result.ok === true) return result
    if (result.pending === true) {
      if (result.code === 'slow_down') interval += 5
      continue
    }
    return result
  }
  return { ok: false, pending: false, status: 408, code: 'timeout', error: { status: 408, message: '轮询次数超出上限，请重新开始授权' } }
}
