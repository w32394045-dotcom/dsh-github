/**
 * 云端成本策略：什么时候提醒、什么时候可以自动关机、以及**绝不**在什么时候关。
 *
 * 这个模块只做一件事：把「省钱」和「别打断正在干的活」这两条互相冲突的诉求，
 * 变成一组可预测的规则。它被两处共用——agent 的 `github-cost` 工具、以及设置页的
 * 成本模式说明——所以规则只写一遍。
 *
 * ## 为什么不能只看 `state`
 *
 * Codespaces 的 `state` 只有 Starting/Available/ShuttingDown/Stopped 之类，**没有**
 * 「人正在里面敲代码」这个信息：一个 Available 的机器可能正在跑长时间的构建，也可
 * 能已经开着两小时没人碰。真正可用的信号是 `last_used_at`（GitHub 自己维护的最后
 * 活动时间）加上 DSH 自己的记录/心跳。
 *
 * ## 安全边界（这条比省钱重要）
 *
 * 只要满足任一条，reap **绝不**关机，哪怕用户显式要求：
 *   - `last_used_at` 在 `activeGuardMinutes` 之内（默认 15 分钟）；
 *   - `last_used_at` 不可解析（宁可花钱也不猜）；
 *   - DSH 这边有该机器的活跃租约（见 {@link leaseStatus}）。
 *
 * 换句话说：宁可多花几分钟的钱，也不冒「关掉正在跑的活」的风险。
 *
 * @module @ptfm/dsh-github/lifecycle
 */

import { join } from 'node:path'
import { dshHome } from './store.mjs'

/** 成本模式：从省心到极致省钱。 */
export const COST_MODES = {
  /** 平衡：只提醒 + 保守回收，默认 idle 30 分钟。 */
  balanced: {
    id: 'balanced',
    label: '平衡',
    idleWarnMinutes: 30,
    idleReapMinutes: 120,
    activeGuardMinutes: 15,
    defaultIdleTimeoutMinutes: 30,
    note: '超过 30 分钟没活动就提醒；超过 2 小时没活动才允许回收；15 分钟内有活动绝不回收。',
  },
  /** 极致省钱：更早提醒、更快回收、默认 idle 更短。 */
  frugal: {
    id: 'frugal',
    label: '极致省钱',
    idleWarnMinutes: 15,
    idleReapMinutes: 45,
    activeGuardMinutes: 10,
    defaultIdleTimeoutMinutes: 15,
    note: '15 分钟没活动就提醒；45 分钟没活动就允许回收；建环境时默认 idle 15 分钟。省钱最狠，但闲置重开要多等一次启动。',
  },
  /** 手动：只报告，不回收，idle 用平台默认。 */
  manual: {
    id: 'manual',
    label: '手动',
    idleWarnMinutes: 120,
    idleReapMinutes: Number.POSITIVE_INFINITY,
    activeGuardMinutes: 30,
    defaultIdleTimeoutMinutes: 30,
    note: '只报告不自动回收，要不要关完全由你决定。适合长时间跑训练/构建的场景。',
  },
}

/** 默认模式。 */
export const DEFAULT_COST_MODE = 'balanced'

/** Codespaces 计费单价（美元）。取 GitHub 公开价目表的最大档，宁可高估不高估漏。 */
export const CODESPACE_PRICES = {
  /** 2 核 8 GB：约 $0.18/小时。 */
  basicLinux32gb: 0.18,
  /** 4 核 16 GB：约 $0.36/小时。 */
  standardLinux32gb: 0.36,
  /** 8 核 32 GB：约 $0.72/小时。 */
  largeLinux64gb: 0.72,
  /** 16 核 64 GB：约 $1.44/小时。 */
  xlargeLinux128gb: 1.44,
}

/** 存储单价：$0.07 / GB / 月（停机的机器照样收）。 */
export const STORAGE_PRICE_PER_GB_MONTH = 0.07

/** 默认存储配额（GB），用于估算停机成本。 */
export const DEFAULT_STORAGE_GB = 32

/**
 * 把模式 id 解析成完整策略；未知值回落到平衡。
 * @param {string} [mode]
 * @returns {typeof COST_MODES[keyof typeof COST_MODES]}
 */
export function resolveCostPolicy(mode) {
  const key = typeof mode === 'string' ? mode.trim() : ''
  return COST_MODES[key] ?? COST_MODES[DEFAULT_COST_MODE]
}

/** 某机型的每小时价格；未知机型按 4 核档估。 */
export function pricePerHour(machineName) {
  const name = typeof machineName === 'string' ? machineName : ''
  if (CODESPACE_PRICES[name] !== undefined) return CODESPACE_PRICES[name]
  // 按名字里的规格猜：basic=2 核、large/xlarge 按关键字。
  if (/^basic/i.test(name)) return CODESPACE_PRICES.basicLinux32gb
  if (/^xlarge/i.test(name)) return CODESPACE_PRICES.xlargeLinux128gb
  if (/^large/i.test(name)) return CODESPACE_PRICES.largeLinux64gb
  return CODESPACE_PRICES.standardLinux32gb
}

