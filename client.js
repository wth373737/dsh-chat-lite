// dsh-chat-lite — 客户端侧（浏览器）
//
// 定位：闲聊区的「骨架」。先把闭环立起来，细节后续迭代。
//
// 已确认的官方契约（全部来自 app.asar 源码，非猜测）：
//
//  1. sessions.list 是 store：
//       getSnapshot() -> { ids, byId, phase, projectionsBySession }
//       byId[id] = { id, displayTitle, running, retainedBy, blank, updatedAt,
//                    formatStatus, title?, cwd?, parentId?, origin?, projectionValues? }
//     订阅：subscribe(fn) 返回取消函数。
//
//  2. fork 的父子语义：B.parentId === A.id（B 是从 A 叉出的新分支）。
//     版本族 = 「叉点会话 + 它的全部直接孩子」；叉点恒为第 1 版。
//     依据：官方 flattenLineage（types/client/sessions/lineage.js）。
//
//  3. 当前会话 = retainedBy.mainView > 0 的那个；
//     uiSession.current.getSnapshot().key 即当前会话 id。
//
//  4. 切会话 = uiWorkspace.openSession(id)（官方导航，S1 已实测）。
//
//  5. 建会话必须有 workspaceId（cwd 来自工作区路径）：
//       ctx.sessions.create({ workspaceId }) -> sessionId
//     工作区：ctx.workspaces.list.getSnapshot().items[]（含 workspaceId / path）
//       ctx.workspaces.create({ path }) -> workspace
//     兜底建目录：ctx.uiWorkspace.createDirectory(parent, name)
//
//  6. 会话隔离：按 row.cwd 过滤（dsh-session-query 的 SessionResultFilter 明确支持 cwd 维度）。
//     注意：这只约束「本插件视图」，官方侧栏仍会列出全部会话——已知限制。
//
// 渲染仍然全部交给官方会话视图，本插件不写对话渲染逻辑。

