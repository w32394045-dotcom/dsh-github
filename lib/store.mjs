/**
 * GitHub 凭据与设置存储。
 *
 * 这是插件唯一持有 token 的地方，也是宿主半边、浏览器半边与 CLI 三者的共同底座。
 * 设计约束（每一条都是有意的）：
 *
 *  - **落盘位置**：`$DSH_HOME/github.json`（Windows 下即 `C:\Users\ptfm\.dsh\github.json`），
 *    权限尽力设为 0600。放在 DSH home 而不是 profile 目录里，是因为它是**用户数据**
 *    而非插件代码：删掉或重装插件不该让你的登录失效。
 *  - **原子写**：先写临时文件再 rename。宿主、CLI、甚至 DSH 自身可能并发读写，
 *    半个 JSON 文件会让两边都读不出登录态。
 *  - **token 不外泄**：只有 {@link readToken} 返回明文。所有给界面/日志用的
 *    函数（{@link statusOf}）只返回掩码预览，这条规则由 test/smoke.mjs 断言守着。
 *
 * @module @ptfm/dsh-github/store
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 存储文件名（位于 `$DSH_HOME` 下）。 */
export const STORE_FILE_NAME = 'github.json'

/** 设置默认值；`token` 为 `''` 表示未登录。 */
export const DEFAULT_SETTINGS = {
  /** GitHub token 明文（仅本文件与宿主内存持有）。 */
  token: '',
  /** token 来源：`pat` 手填 / `device` 设备流 / `env` 环境变量。 */
  tokenKind: '',
  /** token 对应的 GitHub login（写入前经 `/user` 校验得到）。 */
  login: '',
  /** token 实际携带的 scope（来自 `x-oauth-scopes` 响应头）。 */
  scopes: [],
  /** OAuth App 的 client_id（device flow 用；不是秘密，可明文存）。 */
  clientId: '',
  /** 默认仓库 `owner/name`，仅作界面预填。 */
  defaultRepo: '',
  /**
   * 云端成本模式：`balanced`（平衡）/ `frugal`（极致省钱）/ `manual`（手动）。
   * 规则见 lifecycle.mjs——这里只存一个 id，避免把策略抄成两份。
   */
  costMode: 'balanced',
  /**
   * 创建 Codespace 时的默认空闲自动停止分钟数。
   * 这是最省事的一道保险：环境自己会在闲置这么久后停机，不依赖任何人记得关。
   * `0` 表示用平台默认（30 分钟）。
   */
  createIdleTimeout: 15,
  /** 最近一次写入时间（ISO 字符串）。 */
  updatedAt: '',
}

/** DSH home 绝对路径：优先 `DSH_HOME`，否则 `~/.dsh`。 */
export function dshHome() {
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')
}

/** 存储文件绝对路径。 */
export function storePath() {
  return join(dshHome(), STORE_FILE_NAME)
}

/** 把任意输入收敛成完整、类型正确的设置对象。 */
export function normalizeSettings(value) {
  const source = value !== null && typeof value === 'object' ? value : {}
  const scopes = Array.isArray(source.scopes)
    ? source.scopes.filter((scope) => typeof scope === 'string' && scope.trim() !== '').map((scope) => scope.trim())
    : []
  const kind = source.tokenKind === 'pat' || source.tokenKind === 'device' || source.tokenKind === 'env'
    ? source.tokenKind
    : ''
  const mode = source.costMode === 'frugal' || source.costMode === 'manual' || source.costMode === 'balanced'
    ? source.costMode
    : 'balanced'
  const idleRaw = Number(source.createIdleTimeout)
  const idle = Number.isFinite(idleRaw) ? Math.min(Math.max(Math.round(idleRaw), 0), 240) : 15
  return {
    token: typeof source.token === 'string' ? source.token.trim() : '',
    tokenKind: kind,
    login: typeof source.login === 'string' ? source.login.trim() : '',
    scopes,
    clientId: typeof source.clientId === 'string' ? source.clientId.trim() : '',
    defaultRepo: typeof source.defaultRepo === 'string' ? source.defaultRepo.trim() : '',
    costMode: mode,
    createIdleTimeout: idle,
    updatedAt: typeof source.updatedAt === 'string' ? source.updatedAt : '',
  }
}

