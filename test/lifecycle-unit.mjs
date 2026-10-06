/**
 * 云端生命周期与成本策略测试。
 *
 * 这套规则里**最重要的一条不是省钱，而是「绝不把关掉正在用的机器」**，所以测试的
 * 重心在安全边界：刚活动过 → 不许关；时间戳不可信 → 不许关；有租约 → 不许关；
 * manual 模式 → 根本不动手。省钱阈值反而好测。
 *
 * 运行：node test/lifecycle-unit.mjs
 *
 * @module @ptfm/dsh-github/test/lifecycle-unit
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

const home = mkdtempSync(join(tmpdir(), 'dsh-github-lifecycle-'))
process.env.DSH_HOME = home
delete process.env.GITHUB_TOKEN
delete process.env.DSH_GITHUB_TOKEN
writeFileSync(join(home, 'github.json'), JSON.stringify({ token: 'ghp_x'.padEnd(40, '0'), login: 'octocat', scopes: ['codespace'] }), 'utf8')

const life = await import('../lib/lifecycle.mjs')
const { runTool } = await import('../lib/tools.mjs')

/** 固定「现在」，避免测试随真实时间漂移。 */
const NOW = Date.parse('2026-10-01T12:00:00Z')
/** 造一台 Codespace：`lastUsedMinutesAgo` 为 null 时故意给一个不可解析的时间戳。 */
const space = (name, lastUsedMinutesAgo, extra = {}) => ({
  name,
  state: 'Available',
  machine: { name: 'standardLinux32gb', display_name: '4 cores' },
  // 注意括号：`a ?? 0 + 30` 会因为 ?? 优先级低于 + 而先算出 `a ?? (0+30)`，
  // 结果创建时间只比现在早 30 分钟——这里要的是「闲置时长 + 30 分钟」。
  created_at: new Date(NOW - ((lastUsedMinutesAgo ?? 0) + 30) * 60000).toISOString(),
  last_used_at: lastUsedMinutesAgo === null ? 'not-a-date' : new Date(NOW - lastUsedMinutesAgo * 60000).toISOString(),
  idle_timeout_minutes: 15,
  ...extra,
})

console.log('== 模式解析')
ok(life.resolveCostPolicy('balanced').id === 'balanced', 'balanced 解析正确')
ok(life.resolveCostPolicy('frugal').id === 'frugal', 'frugal 解析正确')
ok(life.resolveCostPolicy('manual').id === 'manual', 'manual 解析正确')
ok(life.resolveCostPolicy('nonsense').id === 'balanced', '未知模式回落到 balanced')
ok(life.resolveCostPolicy(undefined).id === 'balanced', '缺省为 balanced')
ok(life.COST_MODES.frugal.idleReapMinutes < life.COST_MODES.balanced.idleReapMinutes, '极致省钱的回收阈值更激进')
ok(!Number.isFinite(life.COST_MODES.manual.idleReapMinutes), '手动模式永不自动回收')
ok(life.COST_MODES.frugal.activeGuardMinutes <= life.COST_MODES.balanced.activeGuardMinutes, '极致省钱的安全窗口不宽于平衡模式')

console.log('\n== 单价与估算')
ok(life.pricePerHour('basicLinux32gb') === 0.18, 'basic 单价')
ok(life.pricePerHour('standardLinux32gb') === 0.36, 'standard 单价')
ok(life.pricePerHour('largeLinux64gb') === 0.72, 'large 单价')
ok(life.pricePerHour('xlargeLinux128gb') === 1.44, 'xlarge 单价')
ok(life.pricePerHour('some-new-machine') === 0.36, '未知机型按 4 核档保守估')
ok(life.pricePerHour('basicLinux99gb') === 0.18, '按名字前缀识别 basic')
{
  const estimate = life.estimateCost(space('a', 30), NOW)
  ok(Math.abs(estimate.hourly - 0.36) < 1e-9, '每小时价正确')
  ok(Math.abs(estimate.hoursRunning - 1) < 1e-6, '连续运行 1 小时', String(estimate.hoursRunning))
  ok(Math.abs(estimate.costSoFar - 0.36) < 1e-6, '已花费 = 单价 × 小时数')
  ok(Math.abs(estimate.costIfLeft24h - 8.64) < 1e-6, '放任 24 小时的费用')
  ok(life.money(0.36) === '$0.36', '金额格式化（小额两位）')
}

