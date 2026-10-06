#!/usr/bin/env node
/**
 * dsh-github CLI —— DSH GitHub 插件的纯 token 命令行工具。
 *
 * 设计约束：
 *  - 零第三方依赖，只用 Node 内置模块；ESM；可在任意 cwd 下运行。
 *  - 凭据只有一个来源：lib/store.mjs 管理的 $DSH_HOME/github.json。
 *  - API 只有一个来源：lib/rest.mjs 的 githubFetch()（与宿主路由、agent 工具同一套
 *    头与错误归一化）；rest.mjs 缺失时退化为内置 fetch，并在 stderr 提示。
 *  - 生效 token 的优先级与宿主完全一致：readToken() 先看环境变量
 *    （DSH_GITHUB_TOKEN / GITHUB_TOKEN），再看落盘凭据。
 *  - 除 `token` 子命令外，任何输出都不得包含明文 token。
 *
 * 用法: dsh-github <命令> [选项]   或   node lib/cli.mjs <命令> [选项]
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import * as readline from 'node:readline';

const VERSION = '0.1.0';
const API_BASE = 'https://api.github.com';
const USER_AGENT = 'dsh-github-plugin';
const API_VERSION = '2022-11-28';
const ACCEPT = 'application/vnd.github+json';
const PAT_URL = 'https://github.com/settings/tokens';
const DEVICE_URL_FALLBACK = 'https://github.com/login/device';
const DEFAULT_DEVICE_SCOPE = 'repo read:org workflow gist';
const HTTP_TIMEOUT_MS = 15000;

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

/** 带退出码的命令行错误。 */
class CliError extends Error {
  constructor(message, code = EXIT_FAIL) {
    super(message);
    this.name = 'CliError';
    this.code = code;
  }
}

// ─────────────────────────── 基础输出 ───────────────────────────

/** 标准输出一行（人类可读信息只走 stdout）。 */
function out(line = '') {
  process.stdout.write(`${line}\n`);
}

/** 标准错误一行（警告 / 诊断）。 */
function warn(line) {
  process.stderr.write(`${line}\n`);
}

/** 中日韩字符按 2 列宽度计算，保证表格对齐。 */
function displayWidth(value) {
  let width = 0;
  for (const ch of String(value)) {
    const cp = ch.codePointAt(0);
    const wide =
      cp >= 0x1100 &&
      (cp <= 0x115f ||
        cp === 0x2329 ||
        cp === 0x232a ||
        (cp >= 0x2e80 && cp <= 0xa4cf) ||
        (cp >= 0xac00 && cp <= 0xd7a3) ||
        (cp >= 0xf900 && cp <= 0xfaff) ||
        (cp >= 0xfe30 && cp <= 0xfe6f) ||
        (cp >= 0xff00 && cp <= 0xff60) ||
        (cp >= 0xffe0 && cp <= 0xffe6) ||
        (cp >= 0x20000 && cp <= 0x3fffd));
    width += wide ? 2 : 1;
  }
  return width;
}

function padRight(value, width) {
  const text = String(value);
  return text + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

const LABEL_WIDTH = 12;

/** 打印 "标签   值" 形式的一行。 */
function row(label, value) {
  out(`${padRight(label, LABEL_WIDTH)}${value === undefined || value === null ? '' : value}`);
}

function heading(title) {
  out('');
  out(title);
  out('─'.repeat(46));
}

// ─────────────────────────── 小工具 ───────────────────────────

/** DSH 主目录：$DSH_HOME，否则 ~/.dsh。 */
function dshHome() {
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return path.resolve(fromEnv.trim());
  return path.join(os.homedir(), '.dsh');
}

/** 凭据文件位置：优先 store.mjs 自己导出的路径，否则按约定推导。 */
function storeFilePath(storeMod) {
  for (const key of ['STORE_PATH', 'STORE_FILE', 'CREDENTIALS_PATH']) {
    const value = storeMod ? storeMod[key] : undefined;
    if (typeof value === 'string' && value.trim() !== '') return path.resolve(value);
  }
  if (storeMod && typeof storeMod.statusOf === 'function') {
    try {
      const viaStatus = storeMod.statusOf();
      if (viaStatus && typeof viaStatus.storeFile === 'string' && viaStatus.storeFile.trim() !== '') {
        return path.resolve(viaStatus.storeFile);
      }
    } catch {
      /* 继续尝试别的导出 */
    }
  }
  for (const fn of ['storePath', 'storeFilePath']) {
    if (storeMod && typeof storeMod[fn] === 'function') {
      try {
        const value = storeMod[fn]();
        if (typeof value === 'string' && value.trim() !== '') return path.resolve(value);
      } catch {
        /* 继续 */
      }
    }
  }
  return path.join(dshHome(), 'github.json');
}

/** 只显示前 4 + 后 4 个字符的掩码预览。 */
function maskToken(token) {
  const text = String(token || '');
  if (text === '') return '(无)';
  if (text.length <= 12) return '*'.repeat(text.length);
  return `${text.slice(0, 4)}${'*'.repeat(Math.min(text.length - 8, 16))}${text.slice(-4)}`;
}

function parseScopes(raw) {
  if (Array.isArray(raw)) return raw.filter((s) => typeof s === 'string' && s.trim() !== '');
  return String(raw || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 大小写不敏感地读取响应头。 */
function headerOf(res, name) {
  if (!res || !res.headers) return '';
  const headers = res.headers;
  try {
    if (typeof headers.get === 'function') return headers.get(name) || '';
  } catch {
    /* 继续尝试对象形式 */
  }
  const wanted = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === wanted) return String(headers[key] ?? '');
  }
  return '';
}

function isTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return true;
  if (typeof value === 'string' && value.trim() !== '') return !Number.isNaN(Date.parse(value));
  return false;
}

