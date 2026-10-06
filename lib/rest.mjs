/**
 * GitHub REST 调用层。
 *
 * 只做三件事：拼请求、把错误收敛成结构化对象、把响应头里有用的元信息（scope、
 * 速率限制）带回来。所有上层（宿主路由、agent 工具、CLI、smoke 测试）都走这里，
 * 所以「token 怎么用」只有一个答案。
 *
 * 刻意不做的事：
 *  - 不缓存 token（每次调用重新解析，配合 {@link './store.mjs'} 的环境变量优先规则）；
 *  - 不吞掉错误码（`403` 与 `404` 对使用者的含义完全不同，必须原样上报）；
 *  - 不打印任何请求头。
 *
 * @module @ptfm/dsh-github/rest
 */

/** GitHub REST API 基址。 */
export const API_BASE = 'https://api.github.com'

/** 固定的 API 版本头；GitHub 要求显式声明以避免行为漂移。 */
export const API_VERSION = '2022-11-28'

/** 插件在所有请求上的 user-agent。 */
export const USER_AGENT = 'dsh-github-plugin'

/** GitHub 文档链接：按状态码给出下一步该看哪一页。 */
const DOCS = {
  401: 'https://docs.github.com/rest/authentication/authenticating-to-the-rest-api',
  403: 'https://docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api',
  404: 'https://docs.github.com/rest',
  422: 'https://docs.github.com/rest',
}

/**
 * 构造 GitHub 请求头。
 * @param {string} token
 * @returns {Record<string, string>}
 */
export function headersFor(token) {
  const headers = {
    accept: 'application/vnd.github+json',
    'x-github-api-version': API_VERSION,
    'user-agent': USER_AGENT,
  }
  if (typeof token === 'string' && token !== '') headers.authorization = `Bearer ${token}`
  return headers
}

/**
 * 把 HTTP 失败翻译成可展示的结构化错误。
 * @param {number} status
 * @param {unknown} body - 已解析的 JSON 响应体（可能是 undefined）。
 * @returns {{ status: number, message: string, docsUrl?: string, errors?: unknown }}
 */
export function normalizeError(status, body) {
  const record = body !== null && typeof body === 'object' ? body : {}
  const message = typeof record.message === 'string' && record.message !== ''
    ? record.message
    : `GitHub API 返回 HTTP ${String(status)}`
  const error = { status, message }
  if (DOCS[status] !== undefined) error.docsUrl = DOCS[status]
  if (Array.isArray(record.errors) && record.errors.length > 0) error.errors = record.errors
  return error
}

/** 从响应头读出 token 实际携带的 scope。 */
export function scopesFromResponse(response) {
  const raw = response.headers.get('x-oauth-scopes')
  if (raw === null) return []
  return raw.split(',').map((scope) => scope.trim()).filter((scope) => scope !== '')
}

/** 从响应头读出速率限制。 */
export function rateFromResponse(response) {
  const limit = response.headers.get('x-ratelimit-limit')
  const remaining = response.headers.get('x-ratelimit-remaining')
  const reset = response.headers.get('x-ratelimit-reset')
  if (limit === null && remaining === null) return undefined
  return {
    limit: limit === null ? undefined : Number(limit),
    remaining: remaining === null ? undefined : Number(remaining),
    resetAt: reset === null ? undefined : new Date(Number(reset) * 1000).toISOString(),
  }
}

/**
 * 调用一次 GitHub REST API。
 * @param {string} token - 明文 token；空串表示匿名调用（公开接口可用）。
 * @param {string} path - 以 `/` 开头的 API 路径，可含 query。
 * @param {{ method?: string, body?: unknown, signal?: AbortSignal, base?: string, headers?: Record<string, string> }} [options]
 * @returns {Promise<{ ok: true, status: number, data: unknown, scopes: string[], rate?: object }
 *   | { ok: false, status: number, error: ReturnType<typeof normalizeError> }>}
 */
export async function githubFetch(token, path, options = {}) {
  const method = (options.method ?? 'GET').toUpperCase()
  const url = `${options.base ?? API_BASE}${path}`
  const init = { method, headers: { ...headersFor(token), ...(options.headers ?? {}) } }
  if (options.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.headers['content-type'] = 'application/json'
    init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
  }
  if (options.signal !== undefined) init.signal = options.signal

  let response
  try {
    response = await fetch(url, init)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    return { ok: false, status: 0, error: { status: 0, message: `无法连接 api.github.com：${reason}` } }
  }

  // 空 body 是正常情况：DELETE / PUT 之类的成功响应通常没有内容体（204）。
  // 不判断的话 `JSON.parse('')` 会抛错，把一次**成功**的删除变成失败。
  const text = (await response.text()).replace(/^\uFEFF/, '')
  let parsed
  if (text.trim() !== '') {
    try {
      parsed = JSON.parse(text)
    } catch {
      parsed = text
    }
  }

  if (!response.ok) {
    return { ok: false, status: response.status, error: normalizeError(response.status, parsed) }
  }
  return {
    ok: true,
    status: response.status,
    data: parsed,
    scopes: scopesFromResponse(response),
    rate: rateFromResponse(response),
  }
}

/**
 * 校验 token 并取回身份信息。
 * @param {string} token
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ ok: true, login: string, name: string, scopes: string[], rate?: object, user: object }
 *   | { ok: false, status: number, error: object }>}
 */
export async function whoami(token, signal) {
  const result = await githubFetch(token, '/user', signal === undefined ? {} : { signal })
  if (!result.ok) return result
  const user = result.data !== null && typeof result.data === 'object' ? result.data : {}
  return {
    ok: true,
    login: typeof user.login === 'string' ? user.login : '',
    name: typeof user.name === 'string' ? user.name : '',
    user,
    scopes: result.scopes,
    rate: result.rate,
  }
}

/**
 * 把 `owner/repo` 拆成两段；不合法时返回 undefined。
 * @param {string} fullName
 * @returns {{ owner: string, repo: string } | undefined}
 */
export function splitRepo(fullName) {
  const value = typeof fullName === 'string' ? fullName.trim().replace(/^\/+|\/+$/g, '') : ''
  const parts = value.split('/')
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return undefined
  return { owner: parts[0], repo: parts[1] }
}

/** 把 query 对象拼成 URL query 字符串（跳过空值）。 */
export function query(params) {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? '' : `?${text}`
}
