/**
 * GitHub 接入 —— 浏览器半边（「设置 → GitHub」页面）。
 *
 * 通过 `window.__ModuleLoader__.load` 注册为客户端插件，只向一个槽位贡献内容：
 * `settings.section`（id=`github`），因此它会作为设置面板里的独立一页出现。
 *
 * 与宿主半边的通信走已认证的 `/api/github`：浏览器是
 * `http://127.0.0.1:<port>/api/github`，桌面端由 `document.baseURI`
 * （`dsh-app://app/`）解析出同一路由，经 Electron 载体桥接到同一个共享 fetch 处理器。
 *
 * 只 `require('react')`（平台内置模块表），不依赖任何其它客户端包。
 *
 * 三条登录路径都在这一页里：
 *  1. 粘贴 Personal Access Token（最直接，权限完全跟随 token）；
 *  2. OAuth Device Flow（需要填 OAuth App 的 Client ID，扫码/输码授权）；
 *  3. 纯 token 的 CLI（页面上给出命令，token 存在同一个文件里）。
 */

window.__ModuleLoader__.load({
  id: '@ptfm/dsh-github',
  factory: (require) => {
    const module = { exports: {} }
    const React = require('react')
    const h = React.createElement

    /** 字典命名空间。 */
    const NS = 'github'
    /** 样式表标识（重复注入时用于去重）。 */
    const STYLE_ID = '@ptfm/dsh-github/styles'
    /** 宿主半边注册的精确路由。 */
    const ENDPOINT = 'api/github'
    /** 需要等待的客户端服务。 */
    const inject = ['slots', 'locale']

    /** 设备流轮询间隔（毫秒）。GitHub 侧有自己的节流，5 秒是官方建议。 */
    const POLL_INTERVAL_MS = 5000

    const zh = {
      title: 'GitHub',
      help: '登录 GitHub 后，agent 就能以这个账号真实调用 GitHub API（读仓库、看 issue 与 PR、查 Actions、提交评论、推分支）。',
      permNote: '权限完全跟随 token 自身：插件不做任何二次裁剪，也不会给 agent 比 token 更大的能力。',
      statusConnected: '已登录',
      statusDisconnected: '未登录',
      account: '账号',
      scopes: 'token scope',
      scopesNone: '无（可能是 fine-grained token，权限按细粒度设置）',
      rate: 'API 速率限制剩余',
      source: 'token 来源',
      sourceEnv: '环境变量 GITHUB_TOKEN / DSH_GITHUB_TOKEN（优先级高于本地存储）',
      sourceStore: '本地存储',
      storeFile: '凭据文件',
      updatedAt: '最近更新',
      refresh: '重新校验',
      refreshing: '校验中…',
      logout: '退出登录',
      loggingOut: '退出中…',
      loggedOut: '已清除本地登录凭据',
      signedIn: '登录成功，agent 现在可以使用这个账号',
      loginTitle: '登录方式',
      tabPat: 'Personal Access Token',
      tabDevice: 'OAuth 设备流',
      tabCli: '命令行（纯 token）',
      patLabel: 'Token',
      patPlaceholder: 'ghp_… 或 github_pat_…',
      patHelp: '在 GitHub → Settings → Developer settings 里创建。经典 token 至少勾选 repo、read:org、workflow；fine-grained token 请给目标仓库 Contents / Issues / Pull requests / Actions 的读写权限。',
      patHintClassic: '创建经典 token',
      patHintFine: '创建 fine-grained token',
      save: '登录',
      saving: '校验中…',
      savedAs: '已登录为',
      patEmpty: '请先填写 token',
      deviceHelp: '设备流不需要 client_secret，插件里只保存 Client ID（它本身不是秘密）。你需要先建一个 OAuth App 并勾选 Enable Device Flow。',
      clientIdLabel: 'OAuth App Client ID',
      clientIdPlaceholder: '例如 Ov23li…（不是 secret）',
      clientIdHelp: '在 GitHub → Settings → Developer settings → OAuth Apps → New OAuth App 创建，勾选 Enable Device Flow，任意填 Homepage URL 与 callback（设备流不用回调）。',
      clientIdSave: '保存',
      clientIdSaved: '已保存',
      deviceScopes: '本次授权申请的 scope',
      deviceStart: '开始授权',
      deviceStarting: '申请设备码…',
      deviceCodeLabel: '在 GitHub 输入这个 8 位码',
      deviceCopy: '复制',
      deviceCopied: '已复制',
      deviceOpen: '打开 GitHub 授权页',
      deviceWaiting: '等待你在 GitHub 上确认…（本页会自动完成登录）',
      deviceCancel: '取消授权',
      deviceCancelled: '已取消授权',
      cliHelp: '不想用界面时，可以在插件目录里用命令行完成同一件事：token 存到同一个文件，设置页与 CLI 读的是同一份登录态。',
      cliStatus: '查看登录状态',
      cliLogin: '用 token 登录',
      cliLoginDevice: '用设备流登录',
      cliLogout: '退出登录',
      cliDirHint: '插件目录',
      configTitle: '偏好设置',
      cloudTitle: '云端成本',
      cloudHelp: 'Codespaces 按运行时长计费：忘了关就是持续烧钱。这里决定系统多积极地帮你关，以及创建环境时默认多久自动停机。',
      modeBalanced: '平衡',
      modeBalancedNote: '闲置 30 分钟提醒、2 小时才允许回收；15 分钟内有活动绝不回收。日常用这个。',
      modeFrugal: '极致省钱',
      modeFrugalNote: '闲置 15 分钟就提醒、45 分钟即可回收；创建环境默认 15 分钟自动停机。偶尔用一次云端时选它。',
      modeManual: '手动',
      modeManualNote: '只报告、绝不自动回收，要不要关完全由你决定。适合长时间跑训练/构建。',
      idleLabel: '创建 Codespace 时的空闲自动停止（分钟）',
      idleHelp: '这是最省事的一道保险：到点由 GitHub 自动停机，不依赖任何人记得关。15 分钟够跑构建；长任务可以调到 60–120。',
      guardNote: '安全边界：机器最近有活动时，stop/delete 会拒绝执行并要求显式 force——不会把关掉正在进行的会话。',
      defaultRepoLabel: '默认仓库',
      defaultRepoPlaceholder: 'owner/name（可留空）',
      defaultRepoHelp: '留空时，github-repo / github-issues / github-pulls 这些工具要求每次显式传 repo。',
      toolsTitle: 'agent 可用的工具',
      toolsHelp: '登录后这些工具会出现在新会话里（已开的会话需要新建或重载才会看到）。',
      loading: '读取中…',
      loadFailed: '无法读取插件状态',
      saving2: '保存中…',
      unknownError: '未知错误',
      copyFailed: '复制失败，请手动选择文本',
    }

    const en = {
      title: 'GitHub',
      help: 'Sign in to GitHub and the agent can work with the real API as that account: read repositories, issues and pull requests, inspect Actions, post comments, push branches.',
      permNote: 'Permissions follow the token exactly: the plugin never narrows or widens what the token can do.',
      statusConnected: 'Signed in',
      statusDisconnected: 'Not signed in',
      account: 'Account',
      scopes: 'Token scopes',
      scopesNone: 'None (likely a fine-grained token; permissions come from its settings)',
      rate: 'API rate limit remaining',
      source: 'Token source',
      sourceEnv: 'Environment GITHUB_TOKEN / DSH_GITHUB_TOKEN (takes precedence)',
      sourceStore: 'Local store',
      storeFile: 'Credential file',
      updatedAt: 'Updated',
      refresh: 'Re-check',
      refreshing: 'Checking…',
      logout: 'Sign out',
      loggingOut: 'Signing out…',
      loggedOut: 'Local credentials cleared',
      signedIn: 'Signed in — the agent can now work as this account',
      loginTitle: 'Sign-in method',
      tabPat: 'Personal access token',
      tabDevice: 'OAuth device flow',
      tabCli: 'Command line (token)',
      patLabel: 'Token',
      patPlaceholder: 'ghp_… or github_pat_…',
      patHelp: 'Create it under GitHub → Settings → Developer settings. A classic token needs at least repo, read:org and workflow; a fine-grained token needs Contents / Issues / Pull requests / Actions access on the target repositories.',
      patHintClassic: 'Create classic token',
      patHintFine: 'Create fine-grained token',
      save: 'Sign in',
      saving: 'Verifying…',
      savedAs: 'Signed in as',
      patEmpty: 'Enter a token first',
      deviceHelp: 'The device flow needs no client secret, so only the Client ID is stored here (it is not a secret). You do need an OAuth App with Enable Device Flow checked.',
      clientIdLabel: 'OAuth App Client ID',
      clientIdPlaceholder: 'e.g. Ov23li… (not a secret)',
      clientIdHelp: 'Create one under GitHub → Settings → Developer settings → OAuth Apps → New OAuth App, tick Enable Device Flow, and give any homepage/callback URL (the device flow uses neither).',
      clientIdSave: 'Save',
      clientIdSaved: 'Saved',
      deviceScopes: 'Scopes requested for this authorization',
      deviceStart: 'Start authorization',
      deviceStarting: 'Requesting device code…',
      deviceCodeLabel: 'Enter this 8-character code on GitHub',
      deviceCopy: 'Copy',
      deviceCopied: 'Copied',
      deviceOpen: 'Open GitHub authorization page',
      deviceWaiting: 'Waiting for you to approve on GitHub… (this page signs in automatically)',
      deviceCancel: 'Cancel',
      deviceCancelled: 'Authorization cancelled',
      cliHelp: 'Prefer the shell? The same credentials can be managed from the plugin directory: the CLI writes the same file this page reads.',
      cliStatus: 'Show status',
      cliLogin: 'Sign in with a token',
      cliLoginDevice: 'Sign in with the device flow',
      cliLogout: 'Sign out',
      cliDirHint: 'Plugin directory',
      configTitle: 'Preferences',
      cloudTitle: 'Cloud cost',
      cloudHelp: 'Codespaces bills by running time: a forgotten machine keeps costing money. This decides how aggressively the agent helps you shut things down, and the default auto-stop for new environments.',
      modeBalanced: 'Balanced',
      modeBalancedNote: 'Warn after 30 min idle, allow reaping after 2 h; never touch a machine active within 15 min. Good default.',
      modeFrugal: 'Frugal',
      modeFrugalNote: 'Warn after 15 min idle, allow reaping after 45 min; new environments auto-stop after 15 min. Pick this when you only occasionally use the cloud.',
      modeManual: 'Manual',
      modeManualNote: 'Report only, never auto-reap. Use this for long training or build runs.',
      idleLabel: 'Idle auto-stop for new Codespaces (minutes)',
      idleHelp: 'The most reliable safeguard: GitHub stops the machine by itself. 15 minutes covers most builds; raise it to 60–120 for long jobs.',
      guardNote: 'Safety guard: when a machine was recently active, stop/delete refuses and asks for an explicit force — it will not kill a session in progress.',
      defaultRepoLabel: 'Default repository',
      defaultRepoPlaceholder: 'owner/name (optional)',
      defaultRepoHelp: 'When empty, github-repo / github-issues / github-pulls require an explicit repo argument.',
      toolsTitle: 'Tools available to the agent',
      toolsHelp: 'These tools appear in new sessions after signing in (existing sessions need a new session or a reload).',
      loading: 'Loading…',
      loadFailed: 'Could not read plugin status',
      saving2: 'Saving…',
      unknownError: 'Unknown error',
      copyFailed: 'Copy failed — select the text manually',
    }

    /** 状态容器：够用就好的最小实现，避免依赖客户端 store 包。 */
    const store = {
      state: {
        status: null,
        account: null,
        deviceFlow: null,
        deviceScope: '',
        storeFile: '',
        /** 宿主推导出的运行时路径（CLI 命令用它拼，避免写死平台相关路径）。 */
        runtime: null,
        tab: 'pat',
        tokenInput: '',
        clientIdInput: '',
        defaultRepoInput: '',
        /** 云端成本模式：balanced / frugal / manual。 */
        costMode: 'balanced',
        /** 创建 Codespace 时的空闲自动停止分钟数（0 = 用平台默认）。 */
        idleTimeoutInput: '15',
        busy: '',
        error: '',
        notice: '',
        copied: false,
      },
      listeners: new Set(),
      set(patch) {
        store.state = { ...store.state, ...patch }
        for (const listener of [...store.listeners]) listener()
      },
      subscribe(listener) {
        store.listeners.add(listener)
        return () => {
          store.listeners.delete(listener)
        }
      },
    }

    /** 订阅 store 的 hook。 */
    function useStore() {
      const [, force] = React.useReducer((count) => count + 1, 0)
      React.useEffect(() => store.subscribe(force), [])
      return store.state
    }

    /** 宿主端点的绝对 URL。 */
    function endpointUrl() {
      const base = typeof document === 'undefined' ? undefined : document.baseURI
      if (base === undefined || base === '') return ENDPOINT
      try {
        return new URL(ENDPOINT, base).href
      } catch {
        return ENDPOINT
      }
    }

    /** 把异常收敛成一行可展示文字。 */
    function messageOf(error) {
      return error instanceof Error ? error.message : String(error)
    }

    /** 宿主返回的业务错误：带上 `code` 与 GitHub 的原始码，供调用方分支。 */
    class ApiError extends Error {
      constructor(message, code, githubCode) {
        super(message)
        this.name = 'ApiError'
        this.code = code
        this.githubCode = githubCode
      }
    }

    /** 调一次宿主动作。失败时把宿主给的 message 原样抛出。 */
    async function call(action, payload) {
      const response = await fetch(endpointUrl(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, ...(payload ?? {}) }),
      })
      let data
      try {
        data = await response.json()
      } catch {
        throw new Error(`HTTP ${String(response.status)}`)
      }
      if (data?.ok !== true) {
        throw new ApiError(
          String(data?.error?.message ?? `HTTP ${String(response.status)}`),
          String(data?.error?.code ?? 'UNKNOWN'),
          data?.error?.githubCode === undefined ? undefined : String(data.error.githubCode),
        )
      }
      return data
    }

    /** 读取状态（GET）。 */
    async function fetchStatus() {
      const response = await fetch(endpointUrl(), { method: 'GET' })
      const data = await response.json()
      if (data?.ok !== true) throw new Error(String(data?.error?.message ?? `HTTP ${String(response.status)}`))
      return data
    }

    /** 只在首次进入设置页时拉取一次状态。 */
    let loadTask
    function ensureLoaded() {
      if (loadTask !== undefined) return loadTask
      loadTask = (async () => {
        store.set({ busy: 'load', error: '' })
        try {
          const data = await fetchStatus()
          store.set({
            status: data.status,
            account: data.account,
            deviceFlow: data.deviceFlow,
            deviceScope: data.deviceScope ?? '',
            storeFile: data.storeFile ?? data.status?.storeFile ?? '',
            clientIdInput: data.status?.clientId ?? '',
            defaultRepoInput: data.status?.defaultRepo ?? '',
            costMode: data.status?.costMode ?? 'balanced',
            idleTimeoutInput: String(data.status?.createIdleTimeout ?? 15),
            runtime: data.runtime ?? null,
            busy: '',
          })
        } catch (error) {
          store.set({ busy: '', error: messageOf(error) })
        }
      })()
      return loadTask
    }

    /** 重新拉取（不重建 loadTask 的缓存）。 */
    async function reload() {
      try {
        const data = await fetchStatus()
        store.set({
          status: data.status,
          account: data.account,
          deviceFlow: data.deviceFlow,
          deviceScope: data.deviceScope ?? store.state.deviceScope,
          storeFile: data.storeFile ?? store.state.storeFile,
        })
        return data
      } catch (error) {
        store.set({ error: messageOf(error) })
        return undefined
      }
    }

    /** 轮询循环：GitHub 侧确认后拿到 token，或因过期/拒绝/出错而停止。 */
    async function pollUntilDone() {
      for (let round = 0; round < 200; round += 1) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
        let data
        try {
          data = await call('pollDevice')
        } catch (error) {
          if (error instanceof ApiError && error.code === 'NO_ATTEMPT') {
            store.set({ busy: '', deviceFlow: null })
            await reload()
            return
          }
          store.set({ busy: '', error: messageOf(error) })
          await reload()
          return
        }
        if (data.pending === true) continue
        store.set({ busy: '', deviceFlow: null, error: '', account: data.account ?? null })
        await reload()
        return
      }
      store.set({ busy: '', error: '轮询次数超出上限，请重新开始授权' })
    }

    /** 保存 PAT。 */
    async function saveToken() {
      const token = store.state.tokenInput.trim()
      if (token === '') {
        // 按钮在空输入时本来就是 disabled，这里只是兜底；文案直接写死，
        // 因为 saveToken 在组件之外，拿不到 t()。
        store.set({ error: '请先填写 token' })
        return
      }
      store.set({ busy: 'save', error: '', notice: '' })
      try {
        const data = await call('saveToken', { token })
        store.set({ busy: '', tokenInput: '', notice: 'signedIn', account: data.account ?? null, status: data.status })
        await reload()
      } catch (error) {
        store.set({ busy: '', error: messageOf(error) })
      }
    }

    /** 保存 client id / 默认仓库 / 云端成本策略。 */
    async function saveConfig() {
      store.set({ busy: 'config', error: '', notice: '' })
      try {
        const data = await call('saveConfig', {
          clientId: store.state.clientIdInput.trim(),
          defaultRepo: store.state.defaultRepoInput.trim(),
          costMode: store.state.costMode,
          createIdleTimeout: Number(store.state.idleTimeoutInput),
        })
        store.set({ busy: '', status: data.status, notice: 'saved' })
      } catch (error) {
        store.set({ busy: '', error: messageOf(error) })
      }
    }

    /**
     * 切模式立刻落盘。
     *
     * 成本策略是「越早生效越好」的那类设置——用户点「极致省钱」的当下就希望下一次
     * 创建环境按新规则走，而不是再点一次保存。
     */
    async function pickCostMode(mode) {
      store.set({ costMode: mode, notice: '' })
      await saveConfig()
    }

    /** 开始设备流授权并进入轮询。 */
    async function startDevice() {
      store.set({ busy: 'device', error: '', notice: '' })
      try {
        const data = await call('startDevice', { clientId: store.state.clientIdInput.trim() })
        store.set({
          busy: 'waiting',
          deviceFlow: data.deviceFlow,
          deviceScope: data.deviceScope ?? '',
          status: data.status,
          copied: false,
        })
        void pollUntilDone()
      } catch (error) {
        store.set({ busy: '', error: messageOf(error) })
      }
    }

    /** 取消设备流授权。 */
    async function cancelDevice() {
      try {
        await call('cancelDevice')
      } catch {
        // 取消失败没有可做的事：状态会被 reload 覆盖。
      }
      store.set({ busy: '', deviceFlow: null, notice: '' })
      await reload()
    }

    /** 退出登录。 */
    async function logout() {
      store.set({ busy: 'logout', error: '', notice: '' })
      try {
        const response = await fetch(endpointUrl(), { method: 'DELETE' })
        const data = await response.json()
        if (data?.ok !== true) throw new Error(String(data?.error?.message ?? 'DELETE 失败'))
        store.set({ busy: '', account: null, status: data.status, notice: 'loggedOut', deviceFlow: null })
      } catch (error) {
        store.set({ busy: '', error: messageOf(error) })
      }
    }

    /** 把文本写进剪贴板；失败时返回 false 以便界面提示。 */
    async function copyText(text) {
      try {
        if (navigator?.clipboard?.writeText !== undefined) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch {
        return false
      }
      return false
    }

    /** 状态卡片。 */
    function StatusCard(props) {
      const t = props.t
      const state = useStore()
      const status = state.status
      const account = state.account
      const connected = status?.configured === true
      const accountOk = account?.ok === true

      return h(
        'div',
        { className: `dshGhCard${connected ? ' dshGhCardOn' : ''}` },
        h('div', { className: 'dshGhCardHead' },
          h('span', { className: `dshGhDot${connected ? ' dshGhDotOn' : ''}`, 'aria-hidden': 'true' }),
          h('span', { className: 'dshGhCardTitle' }, connected ? t('statusConnected') : t('statusDisconnected')),
          connected ? h('span', { className: 'dshGhBadge' }, String(status.tokenKind === '' ? 'token' : status.tokenKind)) : null,
        ),
        connected
          ? h('div', { className: 'dshGhRows' },
            accountOk
              ? h('div', { className: 'dshGhRow' },
                h('span', { className: 'dshGhKey' }, t('account')),
                h('span', { className: 'dshGhVal' },
                  h('a', { className: 'dshGhLink', href: account.htmlUrl, target: '_blank', rel: 'noreferrer' }, `@${String(account.login)}`),
                  account.name === undefined || account.name === '' ? null : `　${String(account.name)}`,
                ),
              )
              : h('div', { className: 'dshGhRow' },
                h('span', { className: 'dshGhKey' }, t('account')),
                h('span', { className: 'dshGhErr' }, account === null ? t('loading') : String(account.message ?? t('unknownError'))),
              ),
            h('div', { className: 'dshGhRow' },
              h('span', { className: 'dshGhKey' }, t('scopes')),
              h('span', { className: 'dshGhVal' },
                Array.isArray(account?.scopes) && account.scopes.length > 0
                  ? account.scopes.map((scope) => h('code', { className: 'dshGhCode', key: scope }, scope))
                  : t('scopesNone'),
              ),
            ),
            account?.rate?.remaining === undefined
              ? null
              : h('div', { className: 'dshGhRow' },
                h('span', { className: 'dshGhKey' }, t('rate')),
                h('span', { className: 'dshGhVal' }, `${String(account.rate.remaining)} / ${String(account.rate.limit ?? '?')}`),
              ),
            h('div', { className: 'dshGhRow' },
              h('span', { className: 'dshGhKey' }, t('source')),
              h('span', { className: 'dshGhVal' }, status.source === 'env' ? t('sourceEnv') : t('sourceStore')),
            ),
            h('div', { className: 'dshGhRow' },
              h('span', { className: 'dshGhKey' }, t('storeFile')),
              h('span', { className: 'dshGhMono' }, store.state.storeFile === '' ? '—' : store.state.storeFile),
            ),
          )
          : h('p', { className: 'dshGhHelp' }, t('help')),
        h('p', { className: 'dshGhNote' }, t('permNote')),
      )
    }

    /** PAT 表单。 */
    function PatPanel(props) {
      const t = props.t
      const state = useStore()
      const busy = state.busy === 'save'
      return h(
        'div',
        { className: 'dshGhPane' },
        h('label', { className: 'dshGhLabel', htmlFor: 'dshGhToken' }, t('patLabel')),
        h('input', {
          id: 'dshGhToken',
          className: 'dshGhInput',
          type: 'password',
          autoComplete: 'off',
          spellCheck: false,
          placeholder: t('patPlaceholder'),
          value: state.tokenInput,
          disabled: busy,
          onChange: (event) => store.set({ tokenInput: event.target.value }),
          onKeyDown: (event) => {
            if (event.key === 'Enter') void saveToken()
          },
        }),
        h('p', { className: 'dshGhHelp' }, t('patHelp')),
        h('div', { className: 'dshGhLinks' },
          h('a', { className: 'dshGhLink', href: 'https://github.com/settings/tokens/new', target: '_blank', rel: 'noreferrer' }, t('patHintClassic')),
          h('a', { className: 'dshGhLink', href: 'https://github.com/settings/personal-access-tokens/new', target: '_blank', rel: 'noreferrer' }, t('patHintFine')),
        ),
        h('div', { className: 'dshGhActions' },
          h('button', {
            type: 'button',
            className: 'dshGhPrimary',
            disabled: busy || state.tokenInput.trim() === '',
            onClick: () => void saveToken(),
          }, busy ? t('saving') : t('save')),
        ),
      )
    }

    /** 设备流面板。 */
    function DevicePanel(props) {
      const t = props.t
      const state = useStore()
      const flow = state.deviceFlow
      const busy = state.busy === 'device'
      const waiting = state.busy === 'waiting'

      return h(
        'div',
        { className: 'dshGhPane' },
        flow === null || flow === undefined
          ? h('div', { className: 'dshGhFields' },
            h('label', { className: 'dshGhLabel', htmlFor: 'dshGhClientId' }, t('clientIdLabel')),
            h('input', {
              id: 'dshGhClientId',
              className: 'dshGhInput',
              type: 'text',
              autoComplete: 'off',
              spellCheck: false,
              placeholder: t('clientIdPlaceholder'),
              value: state.clientIdInput,
              disabled: busy,
              onChange: (event) => store.set({ clientIdInput: event.target.value }),
            }),
            h('p', { className: 'dshGhHelp' }, t('clientIdHelp')),
            h('p', { className: 'dshGhHelp' }, t('deviceHelp')),
            h('div', { className: 'dshGhActions' },
              h('button', {
                type: 'button',
                className: 'dshGhPrimary',
                disabled: busy || state.clientIdInput.trim() === '',
                onClick: () => void startDevice(),
              }, busy ? t('deviceStarting') : t('deviceStart')),
              h('button', {
                type: 'button',
                className: 'dshGhGhost',
                disabled: state.busy === 'config',
                onClick: () => void saveConfig(),
              }, t('clientIdSave')),
            ),
          )
          : h('div', { className: 'dshGhFields' },
            h('div', { className: 'dshGhCodeBox' },
              h('div', { className: 'dshGhCodeLabel' }, t('deviceCodeLabel')),
              h('div', { className: 'dshGhUserCode' }, String(flow.userCode ?? '')),
            ),
            h('div', { className: 'dshGhActions' },
              h('a', {
                className: 'dshGhPrimary dshGhPrimaryLink',
                href: String(flow.verificationUri ?? 'https://github.com/login/device'),
                target: '_blank',
                rel: 'noreferrer',
              }, t('deviceOpen')),
              h('button', {
                type: 'button',
                className: 'dshGhGhost',
                onClick: () => {
                  void copyText(String(flow.userCode ?? '')).then((done) => store.set({ copied: done }))
                },
              }, state.copied ? t('deviceCopied') : t('deviceCopy')),
              h('button', {
                type: 'button',
                className: 'dshGhGhost',
                onClick: () => void cancelDevice(),
              }, t('deviceCancel')),
            ),
            waiting ? h('p', { className: 'dshGhHelp' }, t('deviceWaiting')) : null,
            state.deviceScope === '' ? null : h('p', { className: 'dshGhNote' }, `${t('deviceScopes')}：${state.deviceScope}`),
          ),
      )
    }

    /**
     * CLI 说明面板。
     *
     * 命令与路径**全部来自宿主的运行时信息**（`status.runtime`）。这里曾经写死过
     * 作者机器上的绝对路径——那种东西一旦被别人安装就是纯误导，而且 Windows 之外的
     * 平台会直接不可用。
     */
    function CliPanel(props) {
      const t = props.t
      const state = useStore()
      const runtime = state.runtime ?? {}
      const command = typeof runtime.cliCommand === 'string' && runtime.cliCommand !== '' ? runtime.cliCommand : 'dsh-github'
      const rows = [
        [t('cliStatus'), `${command} status`],
        [t('cliLogin'), `${command} login --token <你的 token>`],
        [t('cliLoginDevice'), `${command} login --device`],
        [t('cliLogout'), `${command} logout`],
      ]
      return h(
        'div',
        { className: 'dshGhPane' },
        h('p', { className: 'dshGhHelp' }, t('cliHelp')),
        h('div', { className: 'dshGhRow' },
          h('span', { className: 'dshGhKey' }, t('cliDirHint')),
          h('span', { className: 'dshGhMono' }, String(runtime.selfPath ?? '(未知)')),
        ),
        rows.map(([label, text]) => h('div', { className: 'dshGhCmd', key: label },
          h('div', { className: 'dshGhCmdLabel' }, label),
          h('code', { className: 'dshGhCmdText' }, text),
        )),
      )
    }

    /** 设置页主体。 */
    function SettingsSection(props) {
      const t = props.t
      const state = useStore()
      React.useEffect(() => {
        void ensureLoaded()
      }, [])

      const tabs = [
        ['pat', t('tabPat')],
        ['device', t('tabDevice')],
        ['cli', t('tabCli')],
      ]

      const tools = [
        'github-status', 'github-account', 'github-repo', 'github-issues',
        'github-pulls', 'github-actions', 'github-search', 'github-api',
      ]

      return h(
        'div',
        { className: 'dshGhSection', 'data-plugin': 'github' },
        h('h2', { className: 'dshGhTitle' }, t('title')),
        h('p', { className: 'dshGhHelp' }, t('help')),

        state.error === '' ? null : h('div', { className: 'dshGhError' }, state.error),
        state.notice === 'loggedOut' ? h('div', { className: 'dshGhNotice' }, t('loggedOut')) : null,
        state.notice === 'signedIn' ? h('div', { className: 'dshGhNotice' }, t('signedIn')) : null,

        state.busy === 'load' ? h('div', { className: 'dshGhMuted' }, t('loading')) : null,
        state.status === null && state.busy !== 'load' ? h('div', { className: 'dshGhError' }, t('loadFailed')) : null,

        state.status === null ? null : h(StatusCard, { t }),

        state.status === null ? null : h('div', { className: 'dshGhActions dshGhActionsTop' },
          h('button', {
            type: 'button',
            className: 'dshGhGhost',
            disabled: state.busy !== '',
            onClick: () => {
              store.set({ busy: 'refresh', error: '', notice: '' })
              void reload().then(() => store.set({ busy: '' }))
            },
          }, state.busy === 'refresh' ? t('refreshing') : t('refresh')),
          state.status.configured === true
            ? h('button', {
              type: 'button',
              className: 'dshGhDanger',
              disabled: state.busy !== '',
              onClick: () => void logout(),
            }, state.busy === 'logout' ? t('loggingOut') : t('logout'))
            : null,
        ),

        h('h3', { className: 'dshGhSubTitle' }, t('loginTitle')),
        h('div', { className: 'dshGhTabs' },
          tabs.map(([id, label]) => h('button', {
            type: 'button',
            key: id,
            className: `dshGhTab${state.tab === id ? ' dshGhTabOn' : ''}`,
            'aria-pressed': state.tab === id ? 'true' : 'false',
            onClick: () => store.set({ tab: id, error: '', notice: '' }),
          }, label)),
        ),

        state.tab === 'pat'
          ? h(PatPanel, { t })
          : state.tab === 'device'
            ? h(DevicePanel, { t })
            : h(CliPanel, { t }),

        h('h3', { className: 'dshGhSubTitle' }, t('cloudTitle')),
        h('p', { className: 'dshGhHelp' }, t('cloudHelp')),
        h('div', { className: 'dshGhTabs' },
          [
            ['balanced', t('modeBalanced'), t('modeBalancedNote')],
            ['frugal', t('modeFrugal'), t('modeFrugalNote')],
            ['manual', t('modeManual'), t('modeManualNote')],
          ].map(([id, label, note]) => h('button', {
            type: 'button',
            key: id,
            className: `dshGhTab${state.costMode === id ? ' dshGhTabOn' : ''}`,
            'aria-pressed': state.costMode === id ? 'true' : 'false',
            title: note,
            disabled: state.busy === 'config',
            onClick: () => void pickCostMode(id),
          }, label)),
        ),
        h('p', { className: 'dshGhNote' }, state.costMode === 'frugal'
          ? t('modeFrugalNote')
          : state.costMode === 'manual'
            ? t('modeManualNote')
            : t('modeBalancedNote')),
        h('div', { className: 'dshGhFields' },
          h('label', { className: 'dshGhLabel', htmlFor: 'dshGhIdle' }, t('idleLabel')),
          h('input', {
            id: 'dshGhIdle',
            className: 'dshGhInput',
            type: 'number',
            min: 5,
            max: 240,
            value: state.idleTimeoutInput,
            disabled: state.busy === 'config',
            onChange: (event) => store.set({ idleTimeoutInput: event.target.value }),
            onBlur: () => void saveConfig(),
          }),
          h('p', { className: 'dshGhHelp' }, t('idleHelp')),
          h('p', { className: 'dshGhNote' }, t('guardNote')),
        ),

        h('h3', { className: 'dshGhSubTitle' }, t('configTitle')),
        h('div', { className: 'dshGhFields' },
          h('label', { className: 'dshGhLabel', htmlFor: 'dshGhDefaultRepo' }, t('defaultRepoLabel')),
          h('input', {
            id: 'dshGhDefaultRepo',
            className: 'dshGhInput',
            type: 'text',
            spellCheck: false,
            placeholder: t('defaultRepoPlaceholder'),
            value: state.defaultRepoInput,
            disabled: state.busy === 'config',
            onChange: (event) => store.set({ defaultRepoInput: event.target.value }),
          }),
          h('p', { className: 'dshGhHelp' }, t('defaultRepoHelp')),
          h('div', { className: 'dshGhActions' },
            h('button', {
              type: 'button',
              className: 'dshGhGhost',
              disabled: state.busy === 'config',
              onClick: () => void saveConfig(),
            }, state.busy === 'config' ? t('saving2') : t('clientIdSave')),
            state.notice === 'saved' ? h('span', { className: 'dshGhNoticeInline' }, t('clientIdSaved')) : null,
          ),
        ),

        h('h3', { className: 'dshGhSubTitle' }, t('toolsTitle')),
        h('p', { className: 'dshGhHelp' }, t('toolsHelp')),
        h('div', { className: 'dshGhTools' }, tools.map((tool) => h('code', { className: 'dshGhCode', key: tool }, tool))),
      )
    }

    /** 注入一次样式表。 */
    function installStyle() {
      if (typeof document === 'undefined') return () => {}
      if (document.querySelector(`style[data-plugin-css=${JSON.stringify(STYLE_ID)}]`) !== null) return () => {}
      const style = document.createElement('style')
      style.dataset.plugin = '@ptfm/dsh-github'
      style.dataset.pluginCss = STYLE_ID
      style.textContent = [
        '.dshGhSection{padding:20px 24px;display:flex;flex-direction:column;gap:12px;overflow-y:auto}',
        '.dshGhTitle{margin:0;color:var(--dsw-alias-label-primary);font-size:16px;font-weight:600}',
        '.dshGhSubTitle{margin:8px 0 0;color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}',
        '.dshGhHelp{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
        '.dshGhNote{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;opacity:.85}',
        '.dshGhMuted{color:var(--dsw-alias-label-secondary);font-size:12px}',
        '.dshGhError{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px}',
        '.dshGhErr{color:var(--dsw-alias-state-error-primary);font-size:12px}',
        '.dshGhNotice{margin:0;color:var(--dsw-alias-state-success-primary);font-size:12px}',
        '.dshGhNoticeInline{color:var(--dsw-alias-state-success-primary);font-size:12px;align-self:center}',
        '.dshGhCard{display:flex;flex-direction:column;gap:10px;padding:14px 16px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-layer-2, transparent)}',
        '.dshGhCardOn{border-color:var(--dsw-alias-brand-primary)}',
        '.dshGhCardHead{display:flex;align-items:center;gap:8px}',
        '.dshGhCardTitle{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600}',
        '.dshGhDot{width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-label-secondary);flex:0 0 auto}',
        '.dshGhDotOn{background:var(--dsw-alias-state-success-primary)}',
        '.dshGhBadge{padding:1px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;color:var(--dsw-alias-label-secondary);font-size:11px}',
        '.dshGhRows{display:flex;flex-direction:column;gap:6px}',
        '.dshGhRow{display:flex;gap:12px;align-items:baseline;font-size:12px;line-height:18px}',
        '.dshGhKey{flex:0 0 108px;color:var(--dsw-alias-label-secondary)}',
        '.dshGhVal{color:var(--dsw-alias-label-primary);display:flex;flex-wrap:wrap;gap:4px;align-items:center;min-width:0}',
        '.dshGhMono{color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all}',
        '.dshGhCode{padding:1px 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}',
        '.dshGhLink{color:var(--dsw-alias-brand-primary);text-decoration:none;font-size:12px}',
        '.dshGhLink:hover{text-decoration:underline}',
        '.dshGhLinks{display:flex;gap:16px;flex-wrap:wrap}',
        '.dshGhFields{display:flex;flex-direction:column;gap:8px}',
        '.dshGhLabel{color:var(--dsw-alias-label-primary);font-size:12px;font-weight:500}',
        '.dshGhInput{padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px}',
        '.dshGhInput:focus{outline:1px solid var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
        '.dshGhActions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
        '.dshGhActionsTop{margin-top:-2px}',
        '.dshGhPrimary{padding:7px 14px;border:1px solid var(--dsw-alias-brand-primary);border-radius:8px;background:var(--dsw-alias-brand-primary);color:#fff;font:inherit;font-size:12px;cursor:pointer}',
        '.dshGhPrimary:disabled{opacity:.5;cursor:default}',
        '.dshGhPrimaryLink{display:inline-block;text-decoration:none}',
        '.dshGhGhost{padding:7px 14px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}',
        '.dshGhGhost:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}',
        '.dshGhGhost:disabled{opacity:.5;cursor:default}',
        '.dshGhDanger{padding:7px 14px;border:1px solid var(--dsw-alias-state-error-primary);border-radius:8px;background:transparent;color:var(--dsw-alias-state-error-primary);font:inherit;font-size:12px;cursor:pointer}',
        '.dshGhTabs{display:flex;gap:6px;flex-wrap:wrap}',
        '.dshGhTab{padding:6px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
        '.dshGhTabOn{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-brand-primary)}',
        '.dshGhCodeBox{display:flex;flex-direction:column;gap:6px;padding:12px 14px;border:1px dashed var(--dsw-alias-border-l1);border-radius:10px}',
        '.dshGhCodeLabel{color:var(--dsw-alias-label-secondary);font-size:12px}',
        '.dshGhUserCode{color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:22px;font-weight:600;letter-spacing:3px}',
        '.dshGhPane{display:flex;flex-direction:column;gap:10px;padding:14px 0 4px}',
        '.dshGhCmd{display:flex;flex-direction:column;gap:4px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px}',
        '.dshGhCmdLabel{color:var(--dsw-alias-label-secondary);font-size:11px}',
        '.dshGhCmdText{color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;word-break:break-all;white-space:pre-wrap}',
        '.dshGhTools{display:flex;flex-wrap:wrap;gap:6px}',
      ].join('')
      document.head.append(style)
      return () => {
        style.remove()
      }
    }

    /** 客户端插件主体。 */
    function apply(ctx) {
      const translate = ctx.locale.bind(NS)
      ctx.effect(() => installStyle(), 'github: styles')
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'github: dictionaries')

      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'github',
        order: 30,
        label: () => translate('title'),
        locale: NS,
      }, SettingsSection))
    }

    module.exports.apply = apply
    module.exports.inject = inject
    return module.exports
  },
})
