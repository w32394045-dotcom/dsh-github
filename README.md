# @ptfm/dsh-github

把 GitHub 接进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)：**设置里登录一次，agent 就能以你的账号真实干活**——读仓库、翻 issue 与 PR、查 Actions、发评论、管分支与发布，以及调用 GitHub 的云计算服务。

和其他「GitHub MCP」类方案最大的区别是：**token 不经过模型上下文**。凭据落在本机文件里，插件在宿主内直接调用 GitHub API，模型只看到结构化结果。agent 通过 shell 跑 `git` / `gh` 时也能拿到登录态（`DSH_GITHUB_TOKEN`），行为等同你自己在终端里操作。

```
┌─────────────┐   设置页/CLI 登录一次   ┌──────────────────────────────┐
│  DSH Web UI │ ─────────────────────▶ │ 插件宿主半边                  │
│  设置→GitHub│                        │  · 凭据：$DSH_HOME/github.json │
└─────────────┘ ◀───────────────────── │  · 12 个 github-* 工具        │
                                       │  · /api/github 精确路由       │
      agent ──── github-* 工具 ───────▶ │  · DSH_GITHUB_TOKEN 注入      │
                                       └───────────┬──────────────────┘
                                                   ▼
                                          api.github.com（你的权限）
```

## 快速开始

**Windows（PowerShell）：**

```powershell
git clone https://github.com/w32394045-dotcom/dsh-github.git
cd dsh-github
powershell -ExecutionPolicy Bypass -File scripts\install.ps1
```

**macOS / Linux：**

```bash
git clone https://github.com/w32394045-dotcom/dsh-github.git
cd dsh-github
bash scripts/install.sh
```

安装器会（幂等地）把插件放进 `$DSH_HOME/plugins/dsh-github`，在目标 profile 里登记 `link:` 依赖与 bundle，再用 DSH 自带的 pnpm 装好链接。装完打开 DSH → **设置 → GitHub** → 粘贴 token 即可；若插件没立刻出现，重启一次 DSH。

> 手动安装也可以：在 profile 的 `package.json` 里把 `"@ptfm/dsh-github": "link:<插件目录>"` 加进 `dependencies` 和 `dsh.profile.bundles`，然后 `pnpm install`。

## 三条登录路径

1. **Personal Access Token** —— 设置页粘贴，先拿 `/user` 真实校验，通过才落盘。
2. **OAuth Device Flow** —— 不需要 `client_secret`。你在 GitHub 建一个 OAuth App（勾选 *Enable Device Flow*），把 `client_id` 填进设置页；点「开始授权」后显示 8 位码，浏览器确认即完成。插件只保存 `client_id`，它本来就不是秘密。
3. **纯 token CLI** —— 不依赖 DSH 运行，读写同一个凭据文件：

   ```bash
   node lib/cli.mjs status                  # 状态 + 实时校验，永不打印明文 token
   node lib/cli.mjs login --token <token>   # 也支持 --stdin / 交互式隐藏输入
   node lib/cli.mjs login --device --client-id <id>
   node lib/cli.mjs whoami --json           # 机器可读
   node lib/cli.mjs token                   # 唯一输出明文的命令（stdout）
   node lib/cli.mjs logout
   ```

## 12 个 agent 工具

| 工具 | 用途 |
| --- | --- |
| `github-search` | 搜索 issue / PR / 仓库 / 代码 / 提交（**最常用**，见下） |
| `github-status` | 登录状态、账号、token 真实 scope、速率限制 |
| `github-account` | 用户资料 |
| `github-repo` | 仓库信息、目录树；`action=local` 读本地 `.git/config` 反推仓库（不消耗 API） |
| `github-issues` | 列 / 读 / 建 / 评论 / 改状态 |
| `github-pulls` | 列 / 读 / 建 / 评论 / review / merge |
| `github-branches` | 分支列表、HEAD、建/删、**compare**（建 PR 前确认 base） |
| `github-actions` | 工作流运行、job 与步骤、日志尾部、手动触发 |
| `github-releases` | Release 列表 / 详情 / 创建 / 修改 / 删除 / 资产 |
| `github-notifications` | 通知中心：列未读、标记已读、归档、订阅 |
| `github-cloud` | **云计算服务**：Codespaces、自托管运行器、Actions 配额、Pages、Packages、Models，以及成本报告与闲置回收 |
| `github-api` | 直通任意 REST 端点（其它工具覆盖不到时的逃生口） |