/** 把 ISO 时间解析成毫秒；无法解析返回 undefined。 */
function timeOf(value) {
  if (typeof value !== 'string' || value === '') return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

/**
 * 判断一台 Codespace 的闲置情况，并给出**是否可以安全回收**的结论。
 *
 * @param {object} space - GitHub 返回的 Codespace 对象。
 * @param {object} policy - {@link resolveCostPolicy} 的结果。
 * @param {number} [now] - 当前时间（毫秒），便于测试注入。
 * @param {{ leased?: boolean }} [options] - 外部已知的活跃租约（例如 agent 自己刚用过）。
 * @returns {{ name: string, state: string, idleMinutes: number | undefined,
 *   running: boolean, warn: boolean, reapable: boolean, blockedBy?: string }}
 */
export function assessIdle(space, policy, now = Date.now(), options = {}) {
  const name = String(space?.name ?? '')
  const state = String(space?.state ?? '')
  const running = state === 'Available' || state === 'Starting' || state === 'Rebuilding'
  // **只用 last_used_at，不回落到 created_at**：一台创建于 10 小时前、但刚刚在用的
  // 机器，如果用 created_at 兜底就会被算成「闲置 10 小时」——那正是会误关的算法。
  // 拿不到可信的最后活动时间，就宁可不动它。
  const lastUsed = timeOf(space?.last_used_at)
  const idleMinutes = lastUsed === undefined ? undefined : Math.max(0, (now - lastUsed) / 60000)

  const result = { name, state, idleMinutes, running, warn: false, reapable: false }
  if (!running) {
    // 已经停机/关机中：不需要回收，但也不该报「闲置警告」。
    result.blockedBy = 'not-running'
    return result
  }
  if (idleMinutes === undefined) {
    // 宁可花钱也不猜：没有可信的最后活动时间就不动它。
    result.blockedBy = 'unknown-last-used'
    return result
  }
  if (options.leased === true) {
    result.blockedBy = 'active-lease'
    result.warn = false
    return result
  }
  if (idleMinutes < policy.activeGuardMinutes) {
    result.blockedBy = `recently-active(${String(Math.round(idleMinutes))}m<${String(policy.activeGuardMinutes)}m)`
    return result
  }
  result.warn = idleMinutes >= policy.idleWarnMinutes
  result.reapable = Number.isFinite(policy.idleReapMinutes) && idleMinutes >= policy.idleReapMinutes
  return result
}

/**
 * 估算一台运行中的 Codespace 每小时花多少、以及已经花了多少。
 *
 * `costSoFar` 用**连续运行时长**算（GitHub 从 `created_at` 起计费，直到停机），
 * 这是下界而不是精确账单——真正的账单只有 GitHub 自己知道。给出量级就够了。
 *
 * @param {object} space
 * @param {number} [now]
 * @returns {{ hourly: number, hoursRunning: number | undefined, costSoFar: number | undefined,
 *   costIfLeft24h: number, machine: string }}
 */
export function estimateCost(space, now = Date.now()) {
  const machine = String(space?.machine?.name ?? space?.machine ?? 'standardLinux32gb')
  const hourly = pricePerHour(machine)
  const created = timeOf(space?.created_at)
  const hoursRunning = created === undefined ? undefined : Math.max(0, (now - created) / 3600000)
  return {
    machine,
    hourly,
    hoursRunning,
    costSoFar: hoursRunning === undefined ? undefined : hourly * hoursRunning,
    costIfLeft24h: hourly * 24,
  }
}

/** 金额格式化：小额保留两位小数。 */
export function money(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '?'
  return `$${value.toFixed(value < 10 ? 2 : 1)}`
}

/* --------------------------------------------------------------- 租约记录 */

/**
 * 活跃租约文件路径。
 *
 * agent 在**开始**一项长任务（创建环境、跑长构建）时打一个租约，结束时撤销。有租约
 * 的机器在租约过期前绝不被回收——这是「他正用着你别关」的机械保障，比只看时间戳更硬。
 */
export function leasePath() {
  return join(dshHome(), 'codespace-leases.json')
}

/**
 * 读取租约表（文件缺失/损坏时返回空表，绝不抛）。
 * @param {(path: string) => string} readFile - 传入 fs.readFileSync，便于测试注入。
 * @returns {Record<string, number>} 机器名 → 租约到期时间（毫秒）
 */
export function readLeases(readFile) {
  try {
    const parsed = JSON.parse(readFile(leasePath(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return {}
    const out = {}
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

/**
 * 某台机器此刻是否被租约保护。
 * @param {Record<string, number>} leases
 * @param {string} name
 * @param {number} [now]
 * @returns {boolean}
 */
export function leaseStatus(leases, name, now = Date.now()) {
  const until = leases?.[name]
  return typeof until === 'number' && until > now
}
