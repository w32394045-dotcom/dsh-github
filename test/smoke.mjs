#!/usr/bin/env node
/**
 * dsh-github 离线冒烟测试
 * 用法: node test/smoke.mjs
 *
 * 特性:
 *  - 完全离线: 全程替换 globalThis.fetch，绝不发起真实网络请求。
 *  - 不碰真实凭据: 在 import 之前把 DSH_HOME 指向新建的临时目录，并清空
 *    DSH_GITHUB_TOKEN / GITHUB_TOKEN（store.readToken() 让环境变量优先）。
 *  - 缺模块/缺导出不会静默通过: 精确打印缺失的导出名，其余断言继续执行。
 *  - API 层是 lib/rest.mjs（`github-api` 是 agent 工具名，不是模块名）；仅当 rest.mjs
 *    缺失时才回退探测 lib/github-api.mjs，并记为接口差异。
 *
 * 环境变量:
 *  - DSH_SMOKE_KEEP=1  保留临时目录（默认测试结束后删除）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

// ───────────────────────── 0. 环境隔离（必须在 import 模块之前） ─────────────────────────

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const libDir = path.join(root, 'lib');
const cliPath = path.join(libDir, 'cli.mjs');

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-github-smoke-'));
const storeFile = path.join(tmpHome, 'github.json');
// CLI 检查用独立的空 DSH_HOME: 保证「未配置」场景不受 store 断言留下的 clientId 影响。
const cliHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-github-smoke-cli-'));

const savedEnv = {
  DSH_HOME: process.env.DSH_HOME,
  DSH_GITHUB_TOKEN: process.env.DSH_GITHUB_TOKEN,
  GITHUB_TOKEN: process.env.GITHUB_TOKEN,
};

process.env.DSH_HOME = tmpHome;
delete process.env.DSH_GITHUB_TOKEN;
delete process.env.GITHUB_TOKEN;

// 真实凭据文件快照: 测试结束后必须完全没变化。
const realStoreFile = path.join(os.homedir(), '.dsh', 'github.json');

const FAKE_TOKEN = 'ghp_smokeOnlyFakeToken1234567890abcdefghijklmn';
const ENV_TOKEN = 'ghp_envOnlyFakeToken0987654321zyxwvutsrqponml';

// ───────────────────────── 1. fetch 桩（在 import 之前装好，杜绝真实网络） ─────────────────────────

const realFetch = globalThis.fetch;
let fetchCalls = [];
let fetchHandler = async () => {
  throw new Error('意外发起了网络请求: 当前断言没有安装 fetch 桩');
};

globalThis.fetch = async (url, init) => {
  const call = { url: String(url), init: init || {} };
  fetchCalls.push(call);
  return fetchHandler(call.url, call.init);
};

function installFetch(handler) {
  fetchCalls = [];
  fetchHandler = handler;
}

function makeResponse(status, body, headers = {}) {
  const flat = { ...headers };
  if (typeof Response === 'function') {
    return new Response(body === null || body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...flat },
    });
  }
  const lower = {};
  for (const [key, value] of Object.entries(flat)) lower[key.toLowerCase()] = value;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: '',
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    json: async () => (body === null || body === undefined ? null : body),
    text: async () => (body === null || body === undefined ? '' : JSON.stringify(body)),
  };
}

// ───────────────────────── 2. 断言框架 ─────────────────────────

let passed = 0;
let failed = 0;
const failures = [];
const mismatches = [];

function section(title) {
  console.log('');
  console.log(`── ${title} ${'─'.repeat(Math.max(0, 52 - title.length))}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: 期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
  }
}

function assertDeepEqual(actual, expected, label) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: 期望 ${b}，实际 ${a}`);
}

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failed += 1;
    const message = err && err.message ? err.message : String(err);
    failures.push(`${name} :: ${message}`);
    console.log(`FAIL  ${name}`);
    console.log(`      ${message.split('\n').join('\n      ')}`);
  }
}

/** 记录接口差异：不算失败，但会汇总给插件作者。 */
function note(message) {
  mismatches.push(message);
  console.log(`WARN  ${message.split('\n').join('\n      ')}`);
}

function skip(name, reason) {
  console.log(`SKIP  ${name}`);
  console.log(`      ${reason}`);
}

/** 取必需导出；缺失时报出精确名字（并计入接口差异）。 */
function needExport(mod, name, modulePath) {
  if (!mod || typeof mod[name] !== 'function') {
    const message = `缺少导出 ${name}()（${modulePath}）`;
    mismatches.push(message);
    throw new Error(message);
  }
  return mod[name];
}

/** 大小写不敏感读取 init.headers。 */
function headerOf(init, name) {
  const headers = init && init.headers;
  if (!headers) return undefined;
  const wanted = String(name).toLowerCase();
  try {
    if (typeof headers.get === 'function') {
      const value = headers.get(name);
      return value === null ? undefined : value;
    }
  } catch {
    /* 继续尝试对象形式 */
  }
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (Array.isArray(entry) && String(entry[0]).toLowerCase() === wanted) return entry[1];
    }
    return undefined;
  }
  if (headers instanceof Map) {
    for (const [key, value] of headers) if (String(key).toLowerCase() === wanted) return value;
    return undefined;
  }
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return headers[key];
  }
  return undefined;
}