`repo` 参数支持三级推断：**显式传入 → 当前工作目录所属的 git 仓库 → 设置里的默认仓库**。所以在某个仓库目录里说「这个仓库的 open issue」就够了。

### `github-search` 为什么单独做厚

搜索是这套工具里调用最频繁的一个，也是 GitHub 限流最紧的一个（**认证用户 30 次/分钟**，不是普通的 5000/小时）：

- **分页与总数**：`page` / `limit`，输出明确区分「还有下一页」和「以上是全部 N 条」；
- **查询增强**：`@me` 展开成真实登录名；`days: 7` → `updated:>=日期`；查询没写 `repo:`/`user:`/`org:` 时**自动限定到当前目录所属仓库**；
- **90 秒短时缓存**：同一查询不重复花额度；
- **错误不静默**：422 回显 GitHub 原话 + 实际发出的查询 + 语法排查建议；限流会点明是搜索接口的限制并给替代方案；`incomplete_results` 会被标注；
- **输出为「读」设计**：命中总数、`issue`/`PR` 前缀、`open`/`closed`/`merged`、标签、评论数、时间、URL，以及下一步该调哪个工具。

## 云端成本：忘关 vs 误关

Codespaces 按运行时长计费，「忘了关」和「被误关」是同一枚硬币的两面。规则集中在一个模块里（`lib/lifecycle.mjs`），设置页与工具共用：

**四道防线，从最可靠到最兜底**

1. **创建时就把空闲自动停止设短**（默认 15 分钟）——由 GitHub 自己停机，**不依赖任何人记得关**，这是唯一「忘了也没事」的一道；
2. **计费动作前自动预检**：`create` 之前列出现有环境、累计花费与闲置告警，提醒「别让两台一起烧」；
3. **闲置告警与批量回收**：`action=reap`（支持 `dryRun=true` 预演）；
4. **绝不误关**（优先级高于省钱）：`last_used_at` 在安全窗口内、时间戳不可信、或持有 DSH 活跃租约时一律不动；`manual` 模式完全不动手。另外 `stop`/`delete` 发现该环境最近仍有活动会**拒绝执行**，必须显式 `force=true`。

**三种模式**（设置 → GitHub → 云端成本，点一下即生效）：

| 模式 | 提醒 | 可回收 | 安全窗口 |
| --- | --- | --- | --- |
| 平衡（默认） | 闲置 30 分钟 | 2 小时 | 15 分钟 |
| 极致省钱 | 闲置 15 分钟 | 45 分钟 | 10 分钟 |
| 手动 | 闲置 2 小时 | 不自动回收 | 30 分钟 |

`github-cloud action=cost` 给出成本报告与**省钱顺序**（停机 ≠ 免费，存储照收 → 空闲超时设短 → 能本地跑就别上云 → 长任务用 Actions → 批量 `reap`）。

## 权限与安全

- **权限完全跟随 token 自身**：插件不做二次裁剪，也不会给 agent 比 token 更大的能力。
- **token 不经过模型**：只存 `$DSH_HOME/github.json`（0600、原子写、读时剥 BOM）。`statusOf()` 是唯一给界面/日志用的出口，只返回掩码预览；`readStore()` 会返回明文，插件内部绝不对浏览器序列化它。
- **环境变量优先**：`DSH_GITHUB_TOKEN` / `GITHUB_TOKEN` 一旦设置就覆盖本地存储，方便临时切身份。
- **scope 缺失时给路**：Codespaces / Packages / Models 需要各自的 scope。工具在 403/404 时会明确告诉你缺哪个、去哪儿补，而不是丢一句失败。
- **计费动作需确认**：`create` Codespace、`dispatch` 工作流、推镜像属于会产生费用的操作，工具描述里要求先征求用户同意。