console.log('\n== 安全边界：绝不关掉正在用的机器')
{
  const policy = life.COST_MODES.balanced
  const fresh = life.assessIdle(space('fresh', 3), policy, NOW)
  ok(fresh.reapable === false, '刚活动 3 分钟：不可回收')
  ok(fresh.warn === false, '刚活动 3 分钟：不告警')
  ok(String(fresh.blockedBy).startsWith('recently-active'), '给出「刚活动过」的锁定原因', String(fresh.blockedBy))

  const leased = life.assessIdle(space('busy', 600), policy, NOW, { leased: true })
  ok(leased.reapable === false, '有活跃租约：即使闲置 10 小时也不可回收')
  ok(leased.blockedBy === 'active-lease', '锁定原因是租约', String(leased.blockedBy))

  const unknown = life.assessIdle(space('weird', null), life.COST_MODES.balanced, NOW)
  ok(unknown.reapable === false, '时间戳不可解析：不可回收')
  ok(unknown.blockedBy === 'unknown-last-used', '锁定原因是时间不可信', String(unknown.blockedBy))
  // 关键：**不能**用 created_at 兜底。否则「10 小时前创建、刚刚在用」的机器会被算成闲置 10 小时。
  const staleCreated = life.assessIdle(
    { name: 'stale', state: 'Available', created_at: new Date(NOW - 10 * 3600000).toISOString(), last_used_at: undefined, machine: { name: 'basicLinux32gb' } },
    life.COST_MODES.balanced,
    NOW,
  )
  ok(staleCreated.idleMinutes === undefined, '缺 last_used_at 时不拿 created_at 顶替', String(staleCreated.idleMinutes))
  ok(staleCreated.reapable === false, '缺 last_used_at 时不可回收（宁可花钱也不误关）')

  const stopped = life.assessIdle(space('off', 600, { state: 'ShutDown' }), policy, NOW)
  ok(stopped.running === false, '已停机的环境不算运行中')
  ok(stopped.reapable === false, '已停机的不需要回收')
  ok(stopped.warn === false, '已停机的不告警')
}

console.log('\n== 阈值：平衡 vs 极致省钱')
{
  const balanced = life.COST_MODES.balanced
  const frugal = life.COST_MODES.frugal
  const at40 = space('idle40', 40)
  ok(life.assessIdle(at40, balanced, NOW).warn === true, '平衡模式：闲置 40 分钟告警')
  ok(life.assessIdle(at40, balanced, NOW).reapable === false, '平衡模式：闲置 40 分钟还不回收')
  ok(life.assessIdle(at40, frugal, NOW).warn === true, '极致模式：闲置 40 分钟告警')
  ok(life.assessIdle(space('idle20', 20), frugal, NOW).warn === true, '极致模式：闲置 20 分钟就告警')
  ok(life.assessIdle(space('idle20', 20), balanced, NOW).warn === false, '平衡模式：闲置 20 分钟不告警')
  ok(life.assessIdle(space('idle130', 130), balanced, NOW).reapable === true, '平衡模式：闲置 130 分钟可回收')
  ok(life.assessIdle(space('idle50', 50), frugal, NOW).reapable === true, '极致模式：闲置 50 分钟可回收')
  ok(life.assessIdle(space('idle50', 50), life.COST_MODES.manual, NOW).reapable === false, '手动模式：一律不回收')
}

console.log('\n== 租约文件')
{
  const leases = { 'abc': NOW + 60000, 'expired': NOW - 60000 }
  ok(life.leaseStatus(leases, 'abc', NOW) === true, '未到期租约生效')
  ok(life.leaseStatus(leases, 'expired', NOW) === false, '过期租约失效')
  ok(life.leaseStatus(leases, 'missing', NOW) === false, '无租约返回 false')
  ok(life.leaseStatus(undefined, 'abc', NOW) === false, '租约表缺失也不抛')

  const readFrom = (contents) => () => contents
  ok(Object.keys(life.readLeases(readFrom('{"a":1}'))).length === 1, '读取合法租约表')
  ok(Object.keys(life.readLeases(readFrom('not json'))).length === 0, '损坏的租约表返回空表而不是抛错')
  ok(Object.keys(life.readLeases(readFrom('{"a":"soon"}'))).length === 0, '非数字到期时间被丢弃')
}

/* ---------------------------------------------- 通过工具路径验证整体行为 */