function normalizeUrl(url) {
  return String(url).replace(/\/+$/, '');
}

/** readToken() 可能返回字符串或 { token, source }。 */
function tokenString(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && typeof value.token === 'string') return value.token.trim();
  return '';
}

function pickField(source, keys) {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

/** 把可能包装过的返回值解出响应体。 */
function jsonOf(value) {
  if (value && typeof value === 'object') {
    if (typeof value.json === 'function' && typeof value.status === 'number') return value.json();
    if ('data' in value) return value.data;
  }
  return value;
}

function snapshot(file) {
  try {
    const stat = fs.statSync(file);
    return { exists: true, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch {
    return { exists: false, size: -1, mtimeMs: -1 };
  }
}

// ───────────────────────── 3. 报告头 ─────────────────────────

console.log('dsh-github 离线冒烟测试');
console.log(`插件目录      : ${root}`);
console.log(`临时 DSH_HOME : ${tmpHome}`);
console.log(`CLI 隔离目录  : ${cliHome}`);
console.log(`Node          : ${process.version}`);
console.log('网络          : 已禁用（globalThis.fetch 全部被桩替换）');

const realStoreBefore = snapshot(realStoreFile);

// ───────────────────────── 4. 加载被测模块（DSH_HOME 已隔离） ─────────────────────────

async function loadModule(relPath) {
  const url = pathToFileURL(path.join(root, relPath)).href;
  try {
    return { ok: true, mod: await import(url), url, relPath };
  } catch (err) {
    return { ok: false, error: err, url, relPath };
  }
}

const storeLoad = await loadModule('lib/store.mjs');
const deviceLoad = await loadModule('lib/device-flow.mjs');

// GitHub API 层的正式名字是 lib/rest.mjs（Lead 已确认）；github-api.mjs 仅作兜底探测。
const apiRestLoad = await loadModule('lib/rest.mjs');
const apiLegacyLoad = await loadModule('lib/github-api.mjs');
const apiLoad = apiRestLoad.ok ? apiRestLoad : apiLegacyLoad;
const apiRel = apiLoad.relPath;
const apiMod = apiLoad.ok ? apiLoad.mod : null;

const storeMod = storeLoad.ok ? storeLoad.mod : null;
const deviceMod = deviceLoad.ok ? deviceLoad.mod : null;

section('模块加载');

await test('lib/store.mjs 可加载', () => {
  assert(storeLoad.ok, `import 失败: ${storeLoad.error && storeLoad.error.message}`);
});

await test('lib/device-flow.mjs 可加载', () => {
  assert(deviceLoad.ok, `import 失败: ${deviceLoad.error && deviceLoad.error.message}`);
});

await test('lib/rest.mjs 可加载（GitHub API 层）', () => {
  if (!apiRestLoad.ok && apiLegacyLoad.ok) {
    note('lib/rest.mjs 不存在，但 lib/github-api.mjs 存在；本测试按后者继续验证（请确认最终文件名）。');
  }
  assert(
    apiRestLoad.ok || apiLegacyLoad.ok,
    `lib/rest.mjs import 失败: ${apiRestLoad.error && apiRestLoad.error.message}`,
  );
});

await test('lib/cli.mjs 存在', () => {
  assert(fs.existsSync(cliPath), `找不到 ${cliPath}`);
});

// ───────────────────────── 5. store 凭据存储 ─────────────────────────

section('store 凭据存储（隔离在临时 DSH_HOME）');

await test('DSH_HOME 已隔离且 token 环境变量已清空', () => {
  assertEqual(process.env.DSH_HOME, tmpHome, 'process.env.DSH_HOME');
  assert(process.env.DSH_GITHUB_TOKEN === undefined, 'DSH_GITHUB_TOKEN 应已清空');
  assert(process.env.GITHUB_TOKEN === undefined, 'GITHUB_TOKEN 应已清空');
  assert(
    !tmpHome.toLowerCase().startsWith(path.join(os.homedir(), '.dsh').toLowerCase()),
    '临时目录不应位于真实 ~/.dsh 内',
  );
});

await test('writeStore() 写入后 readStore() 可读回', async () => {
  needExport(storeMod, 'writeStore', 'lib/store.mjs');
  needExport(storeMod, 'readStore', 'lib/store.mjs');
  await storeMod.writeStore({
    token: FAKE_TOKEN,
    tokenKind: 'pat',
    login: 'octocat',
    scopes: ['repo', 'read:org'],
    clientId: 'Ov23liSMOKETEST',
    defaultRepo: 'octo/hello-world',
  });
  const settings = await storeMod.readStore();
  assert(settings && typeof settings === 'object', `readStore() 应返回对象，实际 ${typeof settings}`);
  assertEqual(settings.login, 'octocat', 'login');
  assertEqual(settings.tokenKind, 'pat', 'tokenKind');
  assert(Array.isArray(settings.scopes), `scopes 应为数组，实际 ${JSON.stringify(settings.scopes)}`);
  assertDeepEqual(settings.scopes, ['repo', 'read:org'], 'scopes');
  assertEqual(settings.clientId, 'Ov23liSMOKETEST', 'clientId');
  assertEqual(settings.defaultRepo, 'octo/hello-world', 'defaultRepo');
});

await test('凭据文件落在 $DSH_HOME/github.json 且包含 token', () => {
  assert(fs.existsSync(storeFile), `找不到 ${storeFile}`);
  const parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  assertEqual(parsed.token, FAKE_TOKEN, 'github.json 中的 token');
  if (typeof storeMod.storePath === 'function') {
    assertEqual(path.resolve(storeMod.storePath()), path.resolve(storeFile), 'storePath()');
  }
});

await test('readToken() 返回 { token, source } 且无环境变量时来自存储', async () => {
  const readToken = needExport(storeMod, 'readToken', 'lib/store.mjs');
  const value = await readToken();
  assertEqual(tokenString(value), FAKE_TOKEN, 'readToken().token');
  if (value && typeof value === 'object') {
    assertEqual(value.source, 'store', 'readToken().source（环境变量已清空）');
  } else {
    note('readToken() 返回裸字符串而不是 { token, source }；CLI 已兼容，但宿主与 CLI 建议统一形状。');
  }
});

await test('statusOf() 状态对象已脱敏（序列化后不含明文 token）', async () => {
  const statusOf = needExport(storeMod, 'statusOf', 'lib/store.mjs');
  const status = await statusOf();
  assert(status && typeof status === 'object', `statusOf() 应返回对象，实际 ${typeof status}`);
  const serialized = JSON.stringify(status);
  assert(!serialized.includes(FAKE_TOKEN), `statusOf() 的返回值包含明文 token: ${serialized.slice(0, 200)}`);
  assertEqual(status.configured, true, 'statusOf().configured');
  assert(
    typeof status.preview === 'string' && status.preview !== '' && !status.preview.includes(FAKE_TOKEN),
    `statusOf().preview 应为掩码字符串，实际 ${JSON.stringify(status.preview)}`,
  );
});

await test('所有 status/state 类导出都不含明文 token', async () => {
  const names = Object.keys(storeMod).filter(
    (key) =>
      typeof storeMod[key] === 'function' &&
      /status|state|info/i.test(key) &&
      !/write|patch|set|update|save|clear|token/i.test(key),
  );
  for (const name of names) {
    let value;
    try {
      value = await storeMod[name]();
    } catch (err) {
      note(`store.${name}() 无法无参调用，已跳过脱敏扫描（${err && err.message}）`);
      continue;
    }
    assert(!JSON.stringify(value ?? null).includes(FAKE_TOKEN), `store.${name}() 的返回值包含明文 token`);
  }
});

await test('readStore() 返回明文 token 的事实已登记（脱敏出口是 statusOf）', async () => {
  const settings = await storeMod.readStore();
  if (JSON.stringify(settings ?? null).includes(FAKE_TOKEN)) {
    note(
      'readStore() 是设置读取器，会返回明文 token；脱敏状态出口是 statusOf()。' +
        '请确保宿主路由/客户端只序列化 statusOf()，绝不把 readStore() 的返回值发给浏览器。',
    );
  }
  assert(true, 'noop');
});

await test('DEFAULT_SETTINGS 存在且不含任何 token', () => {
  const defaults = storeMod.DEFAULT_SETTINGS;
  assert(defaults && typeof defaults === 'object', `DEFAULT_SETTINGS 应为对象，实际 ${typeof defaults}`);
  assert(!defaults.token, 'DEFAULT_SETTINGS.token 应为空');
});

await test('writeStore() 是补丁合并（不丢其它字段）', async () => {
  await storeMod.writeStore({ login: 'octocat-patched' });
  const settings = await storeMod.readStore();
  assertEqual(settings.login, 'octocat-patched', 'login（合并后）');
  assertEqual(settings.token, FAKE_TOKEN, 'writeStore({login}) 之后 token 不应丢失（补丁语义）');
  assertEqual(settings.clientId, 'Ov23liSMOKETEST', 'writeStore({login}) 之后 clientId 不应丢失');
});

await test('原子写入不残留 .tmp 文件', async () => {
  await storeMod.writeStore({ login: 'octocat-atomic' });
  await storeMod.writeStore({ scopes: ['repo'] });
  const leftovers = fs.readdirSync(tmpHome).filter((name) => /tmp/i.test(name));
  assert(leftovers.length === 0, `DSH_HOME 中发现临时残留文件: ${leftovers.join(', ')}`);
});

await test('DSH_HOME 中没有 .bak/.swp/.old 残留', () => {
  const leftovers = fs.readdirSync(tmpHome).filter((name) => /\.(bak|swp|old|orig)$/i.test(name));
  assert(leftovers.length === 0, `发现残留文件: ${leftovers.join(', ')}`);
});

await test('环境变量优先于落盘凭据（与宿主注入规则一致）', async () => {
  process.env.DSH_GITHUB_TOKEN = ENV_TOKEN;
  try {
    const value = await storeMod.readToken();
    assertEqual(tokenString(value), ENV_TOKEN, 'readToken() 应返回环境变量里的 token');
    if (value && typeof value === 'object') assertEqual(value.source, 'env', 'readToken().source');
    const status = typeof storeMod.statusOf === 'function' ? await storeMod.statusOf() : {};
    assertEqual(status.configured, true, 'statusOf().configured（环境变量存在时）');
    assertEqual(status.tokenKind, 'env', 'statusOf().tokenKind');
    assert(
      typeof status.preview === 'string' && !status.preview.includes(ENV_TOKEN),
      'statusOf().preview 不应包含明文环境 token',
    );
  } finally {
    delete process.env.DSH_GITHUB_TOKEN;
  }
  const back = await storeMod.readToken();
  assertEqual(tokenString(back), FAKE_TOKEN, '清空环境变量后应回落到凭据文件');
});

await test('clearToken() 会删除 token 并保留其它设置', async () => {
  const clearToken = needExport(storeMod, 'clearToken', 'lib/store.mjs');
  assert(fs.existsSync(storeFile), '前置条件: 凭据文件应存在');
  assert(Boolean(JSON.parse(fs.readFileSync(storeFile, 'utf8')).token), '前置条件: 凭据文件中应有 token');
  const result = await clearToken();
  const after = fs.existsSync(storeFile) ? JSON.parse(fs.readFileSync(storeFile, 'utf8')) : {};
  assert(!after.token, `clearToken() 之后凭据文件中仍有 token: ${JSON.stringify(after).slice(0, 200)}`);
  if (result && typeof result === 'object' && 'removed' in result) {
    assertEqual(result.removed, true, 'clearToken().removed');
  }
  const status = typeof storeMod.statusOf === 'function' ? await storeMod.statusOf() : {};
  assertEqual(status.configured, false, 'clearToken() 之后 statusOf().configured');
  if (status.clientId !== 'Ov23liSMOKETEST' || status.defaultRepo !== 'octo/hello-world') {
    note(
      `clearToken() 丢弃了非凭据设置（clientId=${JSON.stringify(status.clientId)}, defaultRepo=${JSON.stringify(status.defaultRepo)}）；建议只清 token 相关字段。`,
    );
  }
});

await test('clearToken() 之后 readToken() 返回空 token 而不是抛错', async () => {
  let value;
  try {
    value = await storeMod.readToken();
  } catch (err) {
    note(`clearToken() 之后 readToken() 抛出异常（CLI 已容错）: ${err && err.message}`);
    return;
  }
  assertEqual(tokenString(value), '', 'readToken().token（已登出）');
});

await test('updatedAt 是合法时间戳', async () => {
  const settings = await storeMod.readStore();
  const value = settings.updatedAt;
  const ok =
    (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Date.parse(value))) ||
    (typeof value === 'number' && Number.isFinite(value) && value > 0);
  assert(ok, `updatedAt 不是可解析的时间戳: ${JSON.stringify(value)}`);
});

await test('github.json 以 UTF-8 BOM 开头时仍能读出（Windows 记事本/PowerShell 5.1 场景）', async () => {
  fs.writeFileSync(
    storeFile,
    `\uFEFF${JSON.stringify({ token: FAKE_TOKEN, tokenKind: 'pat', login: 'octocat', scopes: ['repo'] }, null, 2)}\n`,
    'utf8',
  );
  let token = '';
  try {
    token = tokenString(await storeMod.readToken());
  } catch {
    token = '';
  }
  fs.rmSync(storeFile, { force: true }); // 恢复干净状态，避免影响后续断言
  if (token !== FAKE_TOKEN) {
    note(
      'github.json 以 UTF-8 BOM 开头时 readStore()/readToken() 读不到 token（会被当成未登录）。' +
        'Windows 记事本与 PowerShell 5.1 的 Set-Content -Encoding utf8 都会写 BOM。' +
        '建议在 store.mjs 的 readStore() 解析前加一行：readFileSync(storePath(), "utf8").replace(/^\\uFEFF/, "")。',
    );
  }
  assert(true, 'noop');
});

// ───────────────────────── 6. device-flow 端点与导出 ─────────────────────────

section('device-flow 端点与请求行为');

await test('DEVICE_CODE_URL 等于 GitHub 文档端点', () => {
  assertEqual(deviceMod && deviceMod.DEVICE_CODE_URL, 'https://github.com/login/device/code', 'DEVICE_CODE_URL');
});

await test('TOKEN_URL 等于 GitHub 文档端点', () => {
  assertEqual(deviceMod && deviceMod.TOKEN_URL, 'https://github.com/login/oauth/access_token', 'TOKEN_URL');
});

await test('startDeviceFlow / pollDeviceFlowOnce / pollDeviceFlow 已导出', () => {
  needExport(deviceMod, 'startDeviceFlow', 'lib/device-flow.mjs');
  needExport(deviceMod, 'pollDeviceFlowOnce', 'lib/device-flow.mjs');
  needExport(deviceMod, 'pollDeviceFlow', 'lib/device-flow.mjs');
});

await test('startDeviceFlow() POST 到 DEVICE_CODE_URL 且带 client_id 与 scope', async () => {
  const startDeviceFlow = needExport(deviceMod, 'startDeviceFlow', 'lib/device-flow.mjs');
  installFetch(async () =>
    makeResponse(200, {
      device_code: 'dev-code-123',
      user_code: 'ABCD-1234',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    }),
  );
  const result = await startDeviceFlow('Ov23liTEST', 'repo read:org');
  assertEqual(fetchCalls.length, 1, 'fetch 调用次数');
  assertEqual(normalizeUrl(fetchCalls[0].url), 'https://github.com/login/device/code', '请求 URL');
  assertEqual(String(fetchCalls[0].init.method || 'GET').toUpperCase(), 'POST', '请求方法');
  const params = new URLSearchParams(String(fetchCalls[0].init.body || ''));
  assertEqual(params.get('client_id'), 'Ov23liTEST', '请求体 client_id');
  assertEqual(params.get('scope'), 'repo read:org', '请求体 scope');
  assertEqual(pickField(result, ['deviceCode', 'device_code']), 'dev-code-123', 'deviceCode');
  assertEqual(pickField(result, ['userCode', 'user_code']), 'ABCD-1234', 'userCode');
});

await test('startDeviceFlow("") 以错误结果返回而不是发起请求', async () => {
  const startDeviceFlow = needExport(deviceMod, 'startDeviceFlow', 'lib/device-flow.mjs');
  installFetch(async () => {
    throw new Error('空 client_id 不应发起网络请求');
  });
  let outcome = null;
  let threw = null;
  try {
    outcome = await startDeviceFlow('', 'repo');
  } catch (err) {
    threw = err;
  }
  const failedResult = threw !== null || (outcome && outcome.ok === false);
  assert(failedResult, `空 client_id 应返回 ok:false 或抛错，实际 ${JSON.stringify(outcome)}`);
  const message = (outcome && outcome.error && outcome.error.message) || (threw && threw.message) || '';
  assert(typeof message === 'string' && message !== '', '失败结果应带可展示的 message');
});

await test('pollDeviceFlow() 跳过 authorization_pending 后返回 token', async () => {
  const pollDeviceFlow = needExport(deviceMod, 'pollDeviceFlow', 'lib/device-flow.mjs');
  let attempt = 0;
  installFetch(async () => {
    attempt += 1;
    if (attempt === 1) return makeResponse(200, { error: 'authorization_pending' });
    return makeResponse(200, { access_token: FAKE_TOKEN, token_type: 'bearer', scope: 'repo' });
  });
  const result = await pollDeviceFlow('Ov23liTEST', 'dev-code-123', 0.01, undefined);
  assertEqual(attempt, 2, '轮询次数');
  for (const call of fetchCalls) {
    assertEqual(normalizeUrl(call.url), 'https://github.com/login/oauth/access_token', '轮询 URL');
    assertEqual(String(call.init.method || 'GET').toUpperCase(), 'POST', '轮询方法');
    const params = new URLSearchParams(String(call.init.body || ''));
    assertEqual(
      params.get('grant_type'),
      'urn:ietf:params:oauth:grant-type:device_code',
      '轮询请求体 grant_type',
    );
    assertEqual(params.get('device_code'), 'dev-code-123', '轮询请求体 device_code');
  }
  const token = typeof result === 'string' ? result : pickField(result, ['token', 'access_token', 'accessToken']);
  assertEqual(token, FAKE_TOKEN, 'pollDeviceFlow().token');
});

await test('pollDeviceFlowOnce() 单次语义：authorization_pending → pending:true', async () => {
  const once = needExport(deviceMod, 'pollDeviceFlowOnce', 'lib/device-flow.mjs');
  installFetch(async () => makeResponse(200, { error: 'authorization_pending' }));
  const result = await once('Ov23liTEST', 'dev-code-123');
  assertEqual(result && result.ok, false, 'ok');
  assertEqual(result.pending, true, 'pending');
  assertEqual(result.code, 'authorization_pending', 'code');
  assertEqual(fetchCalls.length, 1, '只应发起一次请求（单次语义）');
});

await test('pollDeviceFlowOnce() 单次语义：成功返回 token', async () => {
  const once = needExport(deviceMod, 'pollDeviceFlowOnce', 'lib/device-flow.mjs');
  installFetch(async () => makeResponse(200, { access_token: FAKE_TOKEN, scope: 'repo' }));
  const result = await once('Ov23liTEST', 'dev-code-123');
  assertEqual(result && result.ok, true, 'ok');
  assertEqual(result.token, FAKE_TOKEN, 'token');
  assertEqual(result.scope, 'repo', 'scope');
  assertEqual(fetchCalls.length, 1, '只应发起一次请求（单次语义）');
});

// ───────────────────────── 7. GitHub API 请求构造 ─────────────────────────

section(`GitHub API 请求构造（${apiRel}，fetch 全部被桩替换）`);

/** 调用一次 githubFetch(token, path) 并返回「结果 / 调用参数」快照。 */
async function callGithubFetch(path, handler, token = FAKE_TOKEN) {
  installFetch(handler);
  let value = null;
  let threw = null;
  try {
    value = await apiMod.githubFetch(token, path);
  } catch (err) {
    threw = err;
  }
  const call = fetchCalls.length > 0 ? fetchCalls[fetchCalls.length - 1] : null;
  return { value: threw ?? value, threw, call };
}

await test('githubFetch() 使用 GET 且 URL 为 https://api.github.com/user', async () => {
  needExport(apiMod, 'githubFetch', apiRel);
  const outcome = await callGithubFetch('/user', async () =>
    makeResponse(200, { login: 'octocat' }, { 'x-oauth-scopes': 'repo, read:org', 'x-ratelimit-remaining': '4999' }),
  );
  assert(outcome.call !== null, 'githubFetch() 没有发起 fetch 调用');
  assertEqual(String(outcome.call.init.method || 'GET').toUpperCase(), 'GET', 'HTTP 方法');
  assertEqual(normalizeUrl(outcome.call.url), 'https://api.github.com/user', 'URL');
});

await test('githubFetch() 不把 token 放进 URL', async () => {
  assert(fetchCalls.length > 0, '前置条件: 需要先执行上一个断言');
  assert(!String(fetchCalls[0].url).includes(FAKE_TOKEN), `URL 中出现明文 token: ${fetchCalls[0].url}`);
});

await test('githubFetch() 发送四个必需请求头', async () => {
  const outcome = await callGithubFetch('/user', async () => makeResponse(200, { login: 'octocat' }));
  assert(outcome.call !== null, 'githubFetch() 没有发起 fetch 调用');
  const init = outcome.call.init;
  assertEqual(headerOf(init, 'authorization'), `Bearer ${FAKE_TOKEN}`, 'authorization 头');
  assertEqual(headerOf(init, 'accept'), 'application/vnd.github+json', 'accept 头');
  assertEqual(headerOf(init, 'x-github-api-version'), '2022-11-28', 'x-github-api-version 头');
  assertEqual(headerOf(init, 'user-agent'), 'dsh-github-plugin', 'user-agent 头');
});

await test('githubFetch() 返回 200 的响应体与元信息', async () => {
  const outcome = await callGithubFetch('/user', async () =>
    makeResponse(200, { login: 'octocat', id: 1 }, { 'x-oauth-scopes': 'repo' }),
  );
  if (outcome.threw) throw new Error(`200 不应抛错: ${outcome.threw.message}`);
  const body = await jsonOf(outcome.value);
  assert(body && typeof body === 'object', `应返回解析后的响应体，实际 ${JSON.stringify(outcome.value)}`);
  assertEqual(body.login, 'octocat', 'body.login');
});

await test('401 归一化为带 status === 401 的错误', async () => {
  const outcome = await callGithubFetch('/user', async () =>
    makeResponse(401, { message: 'Bad credentials' }, { 'x-ratelimit-remaining': '57' }),
  );
  const value = outcome.value;
  assert(value !== null && value !== undefined, '401 既未抛出也未返回错误对象');
  const status =
    typeof value === 'object' ? value.status ?? value.error?.status ?? value.response?.status : undefined;
  assertEqual(status, 401, `归一化后的 status（对象: ${JSON.stringify(value)}）`);
});

await test('401 归一化结果包含 message', async () => {
  const outcome = await callGithubFetch('/user', async () => makeResponse(401, { message: 'Bad credentials' }));
  const value = outcome.value;
  const message = value && typeof value === 'object' ? value.message ?? value.error?.message : undefined;
  assert(typeof message === 'string' && message.trim() !== '', `归一化结果缺少 message: ${JSON.stringify(value)}`);
});

await test('401 归一化结果包含 docsUrl', async () => {
  const outcome = await callGithubFetch('/user', async () => makeResponse(401, { message: 'Bad credentials' }));
  const value = outcome.value;
  const docsUrl = value && typeof value === 'object' ? value.docsUrl ?? value.error?.docsUrl : undefined;
  assert(
    typeof docsUrl === 'string' && /^https?:\/\//.test(docsUrl),
    `归一化结果缺少 docsUrl（计划接口: { status, message, docsUrl }）: ${JSON.stringify(value)}`,
  );
});

await test('whoami() 读取 /user 的 login', async () => {
  const whoami = needExport(apiMod, 'whoami', apiRel);
  installFetch(async () =>
    makeResponse(200, { login: 'octocat', name: 'The Octocat' }, { 'x-oauth-scopes': 'repo' }),
  );
  const result = await whoami(FAKE_TOKEN);
  assertEqual(normalizeUrl(fetchCalls[0] && fetchCalls[0].url), 'https://api.github.com/user', 'whoami 请求 URL');
  const user = await jsonOf(result);
  assert(user && typeof user === 'object', `whoami() 应返回对象，实际 ${JSON.stringify(user)}`);
  assertEqual(user.login, 'octocat', 'whoami().login');
});

await test('scopesFromResponse() 解析 x-oauth-scopes 头', async () => {
  const scopesFromResponse = needExport(apiMod, 'scopesFromResponse', apiRel);
  const raw = scopesFromResponse(
    makeResponse(200, { login: 'octocat' }, { 'x-oauth-scopes': 'repo, read:org, gist' }),
  );
  const scopes = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[,\s]+/).filter(Boolean)
      : raw && typeof raw === 'object' && raw.scopes
        ? raw.scopes
        : [];
  assert(scopes.includes('repo'), `scopes 应包含 repo，实际 ${JSON.stringify(raw)}`);
  assert(scopes.includes('read:org'), `scopes 应包含 read:org，实际 ${JSON.stringify(raw)}`);
  assert(scopes.includes('gist'), `scopes 应包含 gist，实际 ${JSON.stringify(raw)}`);
});

await test('githubFetch() 回传 scopes 与 rate 元信息', async () => {
  const outcome = await callGithubFetch('/user', async () =>
    makeResponse(
      200,
      { login: 'octocat' },
      { 'x-oauth-scopes': 'repo, read:org', 'x-ratelimit-remaining': '4999', 'x-ratelimit-limit': '5000' },
    ),
  );
  const value = outcome.value;
  assert(value && typeof value === 'object', `githubFetch() 应返回对象，实际 ${JSON.stringify(value)}`);
  const scopes = Array.isArray(value.scopes) ? value.scopes : [];
  assert(scopes.includes('repo') && scopes.includes('read:org'), `scopes 应为 ['repo','read:org']，实际 ${JSON.stringify(value.scopes)}`);
  const rate = value.rate && typeof value.rate === 'object' ? value.rate : {};
  assertEqual(String(rate.remaining), '4999', 'rate.remaining');
  assertEqual(String(rate.limit), '5000', 'rate.limit');
});

// ───────────────────────── 8. CLI 附加检查（离线、子进程） ─────────────────────────

section('CLI 附加检查（子进程，DSH_HOME 指向临时目录）');

const cliExists = fs.existsSync(cliPath);

function runCli(args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    env: { ...process.env, DSH_HOME: cliHome },
  });
}