/** 从对象里按候选字段名取值（容忍返回值的命名差异）。 */
function pick(source, keys) {
  if (!source || typeof source !== 'object') return undefined;
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

/** readToken() 可能返回字符串，也可能返回 { token, source }。 */
function tokenString(value) {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object' && typeof value.token === 'string') return value.token.trim();
  return '';
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// ─────────────────────── 模块加载（宿主半边接口） ───────────────────────

let storeModPromise = null;

async function loadStore() {
  if (!storeModPromise) {
    storeModPromise = import('./store.mjs').catch((err) => {
      throw new CliError(
        `无法加载 lib/store.mjs：${err && err.message ? err.message : err}\n` +
          '  该文件由插件宿主部分提供，请确认插件已完整安装（node test/smoke.mjs 可检查接口）。',
        EXIT_USAGE,
      );
    });
  }
  return storeModPromise;
}

/** 校验 store.mjs 的必需导出，缺失时精确报出名字。 */
async function requireStore(exports) {
  const storeMod = await loadStore();
  const missing = exports.filter((name) => typeof storeMod[name] !== 'function');
  if (missing.length > 0) {
    throw new CliError(
      `lib/store.mjs 缺少导出：${missing.map((n) => `${n}()`).join('、')}\n` +
        '  计划接口：readStore() / readToken() / writeStore(patch) / clearToken() / DEFAULT_SETTINGS。',
      EXIT_USAGE,
    );
  }
  return storeMod;
}

/**
 * 取「当前生效」的 token —— 与宿主注入 shell 环境时用的是同一条路径：
 * store.readToken() 先看 DSH_GITHUB_TOKEN / GITHUB_TOKEN，再看落盘凭据。
 * @returns {Promise<{ token: string, source: 'env'|'store'|'none' }>}
 */
async function readEffectiveToken(storeMod) {
  if (typeof storeMod.readToken !== 'function') {
    throw new CliError(
      'lib/store.mjs 未导出 readToken()，无法在不读取状态对象的前提下取得凭据。\n' +
        '  计划接口要求：readToken(): { token, source }（readStore() 面向设置读取，statusOf() 面向展示）。',
      EXIT_USAGE,
    );
  }
  let value;
  try {
    value = await storeMod.readToken();
  } catch {
    // 文件缺失或刚被 logout 清空时允许抛错，等价于「没有凭据」。
    return { token: '', source: 'none' };
  }
  const token = tokenString(value);
  const source =
    value && typeof value === 'object' && typeof value.source === 'string'
      ? value.source
      : token === ''
        ? 'none'
        : 'store';
  return { token, source };
}

let restModPromise = null;
let restWarned = false;

/** 加载 lib/rest.mjs；缺失时返回 null（调用方退化为内置 fetch）。 */
async function loadRest() {
  if (!restModPromise) {
    restModPromise = import('./rest.mjs').catch(() => null);
  }
  const mod = await restModPromise;
  if ((!mod || typeof mod.githubFetch !== 'function') && !restWarned) {
    restWarned = true;
    warn('警告: 未能加载 lib/rest.mjs，CLI 退回内置 fetch（请求头行为一致）。');
  }
  return mod && typeof mod.githubFetch === 'function' ? mod : null;
}

let deviceFlowModPromise = null;

/** 加载 lib/device-flow.mjs 并校验导出；缺失时精确报出名字。 */
async function loadDeviceFlow() {
  if (!deviceFlowModPromise) {
    deviceFlowModPromise = import('./device-flow.mjs').catch((err) => {
      throw new CliError(
        `无法加载 lib/device-flow.mjs：${err && err.message ? err.message : err}\n` +
          '  设备流登录依赖该模块；也可改用 --token 方式登录。',
        EXIT_USAGE,
      );
    });
  }
  const mod = await deviceFlowModPromise;
  const missing = ['startDeviceFlow', 'pollDeviceFlow'].filter((name) => typeof mod[name] !== 'function');
  if (missing.length > 0) {
    throw new CliError(
      `lib/device-flow.mjs 缺少导出：${missing.map((n) => `${n}()`).join('、')}\n` +
        '  约定接口：startDeviceFlow(clientId, scope, signal) / pollDeviceFlow(clientId, deviceCode, intervalSec, signal, onTick)。',
      EXIT_USAGE,
    );
  }
  return mod;
}

// ─────────────────────────── GitHub API ───────────────────────────

/** 退化的内置实现：仅当 rest.mjs 缺失时使用。 */
async function internalFetch(token, apiPath, timeoutMs) {
  const url = /^https?:\/\//i.test(apiPath)
    ? apiPath
    : `${API_BASE}${apiPath.startsWith('/') ? '' : '/'}${apiPath}`;
  let res;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        accept: ACCEPT,
        'x-github-api-version': API_VERSION,
        'user-agent': USER_AGENT,
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const message =
      err && err.name === 'TimeoutError'
        ? `请求超时（>${Math.round(timeoutMs / 1000)}s）`
        : err && err.message
          ? err.message
          : String(err);
    return { ok: false, status: 0, error: { status: 0, message: `无法连接 api.github.com：${message}` } };
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  const scopeHeader = headerOf(res, 'x-oauth-scopes');
  const rate = {
    remaining: headerOf(res, 'x-ratelimit-remaining'),
    limit: headerOf(res, 'x-ratelimit-limit'),
  };
  if (!res.ok) {
    const message = data && typeof data.message === 'string' && data.message ? data.message : `HTTP ${res.status}`;
    const error = { status: res.status, message };
    if (res.status === 401) error.docsUrl = 'https://docs.github.com/rest/authentication/authenticating-to-the-rest-api';
    return { ok: false, status: res.status, error, scopes: parseScopes(scopeHeader), rate };
  }
  return { ok: true, status: res.status, data, scopes: parseScopes(scopeHeader), rate };
}

/** 统一的 GET 调用：优先走宿主同一套 rest.mjs。 */
async function apiGet(token, apiPath) {
  const rest = await loadRest();
  if (rest) {
    const result = await rest.githubFetch(token, apiPath, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (result && typeof result === 'object') return result;
    return { ok: false, status: 0, error: { status: 0, message: 'rest.githubFetch() 返回值异常' } };
  }
  return internalFetch(token, apiPath, HTTP_TIMEOUT_MS);
}

/** 实时校验 token，返回规范化结果。 */
async function verifyToken(token) {
  const res = await apiGet(token, '/user');
  const status = typeof res.status === 'number' ? res.status : 0;
  const message =
    (res.error && typeof res.error.message === 'string' && res.error.message) ||
    (res.data && typeof res.data.message === 'string' && res.data.message) ||
    `HTTP ${status}`;
  const rate = res.rate && typeof res.rate === 'object' ? res.rate : {};

  if (res.ok === true) {
    const data = res.data && typeof res.data === 'object' ? res.data : {};
    return {
      kind: 'ok',
      status,
      login: typeof data.login === 'string' && data.login ? data.login : '(未知)',
      name: typeof data.name === 'string' ? data.name : '',
      scopes: parseScopes(res.scopes),
      remaining: rate.remaining === undefined || rate.remaining === null ? '' : String(rate.remaining),
      limit: rate.limit === undefined || rate.limit === null ? '' : String(rate.limit),
    };
  }
  const kind = status === 0 ? 'network' : status === 401 ? 'unauthorized' : 'http';
  return {
    kind,
    status,
    message,
    docsUrl: res.error && res.error.docsUrl,
    networkError: kind === 'network' ? message : '',
    scopes: [],
    remaining: rate.remaining === undefined || rate.remaining === null ? '' : String(rate.remaining),
    limit: rate.limit === undefined || rate.limit === null ? '' : String(rate.limit),
  };
}

function apiMessage(res) {
  if (res && res.message) return res.message;
  if (res && res.networkError) return res.networkError;
  return `HTTP ${res ? res.status : '?'}`;
}

/** 统一的「校验不通过」中文提示，返回退出码 1。 */
function reportVerifyFailure(res) {
  if (res.kind === 'network') {
    out(`✗ 无法连接 GitHub 完成校验：${res.networkError}`);
    out('  请检查网络/代理后重试；为避免保存无效凭据，本次没有写入任何内容。');
    return EXIT_FAIL;
  }
  if (res.kind === 'unauthorized') {
    out('✗ 校验失败（HTTP 401）：GitHub 认为该 token 无效或已过期。');
    out(`  请到 ${PAT_URL} 重新生成 token，然后执行: dsh-github login --token <新token>`);
    out('  若使用 fine-grained token，请确认它未过期且至少拥有读取用户信息的权限。');
    if (res.docsUrl) out(`  官方说明: ${res.docsUrl}`);
    return EXIT_FAIL;
  }
  out(`✗ 校验失败：${apiMessage(res)}（HTTP ${res.status}）`);
  if (res.status === 403 && res.remaining === '0') {
    out('  当前 token 的 API 速率限制已用尽，请稍后再试。');
  }
  if (res.docsUrl) out(`  官方说明: ${res.docsUrl}`);
  return EXIT_FAIL;
}

// ─────────────────────────── 参数解析 ───────────────────────────

const VALUE_OPTIONS = new Set(['token', 'client-id', 'scope']);

function parseArgs(argv) {
  const result = { positionals: [], options: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--') {
      result.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = (eq >= 0 ? arg.slice(2, eq) : arg.slice(2)).toLowerCase();
      if (eq >= 0) {
        result.options[name] = arg.slice(eq + 1);
        continue;
      }
      if (VALUE_OPTIONS.has(name)) {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
          throw new CliError(`选项 --${name} 需要一个值，例如: --${name} <值>`, EXIT_USAGE);
        }
        result.options[name] = value;
        i += 1;
        continue;
      }
      result.options[name] = true;
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      result.options[arg.slice(1).toLowerCase()] = true;
      continue;
    }
    result.positionals.push(arg);
  }
  return result;
}

// ─────────────────────────── 帮助文本 ───────────────────────────

function printHelp() {
  out(`dsh-github ${VERSION} —— DSH GitHub 插件命令行工具（纯 token，无需 DSH 运行）`);
  out('');
  out('用法:');
  out('  dsh-github <命令> [选项]');
  out('  node lib/cli.mjs <命令> [选项]      # 未安装 bin 时可直接用 node 运行');
  out('');
  out('命令:');
  out('  status                 查看本地凭据状态并实时校验（永不打印明文 token）');
  out('     选项: --json 输出一行机器可读 JSON（不含明文 token）');
  out('     示例: dsh-github status');
  out('  login                  保存一个 token；默认交互式隐藏输入');
  out('     示例: dsh-github login --token <你的token>');
  out('     示例: Get-Content token.txt | dsh-github login --stdin     (PowerShell)');
  out('     示例: echo $GH_TOKEN | dsh-github login --stdin            (bash)');
  out('     示例: dsh-github login --device --client-id <client_id>');
  out('  logout                 删除本地保存的凭据');
  out('     示例: dsh-github logout');
  out('  token                  仅向 stdout 打印明文 token（供脚本使用），其余信息走 stderr');
  out('     示例: $env:DSH_GITHUB_TOKEN = (dsh-github token)           (PowerShell)');
  out('  whoami                 打印登录名、姓名、权限范围与速率限制');
  out('     示例: dsh-github whoami');
  out('  --help, -h             显示本帮助（无参数时同样显示）');
  out('     示例: dsh-github --help');
  out('');
  out('选项:');
  out('  --token <值>       直接提供 token（优先级最高）');
  out('  --stdin            从标准输入读取全部内容并 trim 后作为 token');
  out('  --device           使用 OAuth 设备流登录（需要 client id）');
  out('  --client-id <id>   设备流使用的 OAuth App client id');
  out(`  --scope "<范围>"   设备流申请的权限，默认 "${DEFAULT_DEVICE_SCOPE}"`);
  out('  说明: login 不带任何选项时进入交互式隐藏输入，需要 TTY 终端；');
  out('        stdin 不是 TTY 或输入为空时会以用法错误（退出码 2）结束。');
  out('');
  out('DSH / 智能体如何使用这个 token:');
  out('  插件宿主通过 shell 环境把生效 token 注入为 DSH_GITHUB_TOKEN，DSH 执行 shell 命令时可直接读取，');
  out('  因此无需把 token 写进脚本。例如:');
  out('    git clone https://x-access-token:$env:DSH_GITHUB_TOKEN@github.com/owner/repo.git   (PowerShell)');
  out('    git clone https://x-access-token:$DSH_GITHUB_TOKEN@github.com/owner/repo.git        (bash)');
  out('  生效优先级（与插件宿主一致）: DSH_GITHUB_TOKEN / GITHUB_TOKEN 环境变量优先，');
  out('  环境变量为空时才使用落盘凭据文件。');
  out(`  凭据文件: ${path.join(dshHome(), 'github.json')}（DSH_HOME 可覆盖 ~/.dsh）`);
  out('  安全提示: 不要把 token 提交到仓库、贴进 issue 或写进日志；本项目从不回显完整 token。');
  out('');
  out('如何创建 token:');
  out(`  ${PAT_URL}`);
  out('  - Fine-grained token（推荐）: 只勾选需要的仓库与权限（Contents / Issues /');
  out('    Pull requests / Workflows / Metadata 等），权限最小、可按仓库限定。');
  out('    注意: fine-grained token 不返回 x-oauth-scopes 头，status 会显示为「未知/细粒度」。');
  out('  - Classic token: 常用范围 repo（仓库读写）、read:org（读取组织）、');
  out('    workflow（修改 GitHub Actions 工作流）、gist（Gist 读写）。');
  out('  设备流登录需要先创建一个 OAuth App（或使用已配置的 clientId），并启用 Device Flow。');
  out('');
  out('退出码: 0 成功；1 未配置或校验失败；2 用法/环境错误。');
}

// ─────────────────────────── 命令: status ───────────────────────────

async function cmdStatus() {
  const storeMod = await requireStore(['readStore']);
  const file = storeFilePath(storeMod);
  const status =
    typeof storeMod.statusOf === 'function' ? (await storeMod.statusOf()) || {} : (await storeMod.readStore()) || {};
  const effective = await readEffectiveToken(storeMod);
  const settings = (await storeMod.readStore()) || {};
  const hasFileToken = typeof settings.token === 'string' && settings.token.trim() !== '';

  const scopes = parseScopes(status.scopes);
  const preview =
    typeof status.preview === 'string' && status.preview !== ''
      ? status.preview
      : maskToken(effective.token);
  const kind = status.tokenKind || (effective.source === 'env' ? 'env' : effective.token ? 'pat' : '');

  heading('GitHub 连接状态');
  row('配置状态', effective.token ? '已配置' : '未配置');
  row(
    '生效来源',
    effective.source === 'env'
      ? '环境变量 DSH_GITHUB_TOKEN / GITHUB_TOKEN'
      : effective.source === 'store'
        ? `凭据文件 ${file}`
        : '(无)',
  );
  row('登录名', status.login || '(未知，运行校验后才可确认)');
  row('Token 类型', kind || '(未设置)');
  row('权限范围', scopes.length > 0 ? scopes.join(', ') : '(未记录)');
  row('更新时间', isTimestamp(status.updatedAt) ? String(status.updatedAt) : '(未记录)');
  row('默认仓库', status.defaultRepo || '(未设置)');
  row('凭据文件', file);
  row('文件存在', fs.existsSync(file) ? '是' : '否');
  row('Token 预览', preview);

  if (effective.source === 'env' && hasFileToken) {
    row('提示', '环境变量优先，凭据文件里的 token 当前被遮蔽。');
  }

  if (!effective.token) {
    out('');
    out('✗ 尚未配置 token。请执行以下任一命令后重试:');
    out('    dsh-github login --token <你的token>');
    out(`    ${PAT_URL}`);
    return EXIT_FAIL;
  }

  out('');
  out('实时校验: GET https://api.github.com/user');
  const res = await verifyToken(effective.token);
  if (res.kind !== 'ok') return reportVerifyFailure(res);

  row('校验结果', '通过 ✓');
  row('登录名', res.login);
  if (res.name) row('姓名', res.name);
  row(
    '真实权限',
    res.scopes.length > 0
      ? res.scopes.join(', ')
      : '(该 token 未返回 x-oauth-scopes：通常是 fine-grained token)',
  );
  row(
    '速率限制',
    res.remaining !== '' ? `${res.remaining}${res.limit !== '' ? `/${res.limit}` : ''}（剩余）` : '(未返回)',
  );
  out('');
  out('提示: DSH 执行 shell 命令时会注入 DSH_GITHUB_TOKEN，插件与智能体拥有且仅拥有以上权限。');
  return EXIT_OK;
}

/**
 * `status --json` 的机器可读输出。
 *
 * 复刻 `cmdStatus` 已经算出来的同一份事实，但不含任何明文 token——脚本需要 token
 * 时应当显式调用 `dsh-github token`，让「谁会读到明文」这件事留在明面上。
 */
async function cmdStatusJson() {
  const storeMod = await requireStore(['readStore']);
  const file = storeFilePath(storeMod);
  const status =
    typeof storeMod.statusOf === 'function' ? (await storeMod.statusOf()) || {} : (await storeMod.readStore()) || {};
  const effective = await readEffectiveToken(storeMod);
  const settings = (await storeMod.readStore()) || {};
  const hasFileToken = typeof settings.token === 'string' && settings.token.trim() !== '';
  const scopes = parseScopes(status.scopes);
  const preview =
    typeof status.preview === 'string' && status.preview !== '' ? status.preview : maskToken(effective.token);
  const kind = status.tokenKind || (effective.source === 'env' ? 'env' : effective.token ? 'pat' : '');

  const payload = {
    configured: effective.token !== '',
    source: effective.source,
    tokenKind: kind || null,
    login: status.login || null,
    scopes,
    updatedAt: isTimestamp(status.updatedAt) ? String(status.updatedAt) : null,
    defaultRepo: status.defaultRepo || null,
    storeFile: file,
    storeExists: fs.existsSync(file),
    preview,
    shadowedByEnv: effective.source === 'env' && hasFileToken,
    verified: false,
    verifiedLogin: null,
    verifiedScopes: [],
    rate: null,
  };

  if (effective.token === '') return emitJson(payload);

  const res = await verifyToken(effective.token);
  if (res.kind !== 'ok') {
    payload.error = { kind: res.kind, status: res.status ?? null, message: res.message ?? null, docsUrl: res.docsUrl ?? null };
    return emitJson(payload);
  }
  payload.verified = true;
  payload.verifiedLogin = res.login;
  payload.verifiedScopes = res.scopes;
  payload.name = res.name || null;
  payload.rate = { remaining: res.remaining, limit: res.limit };
  return emitJson(payload);
}

// ─────────────────────────── 命令: login ───────────────────────────

function readAllStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    process.stdin.on('error', reject);
    process.stdin.resume();
  });
}