/**
 * 读取落盘设置。文件缺失、损坏或不是对象时返回默认值。
 *
 * 显式剥掉 UTF-8 BOM：Windows 上用 PowerShell 5.1 的 `Set-Content -Encoding utf8`
 * 或旧版记事本编辑过的文件会带 `EF BB BF`，而 `JSON.parse` 对 BOM 直接抛错——
 * 表现为「明明登录过却显示未配置」，这种坑不值得让用户踩一次。
 * @returns {ReturnType<typeof normalizeSettings>}
 */
export function readStore() {
  try {
    const raw = readFileSync(storePath(), 'utf8').replace(/^\uFEFF/, '')
    const parsed = JSON.parse(raw)
    return normalizeSettings({ ...DEFAULT_SETTINGS, ...(parsed !== null && typeof parsed === 'object' ? parsed : {}) })
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

/**
 * 原子合并写入：读旧值 → 合并 patch → 写临时文件 → rename 覆盖。
 * @param {object} patch - 要合并进去的字段。
 * @returns {ReturnType<typeof normalizeSettings>} 写入后的完整设置。
 */
export function writeStore(patch) {
  const next = normalizeSettings({ ...readStore(), ...(patch ?? {}) })
  next.updatedAt = new Date().toISOString()
  const file = storePath()
  const temp = `${file}.tmp-${String(process.pid)}`
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    chmodSync(temp, 0o600)
  } catch {
    // Windows 上 chmod 基本是空操作，失败不影响正确性。
  }
  renameSync(temp, file)
  try {
    chmodSync(file, 0o600)
  } catch {
    // 同上。
  }
  return next
}

/** 清空 token 及与之绑定的身份字段，保留 clientId / defaultRepo。 */
export function clearToken() {
  const current = readStore()
  const had = current.token !== ''
  return { removed: had, settings: writeStore({ token: '', tokenKind: '', login: '', scopes: [] }) }
}

/**
 * 解析当前生效的 token：进程环境变量 `GITHUB_TOKEN` / `DSH_GITHUB_TOKEN` 优先于落盘值。
 * 环境变量优先意味着「临时改用某个 CI token」不需要先清空本地登录。
 * @returns {{ token: string, source: 'env' | 'store' }}
 */
export function readToken() {
  for (const key of ['DSH_GITHUB_TOKEN', 'GITHUB_TOKEN']) {
    const value = typeof process.env[key] === 'string' ? process.env[key].trim() : ''
    if (value !== '') return { token: value, source: 'env' }
  }
  const { token } = readStore()
  return { token, source: 'store' }
}

/**
 * 掩码预览：只保留前 4 位与后 4 位。短 token 一律打码。
 * @param {string} token
 * @returns {string} 形如 `ghp_…3f2a`，未配置时为空串。
 */
export function maskToken(token) {
  const value = typeof token === 'string' ? token : ''
  if (value === '') return ''
  if (value.length <= 12) return '••••'
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

/**
 * 面向界面与日志的状态快照：**永不包含明文 token**。
 * @returns {object} 连接状态、来源、掩码预览、存储路径等。
 */
export function statusOf() {
  const settings = readStore()
  const { token, source } = readToken()
  const configured = token !== ''
  return {
    configured,
    source,
    tokenKind: source === 'env' ? 'env' : settings.tokenKind,
    login: settings.login,
    scopes: settings.scopes,
    clientId: settings.clientId,
    defaultRepo: settings.defaultRepo,
    // 云端成本策略也要从这里出去：工具与设置页都只读 statusOf()，
    // 漏了这两个字段的表现是「设置改了不生效」，而且不报错。
    costMode: settings.costMode,
    createIdleTimeout: settings.createIdleTimeout,
    updatedAt: settings.updatedAt,
    preview: maskToken(token),
    storeFile: storePath(),
  }
}

/** 供 test/smoke.mjs 使用：确保临时目录下的文件被清理。 */
export function deleteStoreFile() {
  try {
    unlinkSync(storePath())
    return true
  } catch {
    return false
  }
}