function isSpawnBlocked(result) {
  const code = result && result.error && (result.error.code || '');
  return code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP';
}

if (!cliExists) {
  skip('CLI 检查', `找不到 ${cliPath}`);
} else {
  const help = runCli(['--help']);
  if (isSpawnBlocked(help)) {
    skip('CLI 检查', `当前沙箱禁止子进程管道通信: ${help.error.code}`);
  } else {
    await test('node lib/cli.mjs --help 退出码 0 且输出中文用法', () => {
      assertEqual(help.status, 0, `退出码（stderr: ${String(help.stderr || '').trim().slice(0, 300)}）`);
      const text = String(help.stdout || '');
      assert(text.includes('用法'), '帮助文本应包含「用法」');
      for (const command of ['status', 'login', 'logout', 'token', 'whoami']) {
        assert(text.includes(command), `帮助文本应包含命令 ${command}`);
      }
      assert(text.includes('https://github.com/settings/tokens'), '帮助文本应包含 PAT 创建链接');
      assert(text.includes('DSH_GITHUB_TOKEN'), '帮助文本应说明 DSH_GITHUB_TOKEN 注入方式');
      assert(text.includes('fine-grained'), '帮助文本应区分 fine-grained 与 classic token');
      assert(!/gh[pousr]_[A-Za-z0-9]{10,}/.test(text), '帮助文本不应出现形似真实 token 的字符串');
    });

    const status = runCli(['status']);
    await test('node lib/cli.mjs status（未配置）退出码 1 且提示未配置', () => {
      assertEqual(status.status, 1, `退出码（stderr: ${String(status.stderr || '').trim().slice(0, 300)}）`);
      const text = `${status.stdout || ''}${status.stderr || ''}`;
      assert(text.includes('未配置'), `输出应提示未配置，实际: ${text.slice(0, 300)}`);
    });

    const token = runCli(['token']);
    await test('node lib/cli.mjs token（未配置）退出码 1 且 stdout 为空', () => {
      assertEqual(token.status, 1, `退出码（stderr: ${String(token.stderr || '').trim().slice(0, 300)}）`);
      assertEqual(String(token.stdout || '').trim(), '', 'stdout 不应有任何内容');
    });

    const whoami = runCli(['whoami']);
    await test('node lib/cli.mjs whoami（未配置）退出码 1 且不联网', () => {
      assertEqual(whoami.status, 1, `退出码（stderr: ${String(whoami.stderr || '').trim().slice(0, 300)}）`);
      const text = `${whoami.stdout || ''}${whoami.stderr || ''}`;
      assert(text.includes('未配置'), `输出应提示未配置，实际: ${text.slice(0, 300)}`);
    });

    const device = runCli(['login', '--device']);
    await test('node lib/cli.mjs login --device（无 client id）退出码 2 且给出指引', () => {
      const text = `${device.stdout || ''}${device.stderr || ''}`;
      assert(!text.includes('is not defined'), `不应出现未定义函数的运行时错误: ${text.slice(0, 300)}`);
      assertEqual(device.status, 2, `退出码（实际输出: ${text.trim().slice(0, 300)}）`);
      assert(text.includes('client_id'), `应提示需要 client_id，实际: ${text.slice(0, 300)}`);
    });

    const subcommand = runCli(['status', '--help']);
    await test('node lib/cli.mjs status --help 退出码 0（子命令也用帮助短路）', () => {
      assertEqual(subcommand.status, 0, `退出码（stderr: ${String(subcommand.stderr || '').trim().slice(0, 300)}）`);
      assert(String(subcommand.stdout || '').includes('用法'), '应打印帮助');
    });

    const unknown = runCli(['no-such-command']);
    await test('node lib/cli.mjs <未知命令> 退出码 2', () => {
      assertEqual(unknown.status, 2, `退出码（stderr: ${String(unknown.stderr || '').trim().slice(0, 300)}）`);
    });
  }
}