let usedRawStdin = false;

/** 隐藏式读取一行（终端无法关闭回显时退回可见输入并提示）。 */
function readHiddenLine(promptText) {
  const stdin = process.stdin;
  const stdout = process.stdout;

  if (!stdin.isTTY) {
    throw new CliError(
      '标准输入不是终端，无法交互式输入 token。请改用: --token <值> 或 --stdin（管道输入）。',
      EXIT_USAGE,
    );
  }

  if (typeof stdin.setRawMode !== 'function') {
    const rl = readline.createInterface({ input: stdin, output: stdout, terminal: true });
    warn('警告: 当前终端无法关闭回显，输入内容会显示在屏幕上。');
    return new Promise((resolve) => {
      rl.question(promptText, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  stdout.write(promptText);
  return new Promise((resolve, reject) => {
    let buffer = '';
    let escape = 0;
    let settled = false;
    const wasRaw = Boolean(stdin.isRaw);

    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.removeListener('end', onEnd);
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        /* 忽略 */
      }
      try {
        stdin.pause();
      } catch {
        /* 忽略 */
      }
      usedRawStdin = true;
      stdout.write('\n');
    };

    const onData = (chunk) => {
      if (settled) return;
      const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      for (const ch of text) {
        if (escape > 0) {
          escape -= 1;
          continue;
        }
        if (ch === '\u001b') {
          escape = 2;
          continue;
        }
        if (ch === '\r' || ch === '\n') {
          settled = true;
          cleanup();
          resolve(buffer);
          return;
        }
        if (ch === '\u0003') {
          settled = true;
          cleanup();
          reject(new CliError('已取消（Ctrl+C）。', EXIT_FAIL));
          return;
        }
        if (ch === '\u007f' || ch === '\b') {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            stdout.write('\b \b');
          }
          continue;
        }
        if (ch < ' ') continue;
        buffer += ch;
        stdout.write('*');
      }
    };

    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(buffer);
    };

    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdin.on('end', onEnd);
  });
}