window.__ModuleLoader__.load({
  id: '@local/dsh-chat-lite',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useCallback } = React

    const PANEL_ID = 'chat-lite'
    const FORCE_DESKTOP_KEY = 'dsh-remote-force-desktop'
    const CHAT_CWD_KEY = 'chat-lite:cwd'

    // 闲聊会话的专属目录。可在控制台用 sessionStorage['chat-lite:cwd'] 临时改。
    const DEFAULT_CHAT_CWD = 'I:\\agent\\chat'

    // 闲聊会话使用的 agent preset（定义在 profile 的 cordis.patch.yml：
    // 中文思维链 + 生活助手人设 + 零工具）。改名时两处要一起改。
    const CHAT_PRESET = 'chat-zh'

    // apply(ctx) 里拿到的服务实例，供页面组件使用。
    const SERVICES = {
      sessions: null,
      workspaces: null,
      uiWorkspace: null,
      uiSession: null,
      uiConversation: null,
      workspaceFiles: null,
    }

    function pickLang() {
      try {
        const langs = []
        if (typeof navigator !== 'undefined' && Array.isArray(navigator.languages)) {
          langs.push(...navigator.languages)
        }
        if (typeof navigator !== 'undefined' && navigator.language) {
          langs.push(navigator.language)
        }
        for (const candidate of langs) {
          const value = String(candidate || '').trim().toLowerCase()
          if (value.startsWith('zh')) return 'zh'
          if (value.startsWith('en')) return 'en'
        }
      } catch {
        // 落到默认值
      }
      return 'zh'
    }
    const LANG = pickLang()
    const t = (zh, en) => (LANG === 'zh' ? zh : en)

    // 皮肤会把 --dsw-alias-* 背景变量改成半透明值（skin-center: backgroundOpacity = 10），
    // 所以不能用别名变量当"实心色"，必须写死具体颜色。
    const IS_DARK = (() => {
      try {
        const el = document.documentElement
        if (el.hasAttribute('data-ds-dark-theme')) return true
        if (el.classList.contains('dark')) return true
        return window.matchMedia('(prefers-color-scheme: dark)').matches
      } catch {
        return false
      }
    })()
    const SOLID_BG = IS_DARK ? '#1b1e24' : '#f6f7f9'

    // ---------------------------------------------------------------------
    // 路径与闲聊目录
    // ---------------------------------------------------------------------

    /** Windows 路径归一化：统一反斜杠、去尾部分隔符、小写，便于比较。 */
    function normalizePath(value) {
      if (typeof value !== 'string') return ''
      return value.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    }

    function chatCwd() {
      try {
        const custom = window.sessionStorage.getItem(CHAT_CWD_KEY)
        if (custom && custom.trim()) return custom.trim()
      } catch {
        // 隐私模式下不可读，用默认值
      }
      return DEFAULT_CHAT_CWD
    }

    // ---------------------------------------------------------------------
    // 服务读取
    // ---------------------------------------------------------------------

    /** sessions.list 是 store（getSnapshot + subscribe），不是数组、也不是 get()。 */
    function sessionListStore() {
      const sessions = SERVICES.sessions
      if (!sessions) return null
      const list = sessions.list
      if (!list || typeof list.getSnapshot !== 'function') return null
      return list
    }

    function workspacesStore() {
      const workspaces = SERVICES.workspaces
      if (!workspaces || !workspaces.list) return null
      return typeof workspaces.list.getSnapshot === 'function' ? workspaces.list : null
    }

    /** 版本族 = 叉点会话 + 它的全部直接孩子（叉点恒为第 1 版）。 */
    function versionFamily(byId, sessionId) {
      if (!sessionId) return []
      const row = byId[sessionId]
      if (!row) return []
      const anchorId = row.parentId !== undefined && byId[row.parentId] ? row.parentId : row.id
      const anchor = byId[anchorId]
      if (!anchor) return []
      const children = Object.keys(byId)
        .map((id) => byId[id])
        .filter((item) => item && item.id !== anchorId && item.parentId === anchorId)
      children.sort(compareRows)
      return [anchor].concat(children)
    }

    function compareRows(a, b) {
      const delta = (a.updatedAt || 0) - (b.updatedAt || 0)
      if (delta !== 0) return delta
      return String(a.id).localeCompare(String(b.id))
    }

    /** 属于闲聊目录的会话，按更新时间倒序。 */
    function chatSessions(byId, ids, cwd) {
      const target = normalizePath(cwd)
      if (!target) return []
      return ids
        .map((id) => byId[id])
        .filter((row) => row && normalizePath(row.cwd) === target)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    }

    function hasVersionSiblings(byId, sessionId) {
      return versionFamily(byId, sessionId).length > 1
    }

    function currentSessionId() {
      const uiSession = SERVICES.uiSession
      if (!uiSession || !uiSession.current) return undefined
      try {
        const value = uiSession.current.getSnapshot()
        return value && value.key !== undefined ? String(value.key) : undefined
      } catch {
        return undefined
      }
    }

    // ---------------------------------------------------------------------
    // 极简 store 订阅（不依赖 useSyncExternalStore 的可用性）
    // ---------------------------------------------------------------------

    function useStore(source) {
      const [value, setValue] = useState(() => {
        try {
          return source ? source.getSnapshot() : undefined
        } catch {
          return undefined
        }
      })
      useEffect(() => {
        if (!source || typeof source.subscribe !== 'function') return () => {}
        let alive = true
        const sync = () => {
          if (!alive) return
          try {
            setValue(source.getSnapshot())
          } catch {
            // 快照读取失败时保持上一次的值
          }
        }
        sync()
        const dispose = source.subscribe(sync)
        return () => {
          alive = false
          if (typeof dispose === 'function') dispose()
        }
      }, [source])
      return value
    }

    // ---------------------------------------------------------------------
    // 闲聊会话的建立
    // ---------------------------------------------------------------------

    function findChatWorkspace(items, cwd) {
      const target = normalizePath(cwd)
      for (const item of items || []) {
        if (item && normalizePath(item.path) === target) return item
      }
      return undefined
    }

    /**
     * 确保存在指向闲聊目录的工作区。
     * 目录不存在时先尝试用官方 createDirectory 建出来，再创建一次工作区。
     */
    async function ensureChatWorkspace() {
      const cwd = chatCwd()
      const workspaces = SERVICES.workspaces
      if (!workspaces) throw new Error('workspaces 服务不可用')

      const snapshot = workspaces.list.getSnapshot()
      const existing = findChatWorkspace(snapshot && snapshot.items, cwd)
      if (existing) return existing

      try {
        return await workspaces.create({ path: cwd })
      } catch (firstError) {
        const uiWorkspace = SERVICES.uiWorkspace
        if (uiWorkspace && typeof uiWorkspace.createDirectory === 'function') {
          const cut = cwd.lastIndexOf('\\')
          if (cut > 0) {
            await uiWorkspace.createDirectory(cwd.slice(0, cut), cwd.slice(cut + 1))
            return await workspaces.create({ path: cwd })
          }
        }
        throw firstError
      }
    }

    /**
     * 新建的会话要等列表投影跟上再切。
     * 实测：sessions.create 返回 id 后，sessions.list 里可能还没这行，
     * 此时 openSession 会静默失败（界面停在原会话）。所以轮询等待，超时也仍然切一次。
     */
    async function openWhenVisible(sessionId, timeoutMs = 1500) {
      const uiWorkspace = SERVICES.uiWorkspace
      if (!uiWorkspace || typeof uiWorkspace.openSession !== 'function') return false
      const list = sessionListStore()
      const deadline = Date.now() + timeoutMs
      while (list && Date.now() < deadline) {
        let visible = false
        try {
          const snapshot = list.getSnapshot()
          visible = !!(snapshot && snapshot.byId && snapshot.byId[sessionId])
        } catch {
          visible = false
        }
        if (visible) break
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      uiWorkspace.openSession(sessionId)
      return true
    }

    /**
     * 等主视图真的切到目标会话。
     * openSession 是异步的：调用不抛错不代表切成功，所以要回读 uiSession.current 确认。
     */
    async function waitForCurrent(sessionId, timeoutMs = 1500) {
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        if (currentSessionId() === sessionId) return true
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      return currentSessionId() === sessionId
    }

    /** 等主视图落在一个「闲聊目录」里的会话上。 */
    async function waitForChatCurrent(timeoutMs = 2500) {
      const target = normalizePath(chatCwd())
      const list = sessionListStore()
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const id = currentSessionId()
        if (id && list) {
          let row
          try {
            row = list.getSnapshot().byId[id]
          } catch {
            row = undefined
          }
          if (row && normalizePath(row.cwd) === target) return id
        }
        await new Promise((resolve) => setTimeout(resolve, 60))
      }
      return undefined
    }

    /**
     * 新建（或复用）一个闲聊会话并切过去，返回 { id, switched, via }。
     *
     * 首选官方 uiWorkspace.startSession(workspaceId)：
     *   它走 openWorkspace → connectBlank → replaceMain，会**优先复用该工作区里已有的空会话**，
     *   不会每点一次就攒一条空会话。
     * 兜底才是自己 sessions.create + openSession。
     *
     * switched=false 时调用方必须如实告知，不能假装成功。
     */
    async function createChatSession() {
      const workspace = await ensureChatWorkspace()
      const workspaceId = workspace && (workspace.workspaceId || workspace.id)
      if (!workspaceId) throw new Error('工作区创建后没有返回 workspaceId')
      const sessions = SERVICES.sessions
      if (!sessions || typeof sessions.create !== 'function') throw new Error('sessions.create 不可用')

      // 显式 create，不用 uiWorkspace.startSession：后者会复用工作区里已有的空会话，
      // 而那些空会话是 standard 建的（createInWorkspace 对「preset 未记录」的空白会话放行），
      // 结果会悄悄用回 standard —— 实测就踩到了这个坑。
      const sessionId = await sessions.create({ workspaceId, agentPreset: CHAT_PRESET })
      if (!sessionId) throw new Error('sessions.create 没有返回会话 id')
      const id = String(sessionId)
      await openWhenVisible(id)
      const switched = await waitForCurrent(id, 1500)
      return { id, switched, via: 'create:' + CHAT_PRESET }
    }

    // ---------------------------------------------------------------------
    // 样式
    // ---------------------------------------------------------------------

    const styles = {
      page: {
        padding: '24px 20px',
        color: 'var(--dsw-alias-label-primary)',
        background: SOLID_BG,
        boxSizing: 'border-box',
        height: '100%',
        overflowY: 'auto',
      },
      h1: { fontSize: 16, fontWeight: 600, margin: '0 0 6px' },
      sub: { fontSize: 13, lineHeight: 1.7, color: 'var(--dsw-alias-label-secondary)', margin: '0 0 18px' },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        background: SOLID_BG,
        borderRadius: 10,
        padding: '14px 16px',
        marginBottom: 14,
      },
      cardTitle: {
        fontSize: 12,
        fontWeight: 600,
        color: 'var(--dsw-alias-label-secondary)',
        margin: '0 0 10px',
        letterSpacing: '0.02em',
      },
      note: { fontSize: 12, lineHeight: 1.65, color: 'var(--dsw-alias-label-tertiary)' },
      row: {
        display: 'flex',
        gap: 10,
        alignItems: 'baseline',
        padding: '6px 0',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        fontSize: 13,
      },
      rowFirst: { borderTop: 'none' },
      k: { minWidth: 160, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12.5 },
      mono: {
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
        fontSize: 11.5,
        wordBreak: 'break-all',
        lineHeight: 1.6,
        whiteSpace: 'pre-wrap',
      },
      input: {
        boxSizing: 'border-box',
        width: '100%',
        padding: '8px 10px',
        fontSize: 13,
        color: 'var(--dsw-alias-label-primary)',
        background: 'transparent',
        border: '1px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
      },
      button: {
        padding: '8px 14px',
        fontSize: 13,
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      buttonPrimary: {
        padding: '8px 14px',
        fontSize: 13,
        borderRadius: 8,
        border: '1px solid var(--dsw-alias-brand-primary)',
        background: 'var(--dsw-alias-brand-primary)',
        color: '#fff',
        cursor: 'pointer',
      },
      buttonSmall: {
        padding: '2px 9px',
        fontSize: 12,
        borderRadius: 6,
        border: '1px solid var(--dsw-alias-border-l2)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
        lineHeight: 1.6,
      },
      bar: { display: 'flex', gap: 8, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' },
    }

    function Row({ label, value, first }) {
      return h(
        'div',
        { style: first ? Object.assign({}, styles.row, styles.rowFirst) : styles.row },
        h('div', { style: styles.k }, label),
        h('div', { style: { fontSize: 13, wordBreak: 'break-all' } }, value),
      )
    }

    /** 安全地读一个可能抛异常的服务字段。 */
    function readService(name, field) {
      try {
        const service = SERVICES[name]
        if (!service) return '服务未注入'
        const value = field ? service[field] : service
        if (typeof value === 'function') return 'function'
        if (value === undefined) return 'undefined'
        if (value === null) return 'null'
        return typeof value
      } catch (error) {
        return '读取失败: ' + String((error && error.message) || error)
      }
    }

    /** 相对时间，聊天列表够用即可。 */
    function relativeTime(timestamp) {
      if (!timestamp) return ''
      const delta = Date.now() - Number(timestamp)
      if (!Number.isFinite(delta) || delta < 0) return ''
      const minute = 60 * 1000
      const hour = 60 * minute
      const day = 24 * hour
      if (delta < minute) return t('刚刚', 'just now')
      if (delta < hour) return Math.floor(delta / minute) + t(' 分钟前', 'm ago')
      if (delta < day) return Math.floor(delta / hour) + t(' 小时前', 'h ago')
      if (delta < 7 * day) return Math.floor(delta / day) + t(' 天前', 'd ago')
      try {
        return new Date(Number(timestamp)).toLocaleDateString()
      } catch {
        return ''
      }
    }

    /** 统一的切换入口：官方导航动作。 */
    function useSwitchSession(setResult) {
      return useCallback((id) => {
        const workspace = SERVICES.uiWorkspace
        if (!workspace || typeof workspace.openSession !== 'function') {
          setResult({ ok: false, message: 'uiWorkspace.openSession 不可用' })
          return
        }
        try {
          const value = workspace.openSession(id)
          if (value && typeof value.then === 'function') {
            value.then(
              () => setResult(null),
              (error) => setResult({ ok: false, message: '切换失败', detail: String((error && error.message) || error) }),
            )
          }
        } catch (error) {
          setResult({ ok: false, message: '切换失败', detail: String((error && error.message) || error) })
        }
      }, [setResult])
    }

    // ---------------------------------------------------------------------
    // 版本切换器
    // ---------------------------------------------------------------------

    function VersionSwitcher({ byId, currentId, onSwitch, compact }) {
      const group = versionFamily(byId, currentId)
      if (group.length < 2) return null
      const index = group.findIndex((item) => item.id === currentId)
      if (index < 0) return null
      const at = (offset) => group[(index + offset + group.length) % group.length]
      const label = (i) => t(`版本 ${i + 1}/${group.length}`, `Version ${i + 1}/${group.length}`)
      const buttonStyle = compact ? styles.buttonSmall : styles.button
      return h(
        'div',
        { style: { display: 'flex', gap: 6, alignItems: 'center', whiteSpace: 'nowrap' } },
        h('button', {
          type: 'button',
          title: label(index === 0 ? group.length - 1 : index - 1) + ' · ' + at(-1).displayTitle,
          style: buttonStyle,
          onClick: () => onSwitch(at(-1).id),
        }, '‹'),
        h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' } }, label(index)),
        h('button', {
          type: 'button',
          title: label(index === group.length - 1 ? 0 : index + 1) + ' · ' + at(1).displayTitle,
          style: buttonStyle,
          onClick: () => onSwitch(at(1).id),
        }, '›'),
      )
    }

    /**
     * 输入框右侧的版本条：每会话一个实例，没有版本时完全不可见。
     * 该插槽由 dsh-client-ui-conversation 声明为 { kind: 'list', scope: 'session' }，
     * 官方在输入框里对每个会话只渲染一次（不存在 turnTail「每轮都渲染」的问题）。
     */
    function SessionVersionBar() {
      const list = useStore(sessionListStore())
      const currentBinding = useStore(SERVICES.uiSession && SERVICES.uiSession.current)
      const byId = (list && list.byId) || {}
      const currentId =
        currentBinding && currentBinding.key !== undefined ? String(currentBinding.key) : undefined
      const switchTo = useCallback((id) => {
        try {
          const value = SERVICES.uiWorkspace.openSession(id)
          if (value && typeof value.then === 'function') {
            value.catch((error) => console.warn('[chat-lite] 切换版本失败', error))
          }
        } catch (error) {
          console.warn('[chat-lite] 切换版本失败', error)
        }
      }, [])
      return h(VersionSwitcher, { byId, currentId, onSwitch: switchTo, compact: true })
    }

    // ---------------------------------------------------------------------
    // A 路线试点：让宿主自己创建会话（目录 + 注册表 + 缓存都由宿主写）
    // ---------------------------------------------------------------------

    /**
     * 用官方 sessions.create 让宿主创建会话（**不指定 id**，由宿主生成）。
     * 这样目录、注册表、缓存三样都由宿主自己写，身份绝对合法；
     * 之后我按宿主返回的 id 回填日志内容，就能单独验证"事件流是否被接受"。
     */
    async function createHostSessions(count) {
      const workspace = await ensureChatWorkspace()
      const workspaceId = workspace && (workspace.workspaceId || workspace.id)
      if (!workspaceId) throw new Error('工作区没有 workspaceId')
      const sessions = SERVICES.sessions
      if (!sessions || typeof sessions.create !== 'function') throw new Error('sessions.create 不可用')

      const lines = []
      for (let i = 0; i < count; i++) {
        try {
          const created = await sessions.create({ workspaceId })
          lines.push('✓ ' + String(created))
        } catch (error) {
          lines.push('✗ ' + String((error && error.message) || error))
        }
      }
      return lines.join('\n')
    }

    // ---------------------------------------------------------------------
    // B 路线：历史库（.chat-lite/ 在闲聊工作区里，通过 workspaceFiles 读取）
    // ---------------------------------------------------------------------

    const HISTORY_DIR = '.chat-lite'
    const HISTORY_PAGE = 50

    /** 让宿主立刻把闲聊工作区里的会话归档一次（只写 <chatDir>/.chat-lite/）。 */
    async function requestArchive() {
      try {
        const response = await fetch('/chat-lite/api/archive', {
          method: 'POST',
          credentials: 'same-origin',
        })
        const json = await response.json()
        return json && json.ok ? json : null
      } catch {
        return null
      }
    }

    /** 找一个属于闲聊目录的会话 id —— workspaceFiles 是会话作用域的，必须借它读文件。 */
    function chatSessionIdForFiles(list, currentId) {
      const rows = (list && list.ids ? list.ids : []).map((id) => list.byId[id]).filter(Boolean)
      const target = normalizePath(chatCwd())
      const inChat = rows.filter((row) => normalizePath(row.cwd) === target)
      if (currentId && inChat.some((row) => row.id === currentId)) return currentId
      return inChat.length > 0 ? inChat[0].id : undefined
    }

    function unwrapRemote(result) {
      if (result && typeof result === 'object' && 'ok' in result && 'value' in result) return result.value
      return result
    }

    /** 分页读完 index.jsonl（每页 2000 行）。 */
    async function readHistoryIndex(sessionId) {
      const api = SERVICES.workspaceFiles
      if (!api || typeof api.read !== 'function') throw new Error('workspaceFiles.read 不可用')
      const lines = []
      let offset = 1
      for (let guard = 0; guard < 30; guard++) {
        const value = unwrapRemote(await api.read(sessionId, HISTORY_DIR + '/index.jsonl', { offset, limit: 2000 }))
        if (!value || typeof value.text !== 'string') break
        if (value.text.length > 0) {
          for (const line of value.text.split('\n')) if (line.trim()) lines.push(line)
        }
        if (value.eof) break
        const step = Number(value.lines || 0)
        if (!step) break
        offset = Number(value.offset || offset) + step
      }
      const rows = []
      for (const line of lines) {
        try {
          rows.push(JSON.parse(line))
        } catch {
          // 跳过坏行
        }
      }
      rows.sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')))
      return rows
    }

    /** 分页读完单个历史会话（.jsonl：首行 meta，其后一行一条消息）。 */
    async function readHistoryDoc(sessionId, historyId) {
      const api = SERVICES.workspaceFiles
      if (!api || typeof api.read !== 'function') throw new Error('workspaceFiles.read 不可用')
      const lines = []
      let offset = 1
      for (let guard = 0; guard < 200; guard++) {
        const value = unwrapRemote(
          await api.read(sessionId, HISTORY_DIR + '/sessions/' + historyId + '.jsonl', { offset, limit: 400 }),
        )
        if (!value || typeof value.text !== 'string') break
        if (value.text.length > 0) {
          for (const line of value.text.split('\n')) if (line.trim()) lines.push(line)
        }
        if (value.eof) break
        const step = Number(value.lines || 0)
        if (!step) break
        offset = Number(value.offset || offset) + step
      }
      const doc = { meta: null, messages: [] }
      for (const line of lines) {
        let row
        try {
          row = JSON.parse(line)
        } catch {
          continue
        }
        if (row.kind === 'meta') doc.meta = row
        else doc.messages.push(row)
      }
      return doc
    }

    // ---------------------------------------------------------------------
    // 极简 Markdown 渲染（代码块 / 标题 / 列表 / 粗体 / 行内代码）
    // ---------------------------------------------------------------------

    function renderInline(text, keyPrefix) {
      const nodes = []
      const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/
      const parts = String(text).split(pattern)
      parts.forEach((part, index) => {
        if (!part) return
        if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
          nodes.push(h('strong', { key: keyPrefix + 'b' + index }, part.slice(2, -2)))
        } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
          nodes.push(
            h(
              'code',
              {
                key: keyPrefix + 'c' + index,
                style: {
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: '0.92em',
                  padding: '1px 4px',
                  borderRadius: 4,
                  background: 'rgba(127,127,127,0.16)',
                },
              },
              part.slice(1, -1),
            ),
          )
        } else {
          nodes.push(part)
        }
      })
      return nodes
    }

    function renderMarkdown(text, keyPrefix) {
      const lines = String(text || '').split('\n')
      const blocks = []
      let paragraph = []
      let index = 0
      const flush = () => {
        if (paragraph.length === 0) return
        blocks.push(
          h(
            'div',
            { key: keyPrefix + 'p' + index++, style: { margin: '6px 0', lineHeight: 1.72, whiteSpace: 'pre-wrap' } },
            renderInline(paragraph.join('\n'), keyPrefix + index),
          ),
        )
        paragraph = []
      }
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        if (/^\s*```/.test(line)) {
          flush()
          const code = []
          i++
          while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++])
          blocks.push(
            h(
              'pre',
              {
                key: keyPrefix + 'code' + index++,
                style: {
                  margin: '8px 0',
                  padding: '10px 12px',
                  borderRadius: 8,
                  overflowX: 'auto',
                  background: 'rgba(127,127,127,0.14)',
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 12,
                  lineHeight: 1.6,
                },
              },
              h('code', null, code.join('\n')),
            ),
          )
          continue
        }
        const heading = /^(#{1,4})\s+(.*)$/.exec(line)
        if (heading) {
          flush()
          const size = heading[1].length === 1 ? 16 : heading[1].length === 2 ? 15 : 14
          blocks.push(
            h(
              'div',
              { key: keyPrefix + 'h' + index++, style: { fontSize: size, fontWeight: 600, margin: '10px 0 4px' } },
              renderInline(heading[2], keyPrefix + 'h' + index),
            ),
          )
          continue
        }
        const bullet = /^\s*[-*]\s+(.*)$/.exec(line)
        if (bullet) {
          flush()
          blocks.push(
            h(
              'div',
              { key: keyPrefix + 'li' + index++, style: { margin: '3px 0 3px 18px', lineHeight: 1.7 } },
              '• ',
              renderInline(bullet[1], keyPrefix + 'li' + index),
            ),
          )
          continue
        }
        if (line.trim() === '') {
          flush()
          continue
        }
        paragraph.push(line)
      }
      flush()
      return blocks
    }

    // ---------------------------------------------------------------------
    // 附件渲染（图片走 readBytes → data URL）
    // ---------------------------------------------------------------------

    const MIME_BY_EXT = {
      webp: 'image/webp',
      png: 'image/png',
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      gif: 'image/gif',
      bmp: 'image/bmp',
      svg: 'image/svg+xml',
    }

    function mimeOf(name) {
      const ext = String(name || '').split('.').pop().toLowerCase()
      return MIME_BY_EXT[ext] || 'application/octet-stream'
    }

    function toBase64(bytes) {
      let binary = ''
      const chunk = 0x8000
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
      }
      return window.btoa(binary)
    }

    function formatBytes(size) {
      const n = Number(size || 0)
      if (!n) return ''
      if (n < 1024) return n + ' B'
      if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB'
      return (n / (1024 * 1024)).toFixed(1) + ' MB'
    }

    function HistoryAttachment({ sessionId, historyId, file, alignEnd }) {
      const [src, setSrc] = useState(null)
      const [error, setError] = useState(null)
      const isImage = file.image === true && mimeOf(file.name).startsWith('image/')
      const tooBig = Number(file.size || 0) > 12 * 1024 * 1024

      useEffect(() => {
        if (!isImage || tooBig || !sessionId || !historyId) return () => {}
        let alive = true
        const api = SERVICES.workspaceFiles
        if (!api || typeof api.readBytes !== 'function') {
          setError('readBytes 不可用')
          return () => {}
        }
        // 原件在 .chat-lite/files/<历史会话id>/<文件名>
        const target = HISTORY_DIR + '/files/' + historyId + '/' + file.name
        api
          .readBytes(sessionId, target, {})
          .then((result) => {
            if (!alive) return
            const value = unwrapRemote(result)
            const bytes = value && value.data
            if (!bytes || bytes.length === 0) {
              setError(t('图片读取失败', 'Image read failed'))
              return
            }
            setSrc('data:' + mimeOf(file.name) + ';base64,' + toBase64(bytes))
          })
          .catch((cause) => {
            if (alive) setError(String((cause && cause.message) || cause))
          })
        return () => {
          alive = false
        }
      }, [sessionId, historyId, file.name, isImage, tooBig])

      if (!isImage || tooBig) {
        return h(
          'div',
          {
            style: {
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 8px',
              borderRadius: 6,
              border: '1px solid var(--dsw-alias-border-l2)',
              fontSize: 12,
              color: 'var(--dsw-alias-label-secondary)',
            },
            title: file.label,
          },
          '📎 ' + String(file.label || file.name).slice(0, 40),
          file.size ? '  ·  ' + formatBytes(file.size) : '',
          tooBig ? '  ·  ' + t('过大未加载', 'too large') : '',
        )
      }

      if (error) {
        return h(
          'div',
          { style: { fontSize: 12, color: 'var(--dsw-alias-state-error-primary, #b3261e)' } },
          '⚠ ' + error,
        )
      }

      if (!src) {
        return h(
          'div',
          {
            style: {
              width: 120,
              height: 90,
              borderRadius: 8,
              background: 'rgba(127,127,127,0.14)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 12,
              color: 'var(--dsw-alias-label-tertiary)',
            },
          },
          t('加载中…', 'loading…'),
        )
      }

      return h('img', {
        src,
        alt: file.label || file.name,
        style: {
          display: 'block',
          maxWidth: alignEnd ? 260 : '100%',
          maxHeight: 320,
          borderRadius: 8,
          border: '1px solid var(--dsw-alias-border-l1)',
        },
      })
    }

    function HistoryFiles({ sessionId, historyId, files, alignEnd }) {
      if (!Array.isArray(files) || files.length === 0) return null
      return h(
        'div',
        {
          style: {
            display: 'flex',
            gap: 6,
            flexWrap: 'wrap',
            marginBottom: 8,
            justifyContent: alignEnd ? 'flex-end' : 'flex-start',
          },
        },
        files.map((file, index) =>
          h(HistoryAttachment, { key: file.name + index, sessionId, historyId, file, alignEnd }),
        ),
      )
    }

    // ---------------------------------------------------------------------
    // 继续对话：把历史转录注入一个新会话
    // ---------------------------------------------------------------------

    /**
     * 带的条数：默认**全部**（单条对话的完整上文）。
     * 记忆（跨会话）是另一层能力，不在这里做。
     * 超过安全阈值时才截断，并在转录里明确告知模型"更早的看不到"。
     */
    const CONTINUE_MESSAGE_LIMIT = Number.POSITIVE_INFINITY
    const CONTINUE_CHAR_SOFT_CAP = 600000

    function escapeXml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
    }

    /**
     * 构造注入用的转录。
     * 角色**只由 role 属性决定**，正文原样保留（不改写用户的话，也不依赖正文里的人称代词）。
     */
    function buildTranscript(doc, limit) {
      const all = doc.messages || []
      // limit 为 Infinity 时带全部；只有超过字符软上限才截断
      let take = Number.isFinite(limit) ? Math.max(1, limit) : all.length
      let slice = all.slice(Math.max(0, all.length - take))
      while (
        slice.length > 2 &&
        slice.reduce((sum, m) => sum + String(m.text || '').length, 0) > CONTINUE_CHAR_SOFT_CAP
      ) {
        slice = slice.slice(1)
      }
      const omitted = all.length - slice.length
      const head = [
        '以下是你（role="assistant"）与用户（role="user"）此前的一段对话，逐字转录，未做改写。',
        '角色由 <message role="…"> 属性决定；正文中出现的任何「你 / 我 / 他」等代词都不改变角色归属。',
        '请把 role="assistant" 的内容当作你自己先前说过的话，把 role="user" 的内容当作用户先前说过的话。',
        '从这里接着继续这段对话：不要复述或总结历史，先用一句话确认你已接上，然后等我提出下一个问题。',
        doc.meta && doc.meta.title ? '会话标题：' + escapeXml(doc.meta.title) : '',
        omitted > 0 ? '（更早的 ' + omitted + ' 条消息没有包含在内，请勿假设你能看到它们。）' : '',
      ]
        .filter(Boolean)
        .join('\n')

      const body = slice
        .map((message, index) => {
          const role = message.role === 'user' ? 'user' : 'assistant'
          return (
            '<message role="' + role + '" seq="' + (index + 1) + '">' +
            escapeXml(message.text) +
            '</message>'
          )
        })
        .join('\n')

      return '<transcript roles="authoritative">\n' + head + '\n\n' + body + '\n</transcript>'
    }

    /** 新建一个闲聊会话并往它发第一条消息（= 继续对话）。返回诊断轨迹便于排错。 */
    async function continueInNewSession(doc, limit) {
      const trace = []
      const workspace = await ensureChatWorkspace()
      const workspaceId = workspace && (workspace.workspaceId || workspace.id)
      if (!workspaceId) throw new Error('工作区没有 workspaceId')
      trace.push('workspace=' + workspaceId)

      const uiWorkspace = SERVICES.uiWorkspace
      // 同样先显式 create，避免复用 standard 的空白会话
      const created = await SERVICES.sessions.create({ workspaceId, agentPreset: CHAT_PRESET })
      await openWhenVisible(String(created))
      trace.push('create(' + CHAT_PRESET + ') ' + String(created))

      const sessionId = await waitForChatCurrent(2500)
      if (!sessionId) throw new Error('没能切到新的闲聊会话（' + trace.join(' → ') + '）')
      trace.push('current=' + sessionId)

      const sessions = SERVICES.sessions
      let session
      // 优先 binding(id).session（官方 ui-session 就是这么拿的），再退回 get(id)
      if (sessions && typeof sessions.binding === 'function') {
        const owner = sessions.binding(sessionId)
        if (owner && owner.session) session = owner.session
        trace.push('binding=' + (owner ? 'ok' : 'undefined'))
      }
      if (!session && sessions && typeof sessions.get === 'function') {
        session = sessions.get(sessionId)
        trace.push('get=' + (session ? 'ok' : 'undefined'))
      }
      if (!session) throw new Error('拿不到会话对象（' + trace.join(' → ') + '）')
      if (typeof session.prompt !== 'function') {
        throw new Error('会话对象没有 prompt()（' + trace.join(' → ') + '）')
      }

      const text = buildTranscript(doc, limit)
      const result = await session.prompt([{ type: 'text', text }], 'queue')
      if (result && result.ok === false) {
        throw new Error('发送被拒：' + JSON.stringify(result.error || result).slice(0, 240))
      }
      trace.push('prompt ok')
      return { sessionId, chars: text.length, trace }
    }

    /**
     * 是否是「本机闲聊会话」（自动归档）而不是从导出包导入的。
     * 本机会话 id 形如 session-<uuid>；导入的是裸 uuid。
     */
    function isLocalSessionId(id) {
      return String(id || '').startsWith('session-')
    }

    /** 把已排序的行按「年-月」分组（用于列表分段显示）。 */
    function groupByMonth(rows) {
      const groups = []
      let current = null
      for (const row of rows) {
        const key = String(row.updated || '').slice(0, 7) || t('未知日期', 'unknown')
        if (!current || current.key !== key) {
          current = { key, rows: [] }
          groups.push(current)
        }
        current.rows.push(row)
      }
      return groups
    }

    // 全文搜索的取消令牌（换查询或离开时递增，旧任务自动作废）
    let deepSearchToken = 0

    /**
     * 全文搜索：顺序读 search/c0000.jsonl …，命中即收集。
     * 停止条件：命中数够、令牌失效、或扫完所有块。
     */
    async function searchFullText(sessionId, query, options) {
      const api = SERVICES.workspaceFiles
      if (!api || typeof api.read !== 'function') throw new Error('workspaceFiles.read 不可用')
      const token = ++deepSearchToken
      const needle = String(query || '').toLowerCase()
      if (!needle) return { matches: [], scanned: 0, total: 0, cancelled: false }

      let totalChunks = 0
      try {
        const manifest = unwrapRemote(await api.read(sessionId, HISTORY_DIR + '/search/manifest.json', {}))
        const parsed = manifest && manifest.text ? JSON.parse(manifest.text.replace(/\n/g, '')) : null
        totalChunks = parsed && parsed.chunks ? Number(parsed.chunks) : 0
      } catch {
        totalChunks = 0
      }
      // manifest 读不到时退化：一直扫到空块为止（上限 200 块）
      if (!totalChunks) totalChunks = 200

      const matches = []
      const snippets = new Map()
      let scanned = 0
      let readError = ''

      const takeSnippet = (id, source, at) => {
        if (snippets.has(id)) return
        const start = Math.max(0, at - 40)
        const end = Math.min(source.length, at + needle.length + 80)
        const body = source.slice(start, end).replace(/\s+/g, ' ').trim()
        snippets.set(id, (start > 0 ? '…' : '') + body + (end < source.length ? '…' : ''))
      }

      for (let index = 0; index < totalChunks; index++) {
        if (token !== deepSearchToken) return { matches, snippets, scanned, total: totalChunks, cancelled: true, readError }
        const name = 'c' + String(index).padStart(4, '0') + '.jsonl'
        let value
        try {
          value = unwrapRemote(await api.read(sessionId, HISTORY_DIR + '/search/' + name, { limit: 4000 }))
        } catch (error) {
          readError = 'chunk ' + index + ': ' + String((error && error.message) || error)
          break
        }
        if (!value || typeof value.text !== 'string' || value.text.length === 0) break
        for (const line of value.text.split('\n')) {
          if (!line.trim()) continue
          try {
            const row = JSON.parse(line)
            const source = String(row.t || '')
            const at = source.toLowerCase().indexOf(needle)
            if (at >= 0) {
              takeSnippet(row.id, source, at)
              if (!matches.includes(row.id)) matches.push(row.id)
            }
          } catch {
            readError = 'chunk ' + index + ': bad line'
          }
        }
        scanned = index + 1
        if (options && typeof options.onProgress === 'function') {
          options.onProgress(scanned, totalChunks, matches.length)
        }
        if (options && options.maxMatches && matches.length >= options.maxMatches) break
      }

      // 闲聊工作区里新归档的会话放在 live.jsonl（宿主每次归档时重建），优先扫它
      try {
        const live = unwrapRemote(
          await api.read(sessionId, HISTORY_DIR + '/search/live.jsonl', { limit: 20000 }),
        )
        if (live && typeof live.text === 'string') {
          for (const line of live.text.split('\n')) {
            if (!line.trim()) continue
            try {
              const row = JSON.parse(line)
              const source = String(row.t || '')
              const at = source.toLowerCase().indexOf(needle)
              if (at >= 0) {
                takeSnippet(row.id, source, at)
                if (!matches.includes(row.id)) matches.unshift(row.id)
              }
            } catch {
              // 跳过坏行
            }
          }
        }
      } catch {
        // 还没归档过，忽略
      }

      return { matches, snippets, scanned, total: totalChunks, cancelled: false, readError }
    }

    /** 把文本里命中查询的部分包成高亮节点（大小写不敏感，最多 50 处）。 */
    function highlight(text, query) {
      const source = String(text == null ? '' : text)
      const needle = String(query || '')
      if (!needle) return source
      const lower = source.toLowerCase()
      const needleLower = needle.toLowerCase()
      const parts = []
      let at = 0
      let guard = 0
      while (guard++ < 50) {
        const found = lower.indexOf(needleLower, at)
        if (found < 0) {
          parts.push(source.slice(at))
          break
        }
        if (found > at) parts.push(source.slice(at, found))
        parts.push(
          h(
            'mark',
            {
              key: 'hl' + found,
              style: {
                background: 'rgba(64,120,255,0.26)',
                color: 'inherit',
                borderRadius: 3,
                padding: '0 1px',
              },
            },
            source.slice(found, found + needle.length),
          ),
        )
        at = found + needle.length
      }
      return parts
    }

    // ---------------------------------------------------------------------
    // 输入框左侧：本会话的联网开关（即时生效，不需要重启）
    // ---------------------------------------------------------------------

    const SESSION_WEB_API = '/chat-lite/api/session-web'
    const webOffKey = (sessionId) => 'chat-lite:web-off:' + sessionId

    function ComposerWebToggle(props) {
      const currentBinding = useStore(SERVICES.uiSession && SERVICES.uiSession.current)
      const sessionId =
        (props && props.sessionId) ||
        (currentBinding && currentBinding.key !== undefined ? String(currentBinding.key) : undefined)
      const [enabled, setEnabled] = useState(null)
      const [busy, setBusy] = useState(false)

      useEffect(() => {
        if (!sessionId) return () => {}
        let alive = true
        const stored = window.localStorage.getItem(webOffKey(sessionId)) === '1'
        fetch(SESSION_WEB_API + '?sessionId=' + encodeURIComponent(sessionId), {
          credentials: 'same-origin',
        })
          .then((response) => response.json())
          .then(async (json) => {
            if (!alive || !json.ok) return
            // 宿主状态是权威；如果本地记录要求关闭而宿主还开着，重放一次
            if (json.enabled === false) {
              setEnabled(false)
              return
            }
            if (stored) {
              await fetch(SESSION_WEB_API, {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId, enabled: false }),
              })
              if (alive) setEnabled(false)
              return
            }
            setEnabled(true)
          })
          .catch(() => {})
        return () => {
          alive = false
        }
      }, [sessionId])

      const toggle = useCallback(async () => {
        if (!sessionId) return
        const next = !(enabled === true)
        setBusy(true)
        try {
          const response = await fetch(SESSION_WEB_API, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ sessionId, enabled: next }),
          })
          const json = await response.json()
          if (!json.ok) throw new Error(json.error || 'HTTP ' + response.status)
          setEnabled(next)
          window.localStorage.setItem(webOffKey(sessionId), next ? '0' : '1')
        } catch (error) {
          console.warn('[chat-lite] 切换联网失败', error)
        } finally {
          setBusy(false)
        }
      }, [sessionId, enabled])

      if (!sessionId) return null
      const on = enabled === true
      return h(
        'button',
        {
          type: 'button',
          onClick: toggle,
          disabled: busy || enabled === null,
          title: on
            ? t('本会话允许联网搜索，点击关闭', 'Web search on for this session; click to turn off')
            : t('本会话禁止联网搜索，点击开启', 'Web search off for this session; click to turn on'),
          style: {
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5,
            height: 28,
            padding: '0 10px',
            borderRadius: 14,
            fontSize: 12,
            cursor: busy ? 'default' : 'pointer',
            border: '1px solid ' + (on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'),
            background: on ? 'rgba(64,120,255,0.12)' : 'transparent',
            color: on ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-label-tertiary)',
          },
        },
        '🌐',
        enabled === null ? '…' : on ? t('联网', 'Web') : t('联网关', 'Web off'),
      )
    }

    // ---------------------------------------------------------------------
    // 设置页：查看 / 编辑闲聊 preset 的系统提示词
    // ---------------------------------------------------------------------

    const PERSONA_API = '/chat-lite/api/persona'
    const WEB_API = '/chat-lite/api/web'

    function ChatLiteSettings() {
      const [text, setText] = useState('')
      const [saved, setSaved] = useState('')
      const [filePath, setFilePath] = useState('')
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null)
      const [webEnabled, setWebEnabled] = useState(null)
      const [webBusy, setWebBusy] = useState(false)
      const [webMessage, setWebMessage] = useState(null)

      const load = useCallback(async () => {
        setBusy(true)
        setMessage(null)
        try {
          const response = await fetch(PERSONA_API, { credentials: 'same-origin' })
          const json = await response.json()
          if (!json.ok) throw new Error(json.error || 'HTTP ' + response.status)
          setText(json.prefix || '')
          setSaved(json.prefix || '')
          setFilePath(json.path || '')
        } catch (error) {
          setMessage({ ok: false, text: String((error && error.message) || error) })
        } finally {
          setBusy(false)
        }
      }, [])

      useEffect(() => {
        load()
      }, [load])

      const save = useCallback(async () => {
        setBusy(true)
        setMessage(null)
        try {
          const response = await fetch(PERSONA_API, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ prefix: text }),
          })
          const json = await response.json()
          if (!json.ok) throw new Error(json.error || 'HTTP ' + response.status)
          setSaved(text)
          setMessage({
            ok: true,
            text:
              t('已保存，重启 DSH 后生效。', 'Saved; restart DSH to apply.') +
              '\n' + t('备份：', 'backup: ') + (json.backup || '-'),
          })
        } catch (error) {
          setMessage({ ok: false, text: String((error && error.message) || error) })
        } finally {
          setBusy(false)
        }
      }, [text])

      const dirty = text !== saved

      // 联网搜索开关
      const loadWeb = useCallback(async () => {
        try {
          const response = await fetch(WEB_API, { credentials: 'same-origin' })
          const json = await response.json()
          if (!json.ok) throw new Error(json.error || 'HTTP ' + response.status)
          setWebEnabled(json.enabled === true)
        } catch (error) {
          setWebMessage({ ok: false, text: String((error && error.message) || error) })
        }
      }, [])

      useEffect(() => {
        loadWeb()
      }, [loadWeb])

      const toggleWeb = useCallback(
        async (next) => {
          setWebBusy(true)
          setWebMessage(null)
          try {
            const response = await fetch(WEB_API, {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ enabled: next === true }),
            })
            const json = await response.json()
            if (!json.ok) throw new Error(json.error || 'HTTP ' + response.status)
            setWebEnabled(json.enabled === true)
            setWebMessage({
              ok: true,
              text:
                (json.enabled
                  ? t('已开启，重启 DSH 后闲聊会话可联网。', 'Enabled; restart DSH to apply.')
                  : t('已关闭，重启 DSH 后闲聊会话只剩对话能力。', 'Disabled; restart DSH to apply.')) +
                '\n' + t('备份：', 'backup: ') + (json.backup || '-'),
            })
          } catch (error) {
            setWebMessage({ ok: false, text: String((error && error.message) || error) })
          } finally {
            setWebBusy(false)
          }
        },
        [],
      )

      return h(
        'div',
        { style: styles.page },
        h('div', { style: styles.h1 }, t('闲聊区', 'Chat Lite')),
        h(
          'div',
          { style: styles.sub },
          t(
            '闲聊会话使用 preset「chat-zh」。下面是它的系统提示词（persona 前缀）——它决定回答风格，也决定内部思考用哪种语言。',
            'Chat sessions use the "chat-zh" preset. Below is its system prompt (persona prefix); it drives both style and the language of internal reasoning.',
          ),
        ),
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.cardTitle }, t('系统提示词', 'System prompt')),
          h(
            'div',
            { style: styles.note },
            t(
              '保存会写入插件包的 cordis.patch.yml（自动备份一份），需要重启 DSH 才生效。改动只影响之后新建的闲聊会话，已经开着的会话仍用旧提示词。',
              'Saving writes the package cordis.patch.yml (with an automatic backup) and needs a DSH restart. It only affects chats created afterwards.',
            ),
          ),
          h('textarea', {
            value: text,
            onChange: (event) => setText(event.target.value),
            spellCheck: false,
            rows: 24,
            style: {
              width: '100%',
              boxSizing: 'border-box',
              marginTop: 10,
              padding: '12px 14px',
              borderRadius: 10,
              border: '1px solid var(--dsw-alias-border-l2)',
              background: 'var(--dsw-alias-surface-l1, transparent)',
              color: 'var(--dsw-alias-label-primary)',
              fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace',
              fontSize: 12.5,
              lineHeight: 1.7,
              resize: 'vertical',
            },
          }),
          h(
            'div',
            { style: Object.assign({}, styles.bar, { marginTop: 10 }) },
            h(
              'button',
              { type: 'button', style: styles.buttonPrimary, onClick: save, disabled: busy || !dirty },
              busy ? t('保存中…', 'Saving…') : t('保存', 'Save'),
            ),
            h(
              'button',
              { type: 'button', style: styles.buttonSmall, onClick: () => setText(saved), disabled: busy || !dirty },
              t('还原改动', 'Revert'),
            ),
            h(
              'button',
              { type: 'button', style: styles.buttonSmall, onClick: load, disabled: busy },
              t('重新载入', 'Reload'),
            ),
            h(
              'span',
              { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
              dirty ? t('有未保存改动', 'unsaved changes') : t('已同步', 'in sync'),
            ),
          ),
          filePath
            ? h(
                'div',
                { style: Object.assign({}, styles.mono, { color: 'var(--dsw-alias-label-tertiary)', marginTop: 8 }) },
                filePath,
              )
            : null,
          message
            ? h(
                'div',
                {
                  style: Object.assign({}, styles.mono, {
                    marginTop: 8,
                    whiteSpace: 'pre-wrap',
                    color: message.ok
                      ? 'var(--dsw-alias-state-success-primary, #2e7d32)'
                      : 'var(--dsw-alias-state-error-primary, #b3261e)',
                  }),
                },
                message.text,
              )
            : null,
        ),
        h(
          'div',
          { style: styles.card },
          h('div', { style: styles.cardTitle }, t('联网搜索', 'Web search')),
          h(
            'div',
            { style: styles.note },
            t(
              '这里是「全局挂载」：关闭后所有闲聊会话都不再加载联网工具（需重启 DSH）。日常想临时开关，请用输入框左侧的 🌐 按钮——那个即时生效，只影响当前会话。',
              'This is the global mount switch: turning it off unmounts web tools for every chat session (restart required). For a quick per-session toggle, use the 🌐 button left of the composer — it applies immediately.',
            ),
          ),
          h(
            'div',
            { style: Object.assign({}, styles.bar, { marginTop: 10 }) },
            h(
              'button',
              {
                type: 'button',
                style: webEnabled ? styles.buttonPrimary : styles.buttonSmall,
                onClick: () => toggleWeb(!webEnabled),
                disabled: webBusy || webEnabled === null,
              },
              webEnabled === null
                ? t('读取中…', 'Loading…')
                : webBusy
                  ? t('保存中…', 'Saving…')
                  : webEnabled
                    ? t('已开启 · 点击关闭', 'Enabled · click to disable')
                    : t('已关闭 · 点击开启', 'Disabled · click to enable'),
            ),
          ),
          webMessage
            ? h(
                'div',
                {
                  style: Object.assign({}, styles.mono, {
                    marginTop: 8,
                    whiteSpace: 'pre-wrap',
                    color: webMessage.ok
                      ? 'var(--dsw-alias-state-success-primary, #2e7d32)'
                      : 'var(--dsw-alias-state-error-primary, #b3261e)',
                  }),
                },
                webMessage.text,
              )
            : null,
        ),
      )
    }

    // ---------------------------------------------------------------------
    // 闲聊面板
    // ---------------------------------------------------------------------

    function ChatLitePage() {
      const [result, setResult] = useState(null)
      const [creating, setCreating] = useState(false)
      const [showDiag, setShowDiag] = useState(false)
      const [tab, setTab] = useState('sessions')
      const [b0, setB0] = useState(null)
      const [b0Busy, setB0Busy] = useState(false)
      const [history, setHistory] = useState(null)
      const [historyError, setHistoryError] = useState(null)
      const [historyBusy, setHistoryBusy] = useState(false)
      const [historyQuery, setHistoryQuery] = useState('')
      const [historyPage, setHistoryPage] = useState(0)
      const [deep, setDeep] = useState(null)
      const [deepBusy, setDeepBusy] = useState(false)
      const [deepProgress, setDeepProgress] = useState('')
      const [archiveInfo, setArchiveInfo] = useState(null)
      const [doc, setDoc] = useState(null)
      const [docBusy, setDocBusy] = useState(false)
      const [docError, setDocError] = useState(null)
      const [docSessionId, setDocSessionId] = useState(null)
      const [continueBusy, setContinueBusy] = useState(false)
      const [continueResult, setContinueResult] = useState(null)
      const [expandedThinking, setExpandedThinking] = useState({})
      const [forceDesktop, setForceDesktop] = useState(() => {
        try {
          return window.sessionStorage.getItem(FORCE_DESKTOP_KEY) === '1'
        } catch {
          return false
        }
      })

      const switchSession = useSwitchSession(setResult)
      const list = useStore(sessionListStore())
      const workspaces = useStore(workspacesStore())
      const currentBinding = useStore(SERVICES.uiSession && SERVICES.uiSession.current)

      const byId = (list && list.byId) || {}
      const ids = (list && list.ids) || []
      const cwd = chatCwd()
      const mine = chatSessions(byId, ids, cwd)
      const currentId =
        currentBinding && currentBinding.key !== undefined ? String(currentBinding.key) : undefined
      const currentRow = currentId ? byId[currentId] : undefined
      const inChat = currentRow && normalizePath(currentRow.cwd) === normalizePath(cwd)
      const chatWorkspace = findChatWorkspace(workspaces && workspaces.items, cwd)

      const create = useCallback(async () => {
        setCreating(true)
        setResult(null)
        try {
          const { id, switched, via } = await createChatSession()
          const suffix = via ? '  ·  ' + via : ''
          setResult(
            switched
              ? { ok: true, message: t('已新建并切到新会话', 'Created and switched'), detail: id + suffix }
              : {
                  ok: false,
                  message: t('已新建，但没能自动切过去', 'Created, but not switched'),
                  detail:
                    id +
                    '\n' +
                    t(
                      '点列表里那条「新对话」的「打开」即可；若每次都这样，说明 openSession 对刚建的会话无效，需要改用官方 startSession 路径。',
                      'Open it from the list; if this persists, openSession is not enough for fresh sessions.',
                    ),
                },
          )
        } catch (error) {
          const detail = String((error && error.message) || error)
          console.warn('[chat-lite] 新建闲聊会话失败', error)
          setResult({
            ok: false,
            message: t('新建失败：' + detail, 'Create failed: ' + detail),
            detail: t('目录不存在时请手动建好：', 'Ensure the directory exists: ') + cwd,
          })
        } finally {
          setCreating(false)
        }
      }, [cwd])

      // B2：读历史索引
      const loadHistory = useCallback(async () => {
        setHistoryBusy(true)
        setHistoryError(null)
        try {
          const sessionId = chatSessionIdForFiles(list, currentId)
          if (!sessionId) throw new Error(t('需要一个闲聊目录下的会话才能读文件', 'Needs a chat-dir session to read files'))
          // 先把闲聊工作区里的新会话归档进历史库，再读索引
          const archive = await requestArchive()
          setArchiveInfo(archive)
          const rows = await readHistoryIndex(sessionId)
          setHistory(rows)
          setHistoryPage(0)
        } catch (error) {
          setHistoryError(String((error && error.message) || error))
        } finally {
          setHistoryBusy(false)
        }
      }, [list, currentId])

      // 继续对话：新建会话 + 注入转录
      const continueChat = useCallback(async () => {
        if (!doc) return
        setContinueBusy(true)
        setContinueResult(null)
        try {
          const { sessionId, chars, trace } = await continueInNewSession(doc, CONTINUE_MESSAGE_LIMIT)
          setContinueResult({
            ok: true,
            message: t(
              '已在新会话继续（注入 ' + chars + ' 字符）',
              'Continued in a new session (' + chars + ' chars)',
            ),
            detail: sessionId + '\n' + (trace || []).join(' → '),
          })
        } catch (error) {
          setContinueResult({ ok: false, message: String((error && error.message) || error) })
        } finally {
          setContinueBusy(false)
        }
      }, [doc])

      // 全文搜索（顺序扫分块，带进度，可被新查询打断）
      const runDeepSearch = useCallback(async () => {
        const query = historyQuery.trim()
        if (!query) return
        const sessionId = chatSessionIdForFiles(list, currentId)
        if (!sessionId) {
          setDeepProgress(t('需要一个闲聊目录下的会话才能读文件', 'Needs a chat-dir session'))
          return
        }
        setDeepBusy(true)
        setDeep(null)
        setDeepProgress(t('扫描中…', 'Scanning…'))
        try {
          const result = await searchFullText(sessionId, query, {
            maxMatches: 60,
            onProgress: (scanned, total, hits) =>
              setDeepProgress(
                t(
                  '已扫描 ' + scanned + '/' + total + ' 段，命中 ' + hits,
                  'Scanned ' + scanned + '/' + total + ', ' + hits + ' hits',
                ),
              ),
          })
          setDeep({ ids: new Set(result.matches), snippets: result.snippets || new Map() })
          setHistoryPage(0)
          setDeepProgress(
            (result.cancelled
              ? t('已取消', 'Cancelled')
              : t(
                  '完成：扫描 ' + result.scanned + '/' + result.total + ' 段，命中 ' + result.matches.length,
                  'Done: ' + result.scanned + '/' + result.total + ', ' + result.matches.length + ' hits',
                )) + (result.readError ? '  ·  ' + result.readError : ''),
          )
        } catch (error) {
          setDeepProgress('✗ ' + String((error && error.message) || error))
        } finally {
          setDeepBusy(false)
        }
      }, [historyQuery, list, currentId])

      // B3：打开单条历史正文
      const openHistory = useCallback(
        async (row) => {
          setDocBusy(true)
          setDocError(null)
          setDoc(null)
          setExpandedThinking({})
          try {
            const sessionId = chatSessionIdForFiles(list, currentId)
            if (!sessionId) throw new Error(t('需要一个闲聊目录下的会话才能读文件', 'Needs a chat-dir session'))
            setDocSessionId(sessionId)
            setDoc(await readHistoryDoc(sessionId, row.id))
          } catch (error) {
            setDocError(String((error && error.message) || error))
          } finally {
            setDocBusy(false)
          }
        },
        [list, currentId],
      )

      // B0：验证客户端能否读取工作区文件（B 路线的数据通道）
      const runB0 = useCallback(async () => {
        setB0Busy(true)
        setB0(null)
        try {
          const api = SERVICES.workspaceFiles
          if (!api || typeof api.read !== 'function') {
            setB0('✗ remote.workspaceFiles.read 不可用（api=' + typeof api + '）')
            return
          }
          const id = currentSessionId()
          if (!id) {
            setB0('✗ 没有当前会话 id')
            return
          }
          const result = await api.read(id, 'probe/b0-probe.json', {})
          const text =
            typeof result === 'string'
              ? result
              : result && typeof result.text === 'string'
                ? result.text
                : JSON.stringify(result)
          setB0('✓ 读到 ' + text.length + ' 字符\n' + text.slice(0, 320))
        } catch (error) {
          setB0('✗ ' + String((error && error.message) || error))
        } finally {
          setB0Busy(false)
        }
      }, [])

      const toggleLayout = useCallback(() => {
        try {
          if (forceDesktop) window.sessionStorage.removeItem(FORCE_DESKTOP_KEY)
          else window.sessionStorage.setItem(FORCE_DESKTOP_KEY, '1')
        } catch {
          // 隐私模式下不可写，忽略
        }
        window.location.reload()
      }, [forceDesktop])

      // 历史列表的过滤与分页（派生值，不需要 state）
      const historyQueryText = historyQuery.trim().toLowerCase()
      const historyFilteredAll = (history || []).filter((row) => {
        if (!historyQueryText) return true
        return (
          String(row.title || '').toLowerCase().includes(historyQueryText) ||
          String(row.first || '').toLowerCase().includes(historyQueryText)
        )
      })
      // 全文搜索有结果时，**忽略**标题/首句过滤，直接按命中集合显示
      const historyFiltered =
        deep && deep.ids ? (history || []).filter((row) => deep.ids.has(row.id)) : historyFilteredAll
      const historyPages = Math.max(1, Math.ceil(historyFiltered.length / HISTORY_PAGE))
      const historyPageSafe = Math.min(historyPage, historyPages - 1)
      const historySlice = historyFiltered.slice(
        historyPageSafe * HISTORY_PAGE,
        (historyPageSafe + 1) * HISTORY_PAGE,
      )
      const historyGroups = groupByMonth(historySlice)

      // 来源判断：优先用 index 里的 source；老数据没有该字段时，
      // 用「是否属于当前闲聊工作区的会话」兜底。
      const chatIdSet = new Set((mine || []).map((row) => row.id))
      const isLocalRow = (row) =>
        row.source === 'local' ||
        (row.source === undefined && (chatIdSet.has(row.id) || isLocalSessionId(row.id)))

      const docChars = doc
        ? doc.messages.reduce((sum, message) => sum + String(message.text || '').length, 0)
        : 0

      return h(
        'div',
        { style: styles.page },
        h(
          'div',
          { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 } },
          h('div', { style: Object.assign({}, styles.h1, { margin: 0, flex: 1 }) }, t('闲聊', 'Chat Lite')),
          h(
            'button',
            { type: 'button', onClick: create, disabled: creating, style: styles.buttonPrimary },
            creating ? t('创建中…', 'Creating…') : t('＋ 新建', '＋ New'),
          ),
        ),

        // 标签页：会话 / 历史
        h(
          'div',
          { style: { display: 'flex', gap: 6, marginBottom: 12 } },
          ...['sessions', 'history'].map((key) =>
            h(
              'button',
              {
                key,
                type: 'button',
                onClick: () => setTab(key),
                style: Object.assign({}, styles.buttonSmall, {
                  padding: '6px 16px',
                  fontSize: 13,
                  borderRadius: 8,
                  border:
                    '1px solid ' +
                    (tab === key ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-border-l2)'),
                  background: tab === key ? 'var(--dsw-alias-brand-primary)' : 'transparent',
                  color: tab === key ? '#fff' : 'var(--dsw-alias-label-primary)',
                }),
              },
              key === 'sessions' ? t('会话', 'Chats') : t('历史', 'History'),
            ),
          ),
        ),

        // 新建 + 闲聊会话列表
        tab !== 'sessions'
          ? null
          : h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: { marginBottom: 10 } },
            h('div', { style: Object.assign({}, styles.cardTitle, { margin: 0 }) },
              t('闲聊会话', 'Chats')),
          ),
          h(
            'div',
            { style: Object.assign({}, styles.mono, { color: 'var(--dsw-alias-label-tertiary)', marginBottom: 6 }) },
            cwd,
          ),
          mine.length === 0
            ? h(
                'div',
                { style: styles.note },
                list && list.phase === 'pending'
                  ? t('会话列表正在加载…', 'Loading sessions…')
                  : t('还没有闲聊会话，点右上角新建。', 'No chat sessions yet — press New chat.'),
              )
            : mine.slice(0, 80).map((item, index) =>
                h(
                  'div',
                  {
                    key: item.id,
                    style: index === 0 ? Object.assign({}, styles.row, styles.rowFirst) : styles.row,
                  },
                  h(
                    'div',
                    { style: { flex: 1, minWidth: 0 } },
                    h(
                      'div',
                      { style: { fontSize: 13, wordBreak: 'break-all' } },
                      // 空会话的 displayTitle 是 cwd 的目录名（都是 "chat"），显示成「新对话」更易读
                      item.blank ? t('新对话', 'New chat') : item.displayTitle || item.id,
                    ),
                    h(
                      'div',
                      { style: Object.assign({}, styles.mono, { color: 'var(--dsw-alias-label-tertiary)' }) },
                      relativeTime(item.updatedAt) +
                        (item.running ? '  · ' + t('生成中', 'running') : '') +
                        (item.blank ? '  · ' + t('空会话', 'blank') : ''),
                    ),
                  ),
                  hasVersionSiblings(byId, item.id)
                    ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
                        t('有版本', 'versions'))
                    : null,
                  item.id === currentId
                    ? h('span', { style: { fontSize: 12, color: 'var(--dsw-alias-brand-primary)' } },
                        t('当前', 'current'))
                    : h(
                        'button',
                        { type: 'button', style: styles.buttonSmall, onClick: () => switchSession(item.id) },
                        t('打开', 'Open'),
                      ),
                ),
              ),
        ),

        result
          ? h(
              'div',
              {
                style: Object.assign({}, styles.mono, {
                  marginBottom: 14,
                  color: result.ok
                    ? 'var(--dsw-alias-state-success-primary, #2e7d32)'
                    : 'var(--dsw-alias-state-error-primary, #b3261e)',
                }),
              },
              (result.ok ? '✓ ' : '✗ ') + result.message + (result.detail ? '\n' + result.detail : ''),
            )
          : null,

        // 当前会话 + 版本切换
        tab !== 'sessions'
          ? null
          : h(
          'div',
          { style: styles.card },
          h('div', { style: styles.cardTitle }, t('当前会话', 'Current session')),
          currentRow
            ? h(
                'div',
                { style: { display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' } },
                h(
                  'div',
                  { style: { flex: 1, minWidth: 200 } },
                  h('div', { style: { fontSize: 13, wordBreak: 'break-all' } },
                    currentRow.displayTitle || currentRow.id),
                  h(
                    'div',
                    { style: Object.assign({}, styles.mono, { color: 'var(--dsw-alias-label-tertiary)', marginTop: 4 }) },
                    currentRow.id +
                      (currentRow.parentId ? '  ←  fork 自 ' + currentRow.parentId : '  （顶层会话）') +
                      (inChat ? '' : t('\n⚠ 不属于闲聊目录（属于工作区会话）', '\n⚠ not in the chat directory')),
                  ),
                ),
                h(VersionSwitcher, { byId, currentId, onSwitch: switchSession }),
              )
            : h('div', { style: styles.note }, t('当前没有打开任何会话。', 'No session is open.')),
        ),

        // B3：历史正文
        tab !== 'history' || !(doc || docError || docBusy)
          ? null
          : h(
              'div',
              { style: styles.card },
              h(
                'div',
                { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' } },
                h(
                  'button',
                  {
                    type: 'button',
                    style: styles.buttonSmall,
                    onClick: () => {
                      setDoc(null)
                      setDocError(null)
                    },
                  },
                  t('← 返回列表', '← Back'),
                ),
                h(
                  'div',
                  { style: Object.assign({}, styles.cardTitle, { margin: 0, flex: 1 }) },
                  doc && doc.meta && isLocalSessionId(doc.meta.id)
                    ? h(
                        'span',
                        {
                          style: {
                            fontSize: 10.5,
                            lineHeight: '16px',
                            padding: '0 6px',
                            marginRight: 6,
                            borderRadius: 4,
                            background: 'rgba(64,120,255,0.16)',
                            color: 'var(--dsw-alias-brand-primary)',
                            fontWeight: 600,
                            verticalAlign: 'middle',
                          },
                        },
                        t('本机', 'local'),
                      )
                    : null,
                  doc && doc.meta ? doc.meta.title || t('（无标题）', '(untitled)') : t('历史会话', 'History session'),
                ),
                doc && doc.meta
                  ? h(
                      'span',
                      { style: Object.assign({}, styles.mono, { color: 'var(--dsw-alias-label-tertiary)' }) },
                      String(doc.meta.updated || '').slice(0, 16).replace('T', ' '),
                    )
                  : null,
                doc
                  ? h(
                      'button',
                      {
                        type: 'button',
                        style: styles.buttonPrimary,
                        onClick: continueChat,
                        disabled: continueBusy,
                      },
                      continueBusy
                        ? t('正在新建会话…', 'Starting…')
                        : t(
                            '继续这条对话（' + docChars.toLocaleString() + ' 字符）',
                            'Continue this chat (' + docChars.toLocaleString() + ' chars)',
                          ),
                    )
                  : null,
              ),
              continueResult
                ? h(
                    'div',
                    {
                      style: Object.assign({}, styles.mono, {
                        marginBottom: 10,
                        color: continueResult.ok
                          ? 'var(--dsw-alias-state-success-primary, #2e7d32)'
                          : 'var(--dsw-alias-state-error-primary, #b3261e)',
                      }),
                    },
                    (continueResult.ok ? '✓ ' : '✗ ') +
                      continueResult.message +
                      (continueResult.detail ? '\n' + continueResult.detail : ''),
                  )
                : null,
              docBusy
                ? h('div', { style: styles.note }, t('读取中…', 'Loading…'))
                : null,
              docError
                ? h(
                    'div',
                    { style: Object.assign({}, styles.mono, { color: 'var(--dsw-alias-state-error-primary, #b3261e)' }) },
                    docError,
                  )
                : null,
              doc
                ? doc.messages.map((message, index) => {
                    const key = 'm' + index
                    if (message.role === 'user') {
                      return h(
                        'div',
                        { key, style: { display: 'flex', justifyContent: 'flex-end', margin: '12px 0' } },
                        h(
                          'div',
                          {
                            style: {
                              maxWidth: '86%',
                              padding: '9px 13px',
                              borderRadius: 12,
                              background: 'rgba(64,120,255,0.16)',
                              fontSize: 13.5,
                              lineHeight: 1.72,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                            },
                          },
                          h(HistoryFiles, {
                            sessionId: docSessionId,
                            historyId: doc.meta ? doc.meta.id : null,
                            files: message.files,
                            alignEnd: true,
                          }),
                          message.text,
                        ),
                      )
                    }
                    const expanded = expandedThinking[index] === true
                    return h(
                      'div',
                      { key, style: { margin: '12px 0' } },
                      message.thinking
                        ? h(
                            'div',
                            { style: { marginBottom: 6 } },
                            h(
                              'button',
                              {
                                type: 'button',
                                style: styles.buttonSmall,
                                onClick: () =>
                                  setExpandedThinking(Object.assign({}, expandedThinking, { [index]: !expanded })),
                              },
                              (expanded ? '▾ ' : '▸ ') + t('思考', 'Thinking'),
                            ),
                            expanded
                              ? h(
                                  'div',
                                  {
                                    style: {
                                      margin: '6px 0 0',
                                      padding: '8px 12px',
                                      borderLeft: '2px solid var(--dsw-alias-border-l2)',
                                      color: 'var(--dsw-alias-label-secondary)',
                                      fontSize: 12.5,
                                      lineHeight: 1.68,
                                      whiteSpace: 'pre-wrap',
                                      wordBreak: 'break-word',
                                    },
                                  },
                                  message.thinking,
                                )
                              : null,
                          )
                        : null,
                      h('div', { style: { fontSize: 13.5 } },
                        h(HistoryFiles, {
                          sessionId: docSessionId,
                          historyId: doc.meta ? doc.meta.id : null,
                          files: message.files,
                        }),
                        renderMarkdown(message.text, key + '-')),
                    )
                  })
                : null,
            ),

        // B2：历史（来自 .chat-lite 历史库，只读）
        tab !== 'history'
          ? null
          : h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10, flexWrap: 'wrap' } },
            h(
              'div',
              { style: Object.assign({}, styles.cardTitle, { margin: 0, flex: 1 }) },
              history
                ? t('历史（' + history.length + ' 条）', 'History (' + history.length + ')')
                : t('历史', 'History'),
            ),
            h(
              'button',
              { type: 'button', onClick: loadHistory, disabled: historyBusy, style: styles.button },
              historyBusy
                ? t('读取中…', 'Loading…')
                : history
                  ? t('刷新', 'Reload')
                  : t('加载历史', 'Load history'),
            ),
          ),
          historyError
            ? h(
                'div',
                { style: Object.assign({}, styles.mono, { color: 'var(--dsw-alias-state-error-primary, #b3261e)' }) },
                historyError,
              )
            : null,
          !history
            ? h(
                'div',
                { style: styles.note },
                t(
                  '历史库在 .chat-lite/ 下（3126 条会话离线索引），点「加载历史」读取。',
                  'History lives in .chat-lite/; press Load history.',
                ),
              )
            : h(
                'div',
                null,
                h('input', {
                  type: 'text',
                  value: historyQuery,
                  placeholder: t('搜索标题或第一句提问', 'Search title or first question'),
                  onChange: (event) => {
                    setHistoryQuery(event.target.value)
                    setHistoryPage(0)
                    setDeep(null)
                    setDeepProgress('')
                    deepSearchToken++
                  },
                  style: Object.assign({}, styles.input, { marginBottom: 8 }),
                }),
                h(
                  'div',
                  { style: Object.assign({}, styles.bar, { marginTop: 0, marginBottom: 6 }) },
                  h(
                    'button',
                    { type: 'button', style: styles.buttonSmall, onClick: runDeepSearch, disabled: deepBusy || !historyQuery.trim() },
                    deepBusy ? t('全文搜索中…', 'Searching…') : t('全文搜索', 'Full-text search'),
                  ),
                  deep && deep.ids
                    ? h(
                        'span',
                        { style: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } },
                        t('仅在全文命中结果中显示', 'showing full-text hits'),
                      )
                    : null,
                  deep ? h(
                    'button',
                    {
                      type: 'button',
                      style: styles.buttonSmall,
                      onClick: () => {
                        deepSearchToken++
                        setDeep(null)
                        setDeepProgress('')
                      },
                    },
                    t('清除', 'Clear'),
                  ) : null,
                ),
                deepProgress
                  ? h(
                      'div',
                      { style: Object.assign({}, styles.mono, { color: 'var(--dsw-alias-label-tertiary)', marginBottom: 6 }) },
                      deepProgress,
                    )
                  : null,
                h(
                  'div',
                  { style: Object.assign({}, styles.mono, { color: 'var(--dsw-alias-label-tertiary)', marginBottom: 4 }) },
                  t(
                    '匹配 ' + historyFiltered.length + ' / ' + history.length + ' 条 · 第 ' + (historyPageSafe + 1) + '/' + historyPages + ' 页',
                    historyFiltered.length + ' / ' + history.length + ' · page ' + (historyPageSafe + 1) + '/' + historyPages,
                  ),
                ),
                // 归档状态：不再静默失败——宿主没起来或路由缺失时直接说明
                archiveInfo === null
                  ? h(
                      'div',
                      {
                        style: Object.assign({}, styles.mono, {
                          color: 'var(--dsw-alias-state-error-primary, #b3261e)',
                          marginBottom: 6,
                        }),
                      },
                      t(
                        '⚠ 自动归档未生效：宿主 /archive 路由无响应（插件宿主半边改过，需要重启 DSH）',
                        '⚠ Auto-archive unavailable: the host /archive route did not respond (restart DSH)',
                      ),
                    )
                  : archiveInfo.archived > 0
                    ? h(
                        'div',
                        {
                          style: Object.assign({}, styles.mono, {
                            color: 'var(--dsw-alias-state-success-primary, #2e7d32)',
                            marginBottom: 6,
                          }),
                        },
                        t(
                          '已归档 ' + archiveInfo.archived + ' 条新会话（共扫描 ' + archiveInfo.total + ' 条）',
                          'Archived ' + archiveInfo.archived + ' session(s) of ' + archiveInfo.total,
                        ),
                      )
                    : null,
                historyGroups.map((group) =>
                  h(
                    'div',
                    { key: group.key },
                    h(
                      'div',
                      {
                        style: {
                          fontSize: 11,
                          fontWeight: 600,
                          letterSpacing: '0.04em',
                          color: 'var(--dsw-alias-label-tertiary)',
                          padding: '10px 0 4px',
                        },
                      },
                      group.key,
                    ),
                    group.rows.map((row, index) =>
                      h(
                        'div',
                        {
                          key: row.id,
                          style: index === 0 ? Object.assign({}, styles.row, styles.rowFirst) : styles.row,
                        },
                        h(
                          'div',
                          { style: { flex: 1, minWidth: 0 } },
                          h(
                            'div',
                            {
                              style: {
                                fontSize: 13,
                                wordBreak: 'break-all',
                                display: 'flex',
                                alignItems: 'center',
                                gap: 6,
                                flexWrap: 'wrap',
                              },
                            },
                            isLocalRow(row)
                              ? h(
                                  'span',
                                  {
                                    style: {
                                      flex: 'none',
                                      fontSize: 10.5,
                                      lineHeight: '16px',
                                      padding: '0 6px',
                                      borderRadius: 4,
                                      background: 'rgba(64,120,255,0.16)',
                                      color: 'var(--dsw-alias-brand-primary)',
                                      fontWeight: 600,
                                    },
                                  },
                                  t('本机', 'local'),
                                )
                              : h(
                                  'span',
                                  {
                                    style: {
                                      flex: 'none',
                                      fontSize: 10.5,
                                      lineHeight: '16px',
                                      padding: '0 6px',
                                      borderRadius: 4,
                                      background: 'rgba(127,127,127,0.16)',
                                      color: 'var(--dsw-alias-label-tertiary)',
                                    },
                                  },
                                  t('导入', 'import'),
                                ),
                            h(
                              'span',
                              { style: { minWidth: 0 } },
                              highlight(row.title || t('（无标题）', '(untitled)'), historyQueryText),
                            ),
                          ),
                          // 说明「为什么命中」：优先显示全文搜索抓到的上下文片段
                          (() => {
                            const snippet = deep && deep.snippets ? deep.snippets.get(row.id) : null
                            const snippetStyle = {
                              fontSize: 12,
                              color: 'var(--dsw-alias-label-secondary)',
                              marginTop: 2,
                              wordBreak: 'break-all',
                              lineHeight: 1.6,
                            }
                            if (snippet) {
                              return h(
                                'div',
                                { style: snippetStyle },
                                t('命中：', 'match: '),
                                highlight(snippet, historyQueryText),
                              )
                            }
                            if (
                              historyQueryText &&
                              !String(row.title || '').toLowerCase().includes(historyQueryText) &&
                              String(row.first || '').toLowerCase().includes(historyQueryText)
                            ) {
                              return h(
                                'div',
                                { style: snippetStyle },
                                t('首句命中：', 'first message: '),
                                highlight(String(row.first || '').slice(0, 80), historyQueryText),
                              )
                            }
                            return null
                          })(),
                          h(
                            'div',
                            { style: Object.assign({}, styles.mono, { color: 'var(--dsw-alias-label-tertiary)' }) },
                            String(row.updated || '').slice(0, 10) +
                              '  ·  ' + row.turns + t(' 轮', ' turns') +
                              (row.thinking ? '  ·  ' + t('含思考', 'thinking') : '') +
                              (row.files ? '  ·  ' + row.files + t(' 附件', ' files') : ''),
                          ),
                        ),
                        h(
                          'button',
                          {
                            type: 'button',
                            style: styles.buttonSmall,
                            onClick: () => openHistory(row),
                          },
                          t('打开', 'Open'),
                        ),
                      ),
                    ),
                  ),
                ),
                historyPages > 1
                  ? h(
                      'div',
                      { style: styles.bar },
                      h(
                        'button',
                        {
                          type: 'button',
                          style: styles.buttonSmall,
                          disabled: historyPageSafe <= 0,
                          onClick: () => setHistoryPage(Math.max(0, historyPageSafe - 1)),
                        },
                        t('上一页', 'Prev'),
                      ),
                      h(
                        'button',
                        {
                          type: 'button',
                          style: styles.buttonSmall,
                          disabled: historyPageSafe >= historyPages - 1,
                          onClick: () => setHistoryPage(Math.min(historyPages - 1, historyPageSafe + 1)),
                        },
                        t('下一页', 'Next'),
                      ),
                    )
                  : null,
              ),
        ),

        // 诊断（骨架期用来核对，稳定后可删）
        h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: { display: 'flex', alignItems: 'center', gap: 10 } },
            h('div', { style: Object.assign({}, styles.cardTitle, { margin: 0, flex: 1 }) },
              t('诊断', 'Diagnostics')),
            h(
              'button',
              { type: 'button', style: styles.buttonSmall, onClick: () => setShowDiag(!showDiag) },
              showDiag ? t('收起', 'Hide') : t('展开', 'Show'),
            ),
          ),
          showDiag
            ? h(
                'div',
                { style: { marginTop: 10 } },
                h(Row, { label: 'cwd', value: cwd, first: true }),
                h(Row, { label: 'session list', value: (list ? list.phase : 'n/a') + ' · ids=' + ids.length + ' · byId=' + Object.keys(byId).length }),
                h(Row, { label: '闲聊会话', value: String(mine.length) }),
                h(Row, { label: '工作区', value: chatWorkspace ? chatWorkspace.workspaceId : '（尚未创建）' }),
                h(Row, { label: '当前会话', value: currentId || '-' }),
                h(Row, { label: 'sessions.create', value: readService('sessions', 'create') }),
                h(Row, { label: 'workspaces.create', value: readService('workspaces', 'create') }),
                h(Row, { label: 'uiWorkspace.openSession', value: readService('uiWorkspace', 'openSession') }),
                h(
                  'div',
                  { style: styles.bar },
                  h(
                    'button',
                    { type: 'button', style: styles.button, onClick: toggleLayout },
                    forceDesktop ? t('切回手机适配', 'Phone layout') : t('切到桌面布局', 'Desktop layout'),
                  ),
                  h(
                    'button',
                    { type: 'button', style: styles.button, onClick: runB0, disabled: b0Busy },
                    b0Busy ? t('读取中…', 'Reading…') : t('B0 测试：读工作区文件', 'B0: read a workspace file'),
                  ),
                ),
                b0
                  ? h(
                      'div',
                      { style: Object.assign({}, styles.mono, { marginTop: 8, color: 'var(--dsw-alias-label-secondary)' }) },
                      b0,
                    )
                  : null,
                h(
                  'div',
                  { style: Object.assign({}, styles.note, { marginTop: 10 }) },
                  t(
                    '注意：隔离只作用于本面板。官方侧栏仍会列出全部会话，这是已知限制。',
                    'Isolation applies to this panel only; the official sidebar still lists every session.',
                  ),
                ),
              )
            : null,
        ),
      )
    }

    function ChatLiteIcon() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': 'true' },
        h('path', {
          d: 'M2.5 3.75A1.25 1.25 0 0 1 3.75 2.5h8.5a1.25 1.25 0 0 1 1.25 1.25v6.5a1.25 1.25 0 0 1-1.25 1.25H6.5L3.5 14v-2.5h-.75A1.25 1.25 0 0 1 2.5 10.25v-6.5Z',
          stroke: 'currentColor',
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }),
      )
    }

    return {
      // 服务名取自官方插件的 inject 声明；cordis 只允许访问声明过的服务。
      // remote + remote.workspaceFiles：用于读取工作区文件（B 路线的数据通道）
      inject: ['slots', 'sessions', 'workspaces', 'uiWorkspace', 'uiSession', 'uiConversation', 'remote', 'remote.workspaceFiles'],
      apply(ctx) {
        const slots = ctx.slots

        try {
          SERVICES.sessions = ctx.sessions
          SERVICES.workspaces = ctx.workspaces
          SERVICES.uiWorkspace = ctx.uiWorkspace
          SERVICES.uiSession = ctx.uiSession
          SERVICES.uiConversation = ctx.uiConversation
          SERVICES.workspaceFiles = ctx.remote && ctx.remote.workspaceFiles ? ctx.remote.workspaceFiles : null
        } catch (error) {
          console.warn('[chat-lite] 服务注入失败', error)
        }

        // 手机端可读性回退：窄屏下给侧栏/右栏补实心底色并允许滚动。
        // 依据：sidebarCol 官方样式是 overflow:hidden，高度不足会裁掉内容且无法滚动。
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {}
          const STYLE_ID = 'chat-lite-mobile-legibility'
          if (document.getElementById(STYLE_ID)) return () => {}
          const style = document.createElement('style')
          style.id = STYLE_ID
          style.textContent = [
            '@media (max-width: 900px), (pointer: coarse) {',
            '  [class*="_sidebarCol"], [class*="_rightbarCol"] {',
            `    background: ${SOLID_BG} !important;`,
            '    -webkit-backdrop-filter: none !important;',
            '    backdrop-filter: none !important;',
            '  }',
            '  [class*="_sidebarCol"] > * { flex-shrink: 0 !important; }',
            '  [class*="_sidebarCol"] { overflow-y: auto !important; overflow-x: hidden !important; }',
            '  [class*="_sidebarCol"] [class*="_scroll"], [class*="_sidebarCol"] [class*="_list"] { min-height: 120px !important; }',
            '  [class*="_sidebarCol"] *, [class*="_rightbarCol"] * { text-shadow: none !important; }',
            '}',
          ].join('\n')
          document.head.appendChild(style)
          return () => {
            style.remove()
          }
        }, 'chat-lite: mobile legibility fallback')

        ctx.effect(
          () =>
            slots.inject('sidebar.panellist', () =>
              slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: 42,
                  label: () => t('闲聊', 'Chat Lite'),
                },
                ChatLiteIcon,
              ),
            ),
          'chat-lite: sidebar entry',
        )

        ctx.effect(
          () =>
            slots.inject('settings.section', () =>
              slots.register(
                {
                  name: 'settings.section',
                  id: 'chat-lite-settings',
                  order: 70,
                  label: () => t('闲聊区', 'Chat Lite'),
                },
                ChatLiteSettings,
              ),
            ),
          'chat-lite: settings section',
        )

        // 输入框左侧的联网开关（会话级，点一下即时生效）
        ctx.effect(() => {
          try {
            return slots.inject('conversation.input.left', () =>
              slots.register(
                {
                  name: 'conversation.input.left',
                  id: 'chat-lite-web-toggle',
                  order: 31,
                },
                ComposerWebToggle,
              ),
            )
          } catch (error) {
            console.warn('[chat-lite] 联网开关注册失败', error)
            return () => {}
          }
        }, 'chat-lite: composer web toggle')

        ctx.effect(
          () =>
            slots.inject('main', () =>
              slots.register(
                {
                  name: 'main',
                  key: PANEL_ID,
                },
                ChatLitePage,
              ),
            ),
          'chat-lite: main page',
        )

        // 成品控件：输入框右侧的 `‹ n/m ›` 版本条（每会话一个实例）。
        // 官方声明为 { kind: 'list', scope: 'session' }，宿主没声明时 inject 静默缺席，不会影响启动。
        ctx.effect(() => {
          try {
            return slots.inject('conversation.input.right', () =>
              slots.register(
                {
                  name: 'conversation.input.right',
                  id: 'chat-lite-versions',
                  order: 30,
                },
                SessionVersionBar,
              ),
            )
          } catch (error) {
            console.warn('[chat-lite] 输入框版本条注册失败', error)
            return () => {}
          }
        }, 'chat-lite: composer version bar')
      },
    }
  },
})