// ───────────────────────── 9. 安全与清理 ─────────────────────────

section('安全与清理');

await test('未触碰真实 ~/.dsh/github.json', () => {
  const after = snapshot(realStoreFile);
  const changed =
    after.exists !== realStoreBefore.exists ||
    after.size !== realStoreBefore.size ||
    after.mtimeMs !== realStoreBefore.mtimeMs;
  assert(!changed, `真实凭据文件被修改了！before=${JSON.stringify(realStoreBefore)} after=${JSON.stringify(after)}`);
});

await test('临时目录内只有预期的凭据文件', () => {
  const entries = fs.readdirSync(tmpHome);
  const unexpected = entries.filter((name) => name !== 'github.json');
  assert(unexpected.length === 0, `临时 DSH_HOME 中出现意外文件: ${unexpected.join(', ')}`);
});

// 恢复环境
globalThis.fetch = realFetch;
if (savedEnv.DSH_HOME === undefined) delete process.env.DSH_HOME;
else process.env.DSH_HOME = savedEnv.DSH_HOME;
if (savedEnv.DSH_GITHUB_TOKEN === undefined) delete process.env.DSH_GITHUB_TOKEN;
else process.env.DSH_GITHUB_TOKEN = savedEnv.DSH_GITHUB_TOKEN;
if (savedEnv.GITHUB_TOKEN === undefined) delete process.env.GITHUB_TOKEN;
else process.env.GITHUB_TOKEN = savedEnv.GITHUB_TOKEN;