/** 按优先级取得 token 明文（--token / --stdin / 交互输入）。 */
async function acquireToken(options) {
  if (typeof options.token === 'string') {
    const token = options.token.trim();
    if (token === '') throw new CliError('--token 的值为空。', EXIT_USAGE);
    if (options.stdin) warn('警告: 同时提供了 --token 与 --stdin，按优先级使用 --token。');
    return { token, source: '--token' };
  }
  if (options.stdin) {
    if (process.stdin.isTTY) {
      throw new CliError('--stdin 需要管道输入，例如: Get-Content token.txt | dsh-github login --stdin', EXIT_USAGE);
    }
    const token = (await readAllStdin()).trim();
    if (token === '') throw new CliError('标准输入为空，未读取到 token。', EXIT_USAGE);
    return { token, source: '--stdin' };
  }
  const token = (await readHiddenLine('请输入 GitHub token（输入不回显，回车确认）: ')).trim();
  if (token === '') throw new CliError('没有输入任何内容，已取消，未保存凭据。', EXIT_USAGE);
  return { token, source: '交互输入' };
}

/** 校验 + 保存 token（PAT 与设备流共用）。 */
async function saveVerifiedToken(storeMod, { token, kind, clientId, source }) {
  const res = await verifyToken(token);

  out('');
  out(`凭据来源: ${source}`);
  if (res.kind !== 'ok') return reportVerifyFailure(res);

  out(`✓ 校验通过（GET /user）：登录名 ${res.login}${res.name ? `（${res.name}）` : ''}`);
  out(
    `  该 token 实际拥有的权限: ${
      res.scopes.length > 0 ? res.scopes.join(', ') : '(未返回 x-oauth-scopes，通常为 fine-grained token)'
    }`,
  );
  if (res.remaining !== '') out(`  当前速率限制剩余: ${res.remaining}${res.limit !== '' ? `/${res.limit}` : ''}`);
  out('');
  out('警告: 插件与 DSH 智能体将恰好拥有以上权限，不多不少。');
  out('      请确认这些权限是你愿意授予的；若权限过大，请到 GitHub 创建范围更窄的 token 后重新登录。');

  const patch = {
    token,
    tokenKind: kind,
    login: res.login,
    scopes: res.scopes,
  };
  if (clientId) patch.clientId = clientId;

  await storeMod.writeStore(patch);

  const file = storeFilePath(storeMod);
  out('');
  out(`✓ 已写入凭据文件: ${file}`);
  const saved = readJsonFile(file);
  if (!saved || saved.token !== token) {
    warn('警告: 无法在约定路径读回刚写入的凭据，store.mjs 可能使用了不同的文件位置。');
  }

  const effective = await readEffectiveToken(storeMod);
  if (effective.source === 'env' && effective.token !== token) {
    warn('注意: 当前环境变量中存在 token，其优先级高于凭据文件，插件实际使用的仍是环境变量里的那个。');
  } else if (effective.token !== token) {
    warn('注意: 写入后读到的生效 token 与刚保存的不一致，请运行 dsh-github status 复核。');
  }
  out('提示: 运行 dsh-github status 可再次实时校验；DSH 执行 shell 命令时会注入 DSH_GITHUB_TOKEN。');
  return EXIT_OK;
}