/** 审计请求并给出可控响应。 */
const calls = []
let listed = { codespaces: [], total_count: 0 }
globalThis.fetch = async (url, init = {}) => {
  const href = String(url)
  calls.push({ url: href, method: String(init.method ?? 'GET'), body: init.body })
  if (href.includes('/user/codespaces') && String(init.method ?? 'GET') === 'GET') {
    return new Response(JSON.stringify(listed), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  if (href.includes('/stop')) {
    return new Response(JSON.stringify({ state: 'ShuttingDown' }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return new Response(JSON.stringify({ name: 'created', state: 'Starting', machine: { name: 'standardLinux32gb' }, idle_timeout_minutes: 15 }), {
    status: 201,
    headers: { 'content-type': 'application/json' },
  })
}

console.log('\n== 成本报告（github-cloud action=cost）')
{
  calls.length = 0
  listed = {
    total_count: 2,
    codespaces: [
      { name: 'idle-one', state: 'Available', machine: { name: 'standardLinux32gb' }, created_at: new Date(Date.now() - 3 * 3600000).toISOString(), last_used_at: new Date(Date.now() - 3 * 3600000).toISOString(), idle_timeout_minutes: 15 },
      { name: 'active-one', state: 'Available', machine: { name: 'basicLinux32gb' }, created_at: new Date(Date.now() - 3600000).toISOString(), last_used_at: new Date(Date.now() - 60000).toISOString(), idle_timeout_minutes: 15 },
    ],
  }
  const result = await runTool('github-cloud', { action: 'cost' })
  ok(result.text.includes('成本模式：平衡'), '报告当前模式')
  ok(result.text.includes('提醒阈值 30 分钟'), '报告阈值')
  ok(result.text.includes('idle-one'), '列出运行中的环境')
  ok(result.text.includes('已经花掉约'), '给出已花费估算')
  ok(result.text.includes('⚠️'), '闲置的机器被标记告警', result.text)
  ok(result.text.includes('刚活动过，已锁定'), '活跃的机器被标记锁定')
  ok(result.text.includes('省钱顺序'), '给出省钱顺序建议')
  ok(result.text.includes('停机 ≠ 免费'), '说明停机仍收存储费')
  ok(result.text.includes('能本地跑的就别上云'), '给出本地优先的建议')
}

console.log('\n== 预检：create 之前把在烧钱的机器摆出来')
{
  calls.length = 0
  listed = {
    total_count: 1,
    codespaces: [{ name: 'burning', state: 'Available', machine: { name: 'standardLinux32gb' }, created_at: new Date(Date.now() - 5 * 3600000).toISOString(), last_used_at: new Date(Date.now() - 5 * 3600000).toISOString(), idle_timeout_minutes: 30 }],
  }
  const result = await runTool('github-cloud', { action: 'create', repo: 'acme/widget' })
  ok(result.text.includes('预检：当前有 1 个运行中的 Codespace'), '创建前给出预检', result.text.split('\n')[0])
  ok(result.text.includes('burning'), '点名正在烧钱的机器')
  ok(result.text.includes('别让两台一起烧'), '给出明确建议')
  const create = calls.find((call) => call.method === 'POST' && call.url.endsWith('/codespaces'))
  ok(create !== undefined, '确实发起了创建')
  ok(String(create.body).includes('"idle_timeout_minutes":15'), '创建时带上默认空闲超时 15 分钟', String(create.body))
  ok(result.text.includes('空闲自动停止：15 分钟'), '回执里说明会自动停机')
  ok(result.text.includes('不依赖你记得关'), '说明这是不依赖记性的保险')
}

console.log('\n== stop 的安全闸：最近有活动就拒绝')
{
  calls.length = 0
  listed = {
    total_count: 1,
    codespaces: [{ name: 'in-use', state: 'Available', machine: { name: 'basicLinux32gb' }, created_at: new Date(Date.now() - 600000).toISOString(), last_used_at: new Date(Date.now() - 60000).toISOString(), idle_timeout_minutes: 15 }],
  }
  const blocked = await runTool('github-cloud', { action: 'stop', name: 'in-use' })
  ok(blocked.text.includes('没有关机'), '拒绝关机', blocked.text.split('\n')[0])
  ok(blocked.text.includes('正在被使用'), '说明原因')
  ok(blocked.text.includes('force=true'), '给出显式覆盖的办法')
  ok(!calls.some((call) => call.url.includes('/stop')), '确实没有发出 stop 请求')

  calls.length = 0
  const forced = await runTool('github-cloud', { action: 'stop', name: 'in-use', force: true })
  ok(calls.some((call) => call.url.includes('/stop')), 'force=true 时才真的停机')
  ok(forced.text.includes('正在停止') || forced.text.includes('已运行'), '返回停机结果', forced.text.split('\n')[0])
}

console.log('\n== reap：只回收够得上阈值的，且 manual 模式不动手')
{
  calls.length = 0
  listed = {
    total_count: 2,
    codespaces: [
      { name: 'long-idle', state: 'Available', machine: { name: 'standardLinux32gb' }, created_at: new Date(Date.now() - 5 * 3600000).toISOString(), last_used_at: new Date(Date.now() - 4 * 3600000).toISOString(), idle_timeout_minutes: 30 },
      { name: 'fresh', state: 'Available', machine: { name: 'standardLinux32gb' }, created_at: new Date(Date.now() - 600000).toISOString(), last_used_at: new Date(Date.now() - 60000).toISOString(), idle_timeout_minutes: 15 },
    ],
  }
  const dry = await runTool('github-cloud', { action: 'reap', dryRun: true })
  ok(dry.text.includes('（预演）'), '预演模式不实际停机', dry.text.split('\n')[0])
  ok(dry.text.includes('long-idle'), '预演列出会被停的机器')
  ok(!dry.text.includes('fresh　闲置'), '新鲜活动的机器不在回收名单')
  ok(!calls.some((call) => call.url.includes('/stop')), '预演没有发出 stop')

  calls.length = 0
  const real = await runTool('github-cloud', { action: 'reap' })
  ok(calls.filter((call) => call.url.includes('/stop')).length === 1, '实际只停了一台', String(calls.filter((call) => call.url.includes('/stop')).length))
  ok(calls.some((call) => call.url.includes('/user/codespaces/long-idle/stop')), '停的是闲置那台')
  ok(real.text.includes('正在停止 1 个'), '报告停止数量', real.text.split('\n')[0])

  // 切到手动模式：应当完全不动手。
  writeFileSync(join(home, 'github.json'), JSON.stringify({ token: 'ghp_x'.padEnd(40, '0'), login: 'octocat', scopes: ['codespace'], costMode: 'manual' }), 'utf8')
  calls.length = 0
  const manual = await runTool('github-cloud', { action: 'reap' })
  ok(manual.text.includes('手动'), '手动模式明确拒绝', manual.text.split('\n')[0])
  ok(!calls.some((call) => call.url.includes('/stop')), '手动模式一台都不停')
  ok(calls.length === 0, '手动模式连列表都不请求（无谓的 API 调用也省了）', String(calls.length))

  // 切到极致省钱：回收阈值变宽，超出安全窗口的都能回收。
  writeFileSync(join(home, 'github.json'), JSON.stringify({ token: 'ghp_x'.padEnd(40, '0'), login: 'octocat', scopes: ['codespace'], costMode: 'frugal', createIdleTimeout: 10 }), 'utf8')
  calls.length = 0
  listed = {
    total_count: 1,
    codespaces: [{ name: 'mid-idle', state: 'Available', machine: { name: 'basicLinux32gb' }, created_at: new Date(Date.now() - 2 * 3600000).toISOString(), last_used_at: new Date(Date.now() - 50 * 60000).toISOString(), idle_timeout_minutes: 15 }],
  }
  const frugal = await runTool('github-cloud', { action: 'reap' })
  ok(frugal.text.includes('正在停止 1 个'), '极致省钱模式下 50 分钟闲置即可回收', frugal.text.split('\n')[0])
}

console.log('\n== 设置里的空闲超时会用于创建')
{
  calls.length = 0
  listed = { total_count: 0, codespaces: [] }
  const result = await runTool('github-cloud', { action: 'create', repo: 'acme/widget' })
  const create = calls.find((call) => call.method === 'POST' && call.url.endsWith('/codespaces'))
  ok(String(create.body).includes('"idle_timeout_minutes":10'), '用设置里的 10 分钟', String(create.body))
}

console.log(`\n结果：${String(passed)} 通过，${String(failed)} 失败`)
rmSync(home, { recursive: true, force: true })
process.exit(failed === 0 ? 0 : 1)