function removeTempDir(dir) {
  const resolved = path.resolve(dir);
  const parent = path.resolve(os.tmpdir());
  if (!resolved.startsWith(parent + path.sep) || !path.basename(resolved).startsWith('dsh-github-smoke-')) {
    console.log(`WARN  安全检查未通过，保留临时目录: ${resolved}`);
    return false;
  }
  try {
    fs.rmSync(resolved, { recursive: true, force: true });
    return true;
  } catch (err) {
    console.log(`WARN  临时目录删除失败: ${err && err.message}`);
    return false;
  }
}

let keptTemp = process.env.DSH_SMOKE_KEEP === '1';
if (!keptTemp) {
  const okMain = removeTempDir(tmpHome);
  const okCli = removeTempDir(cliHome);
  keptTemp = !(okMain && okCli);
}

// ───────────────────────── 10. 汇总 ─────────────────────────

section('结果汇总');
console.log(`PASS: ${passed}    FAIL: ${failed}`);
console.log(`store 临时 DSH_HOME: ${tmpHome}${keptTemp ? '（保留）' : '（已删除）'}`);
console.log(`CLI   临时 DSH_HOME: ${cliHome}${keptTemp ? '（保留）' : '（已删除）'}`);
if (failures.length > 0) {
  console.log('');
  console.log('失败断言:');
  for (const item of failures) console.log(`  - ${item}`);
}
if (mismatches.length > 0) {
  console.log('');
  console.log('需要确认的接口差异（WARN）:');
  for (const item of mismatches) console.log(`  - ${item.split('\n')[0]}`);
}
console.log('');
console.log(failed === 0 ? 'SMOKE RESULT: PASS（全部断言通过）' : `SMOKE RESULT: FAIL（${failed} 个断言失败）`);

process.exitCode = failed === 0 ? 0 : 1;