async function loginWithDevice(options, storeMod) {
  const deviceMod = await loadDeviceFlow();
  const status = typeof storeMod.statusOf === 'function' ? (await storeMod.statusOf()) || {} : {};
  const clientId = options['client-id'] || process.env.DSH_GITHUB_CLIENT_ID || status.clientId || '';
  if (!clientId) {
    throw new CliError(
      '设备流登录需要一个 OAuth App 的 client id。\n' +
        '  用法: dsh-github login --device --client-id <client_id>\n' +
        '  或先在设置页保存 clientId；也支持环境变量 DSH_GITHUB_CLIENT_ID。',
      EXIT_USAGE,
    );
  }
  const scope = options.scope || deviceMod.DEFAULT_SCOPE || DEFAULT_DEVICE_SCOPE;

  const start = await deviceMod.startDeviceFlow(clientId, scope);
  if (start && start.ok === false) {
    throw new CliError(
      `设备流启动失败：${(start.error && start.error.message) || '未知错误'}${
        start.error && start.error.docsUrl ? `\n  官方说明: ${start.error.docsUrl}` : ''
      }`,
      EXIT_FAIL,
    );
  }

  const deviceCode = pick(start, ['device_code', 'deviceCode']);
  const userCode = pick(start, ['user_code', 'userCode']);
  const verifyUri = pick(start, [
    'verification_uri_complete',
    'verificationUriComplete',
    'verification_uri',
    'verificationUri',
  ]);
  const intervalSec = Number(pick(start, ['interval', 'intervalSec', 'interval_seconds'])) || 5;

  if (!deviceCode || !userCode) {
    const keys = start && typeof start === 'object' ? Object.keys(start).join(', ') : typeof start;
    throw new CliError(
      `startDeviceFlow() 的返回值缺少 device_code / user_code（实际字段: ${keys}）。`,
      EXIT_USAGE,
    );
  }

  out('');
  out('请在浏览器中完成设备授权:');
  out(`  1. 打开: ${verifyUri || deviceMod.VERIFY_URL || DEVICE_URL_FALLBACK}`);
  out(`  2. 输入代码: ${userCode}`);
  out(`  申请的权限范围: ${scope}`);
  out('等待授权中…（Ctrl+C 取消）');

  const controller = new AbortController();
  const onSigint = () => controller.abort();
  process.on('SIGINT', onSigint);
  let polled;
  try {
    polled = await deviceMod.pollDeviceFlow(clientId, deviceCode, intervalSec, controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      out('已取消设备流登录。');
      return EXIT_FAIL;
    }
    throw new CliError(`设备流轮询失败：${err && err.message ? err.message : String(err)}`, EXIT_FAIL);
  } finally {
    process.off('SIGINT', onSigint);
  }

  if (polled && polled.ok === false) {
    const message = (polled.error && polled.error.message) || '设备流未完成';
    out(`✗ ${message}${polled.code ? `（${polled.code}）` : ''}`);
    if (polled.error && polled.error.docsUrl) out(`  官方说明: ${polled.error.docsUrl}`);
    return EXIT_FAIL;
  }

  const token =
    typeof polled === 'string'
      ? polled.trim()
      : String(pick(polled, ['access_token', 'accessToken', 'token']) || '').trim();
  if (!token) {
    const keys = polled && typeof polled === 'object' ? Object.keys(polled).join(', ') : typeof polled;
    throw new CliError(
      `pollDeviceFlow() 的返回值中没有 access_token（实际字段: ${keys}）。`,
      EXIT_USAGE,
    );
  }

  out('');
  out('✓ 设备授权成功，正在校验 token…');
  return saveVerifiedToken(storeMod, {
    token,
    kind: 'device',
    clientId,
    source: 'OAuth 设备流',
  });
}

