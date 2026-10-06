# dsh-github 测试

## 运行离线冒烟测试

```powershell
# 在插件目录下（任意 cwd 也可以，用绝对路径即可）
node test/smoke.mjs
```

- **完全离线**：脚本会把 `globalThis.fetch` 全部替换为桩函数，不发起任何真实网络请求，也不需要 token。
- **不碰真实凭据**：脚本在 `import` 业务模块之前，把 `DSH_HOME` 指向系统临时目录下的新目录，
  因此永远不会读写真实的 `C:\Users\ptfm\.dsh\github.json`；测试结束会打印并删除该临时目录，
  同时校验真实文件未被修改。
- 每条断言打印 `PASS` / `FAIL`，最后打印汇总；只有全部通过时退出码才为 `0`。
- 如果宿主模块（`lib/store.mjs`、`lib/rest.mjs`、`lib/device-flow.mjs`）缺失或导出与约定不一致，
  脚本会打印**缺失的具体导出名**，并继续执行其余可执行的断言，方便定位问题。
- `WARN` 行表示“能跑但接口有差异”，会汇总在最后的“需要确认的接口差异”里，不计入失败。

### 保留临时目录

```powershell
$env:DSH_SMOKE_KEEP = "1"; node test/smoke.mjs
```

## 覆盖范围

| 区块 | 内容 |
| --- | --- |
| 模块加载 | `lib/store.mjs`、`lib/rest.mjs`、`lib/device-flow.mjs` 可 `import`，`lib/cli.mjs` 存在 |
| store | 写入/读回、`readToken()` 的 `{token, source}`、环境变量优先、`statusOf()` 脱敏（序列化后不含明文 token）、补丁合并、原子写入无 `.tmp` 残留、`clearToken()`、`DEFAULT_SETTINGS` |
| device-flow | `DEVICE_CODE_URL` / `TOKEN_URL` 常量、`startDeviceFlow()` 的 POST 表单、空 client_id 的失败结果、`pollDeviceFlowOnce()` 单次语义、`pollDeviceFlow()` 跳过 `authorization_pending` |
| rest | `githubFetch(token, path)` 的方法/URL/四个请求头、不把 token 放进 URL、200 响应体、401 归一化为 `{ status, message, docsUrl }`、`whoami()`、`scopesFromResponse()`、`rate` 元信息 |
| CLI | 子进程执行 `node lib/cli.mjs --help` / `status` / `token` / `whoami` / 未知命令（未配置场景），校验退出码与中文输出 |

> 说明：宿主的 `DSH_GITHUB_TOKEN` 注入与 `github-*` 工具的加载由 Lead 的 `test/host-load.mjs` 覆盖；
> 本文件只覆盖 store / rest / device-flow / CLI。

## 手工验证 CLI（需要网络与真实 token）

```powershell
node lib/cli.mjs --help
node lib/cli.mjs status
node lib/cli.mjs login --token <你的token>
node lib/cli.mjs whoami
node lib/cli.mjs token
node lib/cli.mjs logout
```