## 结构

```
lib/
  main.mjs        入口薄壳（见「开发须知」）
  index.js        宿主半边：/api/github 路由、工具注册、DSH_GITHUB_TOKEN 注入
  client.js       浏览器半边：设置 → GitHub 页
  store.mjs       凭据与偏好存储（原子写、BOM 容错、脱敏）
  lifecycle.mjs   云端成本策略：闲置判定、安全边界、租约、花费估算
  rest.mjs        GitHub REST 调用层（错误归一化、scope/速率回传）
  device-flow.mjs OAuth 设备流
  tools.mjs       12 个工具的实现（agent 工具与 HTTP 共用同一份）
  cli.mjs         命令行
scripts/
  install.ps1 / install.sh   一键安装
test/
  lifecycle-unit.mjs  成本策略与安全边界       80 项
  tools-unit.mjs      工具表与 .git/config 解析 77 项
  cloud-unit.mjs      云计算端点与权限诊断      70 项
  host-load.mjs       宿主挂载与脱敏           50 项
  smoke.mjs           存储/设备流/REST/CLI     47 项
  search-unit.mjs     搜索行为（stub fetch）   40 项
  search-live.mjs     真实联网搜索冒烟         12 项
  cloud-live.mjs      逐个云 action 的真实展示
  acceptance.mjs      端到端验收条目（默认关闭）
```

**零运行时依赖**：不 import 任何 `@deepseek-ai/*` 或第三方包，只用 Node 内置模块与 DSH 的服务接口，因此不受插件 peer 版本检查影响。

跑测试（除两个 `*-live` 外全部离线，不需要 token）：

```bash
node test/lifecycle-unit.mjs && node test/tools-unit.mjs && node test/cloud-unit.mjs
node test/host-load.mjs && node test/smoke.mjs && node test/search-unit.mjs
node test/search-live.mjs   # 需要已登录，会真实调用 GitHub
```

## 开发须知（踩过的坑）

这几条是 DSH/Cordis 的硬约束，改这个插件前值得先看：

1. **`connection.fetch.register` 的路径必须是精确路径**：以 `/api/` 开头、每段只允许 `[A-Za-z0-9_$.-]`、**不能有尾斜杠**（`/api/github/tool/` 会让 `register` 抛错，进而整块插件激活失败），也不支持通配符；方法只支持 `GET/HEAD/POST`。所以「退出登录」也是 `action=logout` 的 POST。
2. **`tools.register` 的 `parameters` 是原样透传给模型的原生 JSON Schema**，`required` 是顶层数组；逐参数 `required: true` 属于 `defineTool` DSL，而 profile 插件目录里解析不到 `@deepseek-ai/*`，用不了 `defineTool`。
3. **取服务一律 `ctx.get(name)`**，不要写 `ctx.tools` 这种属性读取：未声明 `inject` 的属性读取会抛错，而且那条报错的属性名可能是**上一次**非法访问的残留——真凶与文案里的名字未必一致，排障以栈里的行号为准。
4. **Codespaces 列表端点是 `/user/codespaces`**，不是 `/users/{login}/codespaces`（后者 404，看着像权限问题其实是路径错）；`default_workflow_permissions` 在 `/actions/permissions/workflow`，不在 `/actions/permissions`。

另外：`main.mjs` 之所以存在，是因为 Cordis 缓存的是**模块 specifier**——一旦某个版本的 `apply` 抛过错，改 `index.js` 内容不会被重新求值，disable/enable 只会回放旧报错。换入口文件名就换了一个 specifier。**宿主半边一旦处于 `fiberPhase: failed`，运行时无法恢复，必须重启 DSH。**

## 卸载

从目标 profile 的 `package.json` 里删掉 `dependencies` 与 `dsh.profile.bundles` 中的 `@ptfm/dsh-github`，重跑 `pnpm install`。可选再删 `$DSH_HOME/plugins/dsh-github` 与 `$DSH_HOME/github.json`。

## License

[MIT](LICENSE)