async function cmdLogin(options) {
  const storeMod = await requireStore(['writeStore']);

  if (typeof options.token === 'string' && options.device) {
    warn('警告: 同时提供了 --token 与 --device，按 --device 处理。');
  }
  if (options.device) return loginWithDevice(options, storeMod);

  const { token, source } = await acquireToken(options);
  out('正在校验 token（GET https://api.github.com/user）…');
  return saveVerifiedToken(storeMod, { token, kind: 'pat', source });
}

// ─────────────────────────── 命令: logout / token / whoami ───────────────────────────

async function cmdLogout() {
  const storeMod = await requireStore(['clearToken']);
  const file = storeFilePath(storeMod);
  const before = readJsonFile(file);
  const hadToken = Boolean(before && typeof before.token === 'string' && before.token.trim() !== '');

  const result = await storeMod.clearToken();
  const removed = result && typeof result === 'object' && 'removed' in result ? Boolean(result.removed) : hadToken;
  const after = readJsonFile(file);
  const stillStored = Boolean(after && typeof after.token === 'string' && after.token.trim() !== '');

  out('');
  if (stillStored) {
    warn(`警告: clearToken() 执行后凭据文件里仍存在 token（${file}），请检查 store.mjs。`);
    return EXIT_FAIL;
  }
  if (removed || hadToken) out(`✓ 已删除本地凭据（${file}）。`);
  else out(`本地没有已保存的凭据，无需删除（${file}）。`);

  const envToken = (process.env.DSH_GITHUB_TOKEN || process.env.GITHUB_TOKEN || '').trim();
  if (envToken) {
    out('注意: 环境变量中仍有 token，插件在无本地凭据时会继续使用它。');
  }
  return EXIT_OK;
}

async function cmdToken() {
  const storeMod = await requireStore(['readToken']);
  const { token, source } = await readEffectiveToken(storeMod);

  if (!token) {
    warn('错误: 尚未配置 token，无法输出。请先运行 dsh-github login。');
    return EXIT_FAIL;
  }
  warn('警告: 以下内容为明文凭据，请勿写入日志、提交到仓库或分享给他人。');
  warn(`来源: ${source === 'env' ? '环境变量 DSH_GITHUB_TOKEN / GITHUB_TOKEN' : storeFilePath(storeMod)}`);
  process.stdout.write(`${token}\n`);
  return EXIT_OK;
}

async function cmdWhoami() {
  const storeMod = await requireStore(['readToken']);
  const { token, source } = await readEffectiveToken(storeMod);

  if (!token) {
    if (isJsonMode()) return emitJson({ ok: false, error: 'no-token', hint: `先运行 dsh-github login --token <token>；创建 token: ${PAT_URL}` });
    out('✗ 尚未配置 token。请先运行: dsh-github login --token <你的token>');
    out(`  创建 token: ${PAT_URL}`);
    return EXIT_FAIL;
  }

  const res = await verifyToken(token);
  if (res.kind !== 'ok') {
    if (isJsonMode()) {
      return emitJson({ ok: false, error: res.kind, status: res.status ?? null, message: res.message ?? null, docsUrl: res.docsUrl ?? null });
    }
    return reportVerifyFailure(res);
  }

  const status = typeof storeMod.statusOf === 'function' ? (await storeMod.statusOf()) || {} : {};
  const kind = source === 'env' ? 'env' : status.tokenKind || 'pat';

  if (isJsonMode()) {
    return emitJson({
      ok: true,
      login: res.login,
      name: res.name || null,
      tokenKind: kind,
      source,
      sourceDetail: source === 'env' ? 'environment' : storeFilePath(storeMod),
      scopes: res.scopes,
      rate: { remaining: res.remaining, limit: res.limit },
    });
  }
  const rows = [
    ['登录名', res.login],
    ['姓名', res.name || '(未设置)'],
    ['Token 类型', kind],
    ['来源', source === 'env' ? '环境变量' : storeFilePath(storeMod)],
    [
      '权限范围',
      res.scopes.length > 0 ? res.scopes.join(', ') : '(未返回 x-oauth-scopes，通常为 fine-grained)',
    ],
    ['速率限制', res.remaining !== '' ? `${res.remaining}${res.limit !== '' ? `/${res.limit}` : ''}` : '(未返回)'],
  ];

  heading('GitHub 用户');
  const width = Math.max(...rows.map(([label]) => displayWidth(label)));
  for (const [label, value] of rows) out(`${padRight(label, width + 2)}${value}`);
  out('');
  return EXIT_OK;
}

// ─────────────────────────── JSON 输出模式 ───────────────────────────

/**
 * `--json` 时命令只输出一行 JSON（机器可读），人类可读的表格与提示一律不打印。
 *
 * 这样脚本就不必解析带对齐空格的表格——那是给人看的，不是接口。
 */
let jsonMode = false;

/** 设置 JSON 输出模式。 */
function setJsonMode(enabled) {
  jsonMode = enabled === true;
}

/** 是否处于 JSON 输出模式。 */
function isJsonMode() {
  return jsonMode;
}

/**
 * 输出一行 JSON。
 * @param {unknown} payload
 * @returns {number} 退出码 0（调用方按需覆盖）。
 */
function emitJson(payload) {
  process.stdout.write(`${JSON.stringify(payload)}
`);
  return 0;
}

// ─────────────────────────── 入口 ───────────────────────────

function finish(code) {
  process.exitCode = code;
  if (usedRawStdin) {
    try {
      process.stdin.destroy();
    } catch {
      /* 忽略 */
    }
  }
}

async function main(argv) {
  const parsed = parseArgs(argv);
  const command = (parsed.positionals[0] || '').toLowerCase();
  const options = parsed.options;
  setJsonMode(options.json === true);

  if (options.help || options.h || command === 'help' || command === '') {
    printHelp();
    return EXIT_OK;
  }

  switch (command) {
    case 'status':
      return isJsonMode() ? cmdStatusJson() : cmdStatus();
    case 'login':
      return cmdLogin(options);
    case 'logout':
      return cmdLogout();
    case 'token':
      return cmdToken();
    case 'whoami':
      return cmdWhoami();
    default:
      warn(`错误: 未知命令 "${command}"。`);
      warn('运行 dsh-github --help 查看全部命令。');
      return EXIT_USAGE;
  }
}

main(process.argv.slice(2))
  .then((code) => finish(typeof code === 'number' ? code : EXIT_OK))
  .catch((err) => {
    const code = err instanceof CliError ? err.code : EXIT_FAIL;
    warn(`错误: ${err && err.message ? err.message : String(err)}`);
    if (code === EXIT_USAGE) warn('运行 dsh-github --help 查看用法。');
    finish(code);
  });
