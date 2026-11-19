// dsh-chat-lite 移动端前端（无框架）
'use strict'

const BUILD = '2025-11-19.13'
// 运行期错误：底部小条，可关闭，绝不遮挡界面
function showErrorBar(text) {
  let bar = document.getElementById('error-bar')
  if (!bar) {
    bar = document.createElement('div')
    bar.id = 'error-bar'
    bar.style.cssText =
      'position:fixed;left:8px;right:8px;bottom:8px;z-index:999;padding:8px 34px 8px 10px;' +
      'background:rgba(160,20,20,.94);color:#fff;font:12px/1.5 monospace;border-radius:10px;' +
      'max-height:32vh;overflow:auto;white-space:pre-wrap'
    const close = document.createElement('button')
    close.textContent = '×'
    close.style.cssText =
      'position:absolute;right:6px;top:4px;width:24px;height:24px;border:0;border-radius:50%;' +
      'background:rgba(255,255,255,.2);color:#fff;font-size:14px;line-height:1'
    close.addEventListener('click', () => bar.remove())
    bar.appendChild(close)
    const body = document.createElement('span')
    body.id = 'error-bar-text'
    bar.appendChild(body)
    document.body.appendChild(bar)
  }
  const body = bar.querySelector('#error-bar-text')
  if (body) body.textContent = String(text || '').slice(0, 600)
}

window.addEventListener('error', (event) => {
  showErrorBar('[error] ' + (event.message || '') + ' @ ' + (event.lineno || ''))
})
window.addEventListener('unhandledrejection', (event) => {
  showErrorBar('[rejection] ' + String((event.reason && event.reason.message) || event.reason))
})

const $ = (id) => document.getElementById(id)
const el = {
  drawer: $('drawer'),
  scrim: $('drawer-scrim'),
  list: $('list'),
  search: $('search'),
  searchTabs: $('search-tabs'),
  title: $('title'),
  messages: $('messages'),
  empty: $('empty'),
  input: $('input'),
  send: $('send'),
  conn: $('conn'),
  effortChip: $('effort-chip'),
  webChip: $('web-chip'),
  effortPop: $('effort-pop'),
  attach: $('attach'),
  attachSheet: $('attach-sheet'),
  toast: $('toast'),
  pending: $('pending'),
  fileCamera: $('file-camera'),
  fileAlbum: $('file-album'),
  fileDoc: $('file-doc'),
  offlineBanner: $('offline-banner'),
  pairing: $('pairing'),
  pairingInput: $('pairing-input'),
  pairingSubmit: $('pairing-submit'),
  pairingMsg: $('pairing-msg'),
  dialog: $('dialog'),
  dialogTitle: $('dialog-title'),
  dialogInput: $('dialog-input'),
  dialogText: $('dialog-text'),
  dialogOk: $('dialog-ok'),
  dialogCancel: $('dialog-cancel'),
}

/** 启动自检：缺元素时直接在页面上报出来，避免再次出现"白屏无线索"。 */
function checkElements() {
  const missing = Object.keys(el).filter((key) => !el[key])
  if (missing.length === 0) return true
  const box = document.createElement('pre')
  box.style.cssText =
    'position:fixed;left:0;right:0;top:0;z-index:999;margin:0;padding:8px;background:#fee;color:#900;font:12px/1.5 monospace;white-space:pre-wrap'
  box.textContent = '[元素缺失] ' + missing.join(', ')
  document.body.appendChild(box)
  return false
}

const state = {
  sessions: [],
  current: null,
  records: [],
  messages: [],
  running: false,
  effort: localStorage.getItem('chat-lite:effort') || 'high',
  web: localStorage.getItem('chat-lite:web') !== '0',
  source: null,
  live: null,
  static: false,
  editing: null,   // { atSeq, text } 修改用户消息时使用
  liveText: '',
  liveThinking: '',
  hasMore: false,
  readOnly: false,        // 历史记录只读
  scope: 'title',         // 搜索范围：title | full
  searching: false,
  historyCursor: 0,
  historyHasMore: false,
  earliestSeq: 0,
  pendingImages: [],
  pendingFiles: [],   // [{ attachment, dataUrl }]
  pinned: new Set(JSON.parse(localStorage.getItem('chat-lite:pinned') || '[]')),
  hidden: new Set(JSON.parse(localStorage.getItem('chat-lite:hidden') || '[]')),
}

const EFFORT_LABEL = { max: '极', high: '高', low: '低', off: '关' }

// ── 工具函数 ───────────────────────────────────────────────
function toast(text, ms = 1600) {
  el.toast.textContent = text
  el.toast.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => { el.toast.hidden = true }, ms)
}

async function api(path, options = {}) {
  const response = await fetch('api/' + path, {
    method: options.method || 'GET',
    credentials: 'same-origin',
    headers: Object.assign({ 'x-chat-lite': '1' }, options.body ? { 'content-type': 'application/json' } : {}),
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const json = await response.json().catch(() => ({ ok: false, error: 'HTTP ' + response.status }))
  if (!json.ok) {
    const message = String(json.error || 'HTTP ' + response.status)
    // 宿主还是旧版本时会返回 unknown action：直接告诉用户原因
    if (message.startsWith('unknown action')) {
      throw new Error('宿主尚未加载该功能，请重启 DSH 后重试')
    }
    const error = new Error(message)
    error.needPair = Boolean(json.needPair)
    throw error
  }
  return json
}

/** 复制文本：https 用 Clipboard API，http（局域网）退回 execCommand。 */
async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 继续走兜底
  }
  try {
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.cssText = 'position:fixed;top:0;left:0;opacity:0'
    document.body.appendChild(area)
    area.select()
    area.setSelectionRange(0, text.length)
    const ok = document.execCommand('copy')
    document.body.removeChild(area)
    return ok
  } catch {
    return false
  }
}

const escapeHtml = (value) =>
  String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** 极简 markdown：标题、粗体、行内代码、代码块、段落 */
function renderMarkdown(text) {
  const blocks = String(text || '').split(/```/)
  let html = ''
  blocks.forEach((chunk, index) => {
    if (index % 2 === 1) {
      html += '<pre><code>' + escapeHtml(chunk.replace(/^\w*\n/, '')) + '</code></pre>'
      return
    }
    for (const raw of chunk.split(/\n{2,}/)) {
      const line = raw.trim()
      if (!line) continue
      const heading = line.match(/^(#{1,4})\s+(.*)$/)
      if (heading) {
        const level = Math.min(3, heading[1].length)
        html += '<h' + level + '>' + inline(heading[2]) + '</h' + level + '>'
        continue
      }
      html += '<p>' + inline(line).replace(/\n/g, '<br/>') + '</p>'
    }
  })
  return html
}

function inline(text) {
  return escapeHtml(text)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
}

// ── 列表 ───────────────────────────────────────────────────
const GROUPS = [
  { key: 'today', label: '今天' },
  { key: 'yesterday', label: '昨天' },
  { key: 'week', label: '7 天内' },
  { key: 'month', label: '30 天内' },
  { key: 'older', label: '更早' },
]

function groupOf(ts) {
  const now = new Date()
  const date = new Date(ts)
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const day = 86400000
  if (ts >= startOfToday) return 'today'
  if (ts >= startOfToday - day) return 'yesterday'
  if (ts >= startOfToday - 7 * day) return 'week'
  if (ts >= startOfToday - 30 * day) return 'month'
  return 'older'
}

function timeLabel(ts) {
  const date = new Date(ts)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  const pad = (n) => String(n).padStart(2, '0')
  if (sameDay) return pad(date.getHours()) + ':' + pad(date.getMinutes())
  return (date.getMonth() + 1) + '-' + pad(date.getDate())
}

function renderList() {
  if (state.searching) return
  const query = el.search.value.trim().toLowerCase()
  const rows = state.sessions
    .filter((item) => !state.hidden.has(item.id))
    .filter((item) => !query || String(item.title || '').toLowerCase().includes(query))
    .sort((a, b) => {
      const pinned = Number(state.pinned.has(b.id)) - Number(state.pinned.has(a.id))
      if (pinned !== 0) return pinned
      return (b.updatedAt || 0) - (a.updatedAt || 0)
    })

  if (!rows.length) {
    el.list.innerHTML = '<div class="empty-list">' + (query ? '没有匹配的对话' : '还没有对话') + '</div>'
    return
  }

  const buckets = new Map()
  for (const row of rows) {
    const key = groupOf(row.updatedAt || Date.now())
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push(row)
  }

  let html = ''
  for (const group of GROUPS) {
    const items = buckets.get(group.key)
    if (!items) continue
    html += '<div class="group-title">' + group.label + '</div>'
    for (const row of items) {
      const active = state.current && state.current.id === row.id ? ' active' : ''
      html +=
        '<div class="row' + active + '" data-id="' + escapeHtml(row.id) + '">' +
        '<div class="row-title">' + escapeHtml(row.title || '新对话') + '</div>' +
        '<div class="row-time">' + timeLabel(row.updatedAt || Date.now()) + '</div>' +
        '<button class="row-more" type="button" data-more="' + escapeHtml(row.id) + '">⋯</button>' +
        '</div>'
    }
  }
  if (state.historyHasMore) {
    html += '<div class="load-earlier"><button type="button" id="load-more-history">加载更多历史</button></div>'
  }
  el.list.innerHTML = html
}

/** 继续取下一页历史库（按更新时间倒序）。 */
async function loadMoreHistory() {
  const rows = state.sessions.filter((item) => item.kind === 'history')
  const cursor = rows.length ? rows[rows.length - 1].updatedAt : state.historyCursor
  const button = $('load-more-history')
  if (button) button.disabled = true
  try {
    const data = await api('history?limit=60&before=' + encodeURIComponent(cursor))
    const liveIds = new Set(state.sessions.filter((item) => item.kind !== 'history').map((item) => item.id))
    const more = (data.items || [])
      .filter((item) => !liveIds.has(item.id))
      .filter((item) => !state.sessions.some((existing) => existing.id === item.id))
      .map((item) => ({ ...item, kind: 'history' }))
    state.sessions = state.sessions.concat(more)
    state.historyHasMore = Boolean(data.hasMore)
    renderList()
  } catch (error) {
    toast('加载历史失败：' + error.message)
  }
}

async function loadList() {
  const data = await api('bootstrap')
  let history = { items: [], hasMore: false }
  try {
    history = await api('history?limit=60')
  } catch {
    history = { items: [], hasMore: false }
  }
  state.pinned = new Set((data.sessions || []).filter((item) => item.pinned).map((item) => item.id))
  state.sessions = (data.sessions || [])
    .filter((item) => !item.blank)   // 隐藏空会话（惰性新建后不应该再出现）
    .map((item) => ({
      ...item,
      title: item.title || '新对话',
    }))
  // 合并历史库（同 id 以 DSH 会话为准，避免重复）
  const liveIds = new Set(state.sessions.map((item) => item.id))
  const historyRows = (history.items || [])
    .filter((item) => !liveIds.has(item.id))
    .map((item) => ({ ...item, kind: 'history' }))
  state.sessions = state.sessions.concat(historyRows)
  state.historyHasMore = Boolean(history.hasMore)
  renderList()
}

// ── 搜索（标题 / 全文）────────────────────────────────────────
let searchTimer = null
let searchSeq = 0

function renderSearchResults(items, query) {
  if (!items.length) {
    el.list.innerHTML = '<div class="empty-list">没有匹配「' + escapeHtml(query) + '」</div>'
    return
  }
  el.list.innerHTML = items
    .map((item) => {
      const time = item.updatedAt ? timeLabel(item.updatedAt) : ''
      const snippet = item.snippet
        ? '<div class="row-snippet">' + escapeHtml(item.snippet) + '</div>'
        : ''
      return (
        '<div class="row" data-id="' + escapeHtml(item.id) + '">' +
        '<div class="row-title"><div>' + escapeHtml(item.title || '未命名对话') + '</div>' + snippet + '</div>' +
        '<div class="row-time">' + time + '</div>' +
        '</div>'
      )
    })
    .join('')
}

async function runSearch(scope) {
  const query = el.search.value.trim()
  if (!query) {
    el.searchTabs.hidden = true
    state.searching = false
    renderList()
    return
  }
  state.searching = true
  el.searchTabs.hidden = false
  const seq = ++searchSeq
  el.list.innerHTML = '<div class="empty-list">搜索中…</div>'
  try {
    const data = await api('search?q=' + encodeURIComponent(query) + '&scope=' + scope + '&limit=40')
    if (seq !== searchSeq) return
    renderSearchResults(data.items || [], query)
  } catch (error) {
    if (seq !== searchSeq) return
    el.list.innerHTML = '<div class="empty-list">搜索失败：' + escapeHtml(error.message) + '</div>'
  }
}

// ── 会话 ───────────────────────────────────────────────────
function setTitle(text) {
  el.title.textContent = text || '闲聊'
}

function buildMessages(records) {
  const out = []
  for (const record of records || []) {
    const event = record && record.event ? record.event : null
    if (!event) continue
    if (event.type === 'user/message') {
      const kind = event.data && event.data.source && event.data.source.kind
      if (kind && kind !== 'user') continue
      const parts = (event.data && event.data.content) || []
      const text = parts.filter((part) => part && part.type === 'text').map((part) => part.text).join('')
      const images = parts.filter((part) => part && part.type === 'image' && part.attachment).map((part) => part.attachment)
      const files = parts.filter((part) => part && part.type === 'file' && part.attachment).map((part) => part.attachment)
      if (!text.trim() && !images.length) continue
      out.push({ role: 'user', seq: event.seq, text, images, files })
    } else if (event.type === 'tool/call') {
      const name = String((event.data && event.data.name) || 'tool')
      out.push({
        role: 'tool',
        seq: event.seq,
        callId: (event.data && event.data.callId) || String(event.seq),
        name,
        args: String((event.data && event.data.arguments) || ''),
        result: '',
        isError: false,
      })
    } else if (event.type === 'tool/result') {
      const callId = String((event.data && event.data.callId) || '')
      const target = out.find((item) => item.role === 'tool' && item.callId === callId)
      if (target) {
        target.result = String((event.data && event.data.text) || '')
        target.isError = Boolean(event.data && event.data.isError)
      }
    } else if (event.type === 'assistant/message') {
      const content = (event.data && event.data.message && event.data.message.content) || []
      const text = content.filter((part) => part.type === 'text').map((part) => part.text).join('')
      const thinking = content.filter((part) => part.type === 'reasoning').map((part) => part.text).join('')
      if (!text.trim() && !thinking.trim()) continue
      out.push({ role: 'assistant', seq: event.seq, text, thinking, usage: event.data.usage })
    }
  }
  return out
}

function messageHtml(message, index) {
  const actions = message.readOnly
    ? ''
    : '<div class="actions">' +
    actionBtn('copy', '复制', index) +
    actionBtn('edit', '修改', index) +
    actionBtn('speak', '朗读', index, true) +
    actionBtn('regen', '重新生成', index) +
    actionBtn('branch', '分支', index) +
    actionBtn('delete', '删除该段', index) +
    '</div>'
  if (message.readOnly) {
    return (
      '<div class="msg assistant"><div class="body">' + renderMarkdown(message.text) + '</div></div>'
    )
  }

  if (message.role === 'tool') {
    const expanded = state.expandedTools.has(index)
    const summary = toolSummary(message)
    const mark = message.isError ? ' ⚠' : message.result ? ' ✓' : ''
    const label = /web_search/.test(message.name)
      ? '🌐 联网搜索'
      : /web_fetch/.test(message.name)
        ? '🌐 读取网页'
        : '🔧 ' + message.name
    const chip =
      '<button type="button" class="tool-chip' + (message.isError ? ' error' : '') + '" data-tool="' + index + '">' +
      label + (summary ? ' · ' + escapeHtml(summary.slice(0, 56)) : '') + mark +
      '</button>'
    const detail = expanded
      ? '<pre class="tool-detail">' + escapeHtml((message.args ? message.args + '\n\n' : '') + (message.result || '（无结果）')) + '</pre>'
      : ''
    return '<div class="msg tool"><div class="tool-cell">' + chip + detail + '</div></div>'
  }

  if (message.role === 'user') {
    return (
      '<div class="msg user">' +
      '<div class="user-col">' +
      '<div class="bubble">' + escapeHtml(message.text) + imagesHtml(message) + '</div>' +
      '<div class="actions user-actions">' +
      actionBtn('copy', '复制', index) +
      actionBtn('edit', '修改', index) +
      '</div></div></div>'
    )
  }

  const thinking = message.thinking
    ? '<button class="thinking-toggle" data-thinking="' + index + '">▸ 思考</button>' +
      '<div class="thinking-body" data-thinking-body="' + index + '" hidden>' + escapeHtml(message.thinking) + '</div>'
    : ''
  const usage = message.usage ? usageHtml(message.usage) : ''
  return (
    '<div class="msg assistant">' +
    thinking +
    '<div class="body">' + renderMarkdown(message.text) + '</div>' +
    usage +
    actions +
    '</div>'
  )
}

/** 用量：totalTokens 含缓存命中，所以分开显示，避免"总数对不上"的困惑。 */
function usageHtml(usage) {
  const num = (value) => Number(value || 0).toLocaleString('zh-CN')
  const input = Number(usage.inputTokens || 0)
  const output = Number(usage.outputTokens || 0)
  const cache = Number(usage.cacheReadTokens || 0)
  const billable = input + output
  const parts = ['输入 ' + num(input), '输出 ' + num(output)]
  if (cache > 0) parts.push('缓存命中 ' + num(cache))
  return '<div class="usage">本次 ' + num(billable) + ' tokens（' + parts.join(' · ') + '）</div>'
}

function imagesHtml(message) {
  const files = (message.files || []).map((file) =>
    '<div class="bubble-file">📄 ' + escapeHtml(String(file.name || '文件')) + '</div>',
  ).join('')
  if (!message.images || !message.images.length) return files
  const sessionId = (state.current && state.current.id) || ''
  return '<div class="bubble-images">' + message.images.map((ref) => {
    const src = ref.localUrl ||
      ('api/image?sessionId=' + encodeURIComponent(sessionId) + '&id=' + encodeURIComponent(ref.attachmentId || ''))
    return '<img src="' + escapeHtml(src) + '" alt="图片" loading="lazy" />'
  }).join('') + files + '</div>'
}

/** 从工具参数里挑一行最有信息量的摘要。 */
function toolSummary(message) {
  try {
    const args = JSON.parse(message.args || '{}')
    if (args.url) return String(args.url)
    if (Array.isArray(args.queries)) return args.queries.join(' / ')
    if (args.query) return String(args.query)
    if (args.command) return String(args.command)
    if (args.path) return String(args.path)
  } catch {
    // 参数不是 JSON 就忽略
  }
  return ''
}

function actionBtn(kind, label, index, disabled) {
  return (
    '<button class="icon-btn' + (disabled ? ' disabled' : '') + '" type="button" ' +
    'data-action="' + kind + '" data-index="' + index + '"' + (disabled ? ' disabled' : '') +
    ' title="' + label + '" aria-label="' + label + '">' + iconSvg(kind) + '</button>'
  )
}

/** 从 assistant-stream 帧里取文本增量（不同版本字段略有差异，做了兼容）。 */
function extractDelta(frame) {
  const empty = { text: '', reasoning: '' }
  if (!frame) return empty
  const chunk = frame.chunk || frame
  if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') {
    return { text: chunk.text, reasoning: '' }
  }
  if (chunk && chunk.type === 'reasoning-delta' && typeof chunk.text === 'string') {
    return { text: '', reasoning: chunk.text }
  }
  return empty
}

function iconSvg(kind) {
  const paths = {
    copy: '<path d="M8 3h9v12H8zM5 6h2v12h9v2H5z"/>',
    edit: '<path d="M4 20h4l10-10-4-4L4 16v4zm12.7-12.7l1.6-1.6-2-2-1.6 1.6 2 2z"/>',
    speak: '<path d="M4 9v6h4l5 4V5L8 9H4z"/>',
    regen: '<path d="M12 5V2L7 6l5 4V7a5 5 0 11-5 5H5a7 7 0 107-7z"/>',
    branch: '<path d="M6 3a2 2 0 100 4 2 2 0 000-4zm12 0a2 2 0 100 4 2 2 0 000-4zM7 7v6a4 4 0 004 4h1v3l4-4-4-4v3h-1a2 2 0 01-2-2V7H7z"/>',
    delete: '<path d="M6 7h12l-1 13H7L6 7zm3-3h6l1 2H8l1-2z"/>',
  }
  return '<svg viewBox="0 0 24 24" class="icon">' + (paths[kind] || '') + '</svg>'
}

function renderMessages(keepScroll) {
  const previousHeight = el.messages.scrollHeight
  const previousTop = el.messages.scrollTop
  const hasAny = state.messages.length > 0
  el.empty.hidden = hasAny || Boolean(state.current)
  el.messages.hidden = !hasAny
  const thinkingLive = state.liveThinking
    ? '<div class="thinking-body live">' + escapeHtml(state.liveThinking) + '</div>'
    : ''
  const typing = state.running
    ? state.liveText || state.liveThinking
      ? '<div class="msg assistant">' + thinkingLive +
        (state.liveText ? '<div class="body">' + renderMarkdown(state.liveText) + '</div>' : '') +
        '</div>'
      : '<div class="msg assistant"><div class="typing"><span></span><span></span><span></span></div></div>'
    : ''
  const earlier = state.hasMore && state.current
    ? '<div class="load-earlier"><button type="button" id="load-earlier">加载更早的消息</button></div>'
    : ''
  el.messages.innerHTML = earlier + state.messages.map(messageHtml).join('') + typing
  if (hasAny) {
    requestAnimationFrame(() => {
      if (keepScroll) {
        el.messages.scrollTop = el.messages.scrollHeight - previousHeight + previousTop
      } else {
        el.messages.scrollTop = el.messages.scrollHeight
      }
    })
  }
}

/** 向上翻页：取更早的一页并接在前面。 */
async function loadEarlier() {
  if (!state.current || !state.earliestSeq) return
  const button = $('load-earlier')
  if (button) button.disabled = true
  try {
    const data = await api(
      'page?sessionId=' + encodeURIComponent(state.current.id) +
      '&beforeSeq=' + encodeURIComponent(state.earliestSeq) + '&max=40',
    )
    const records = data.records || []
    if (!records.length) {
      state.hasMore = false
      renderMessages(true)
      return
    }
    const older = buildMessages(records)
    state.messages = older.concat(state.messages)
    state.earliestSeq = records[0].event.seq
    state.hasMore = Boolean(data.hasMore)
    renderMessages(true)
  } catch (error) {
    toast('加载失败：' + error.message)
  }
}

async function openSession(id) {
  closeDrawer()
  state.readOnly = false
  renderReadOnlyBar(false)
  const session = state.sessions.find((item) => item.id === id)
  state.current = session || { id }
  setTitle(session ? session.title : '对话')
  state.messages = []
  state.records = []
  try {
    const data = await api('page?sessionId=' + encodeURIComponent(id) + '&max=40')
    state.records = data.records || []
    state.messages = buildMessages(state.records)
    state.hasMore = Boolean(data.hasMore)
    state.earliestSeq = state.records.length ? state.records[0].event.seq : 0
    renderMessages()
    if (!state.static) startFollow(id)
    renderList()
  } catch (error) {
    toast('打开失败：' + error.message)
  }
}

/** 打开历史库里的会话（只读）。 */
async function openHistory(id) {
  closeDrawer()
  stopFollow()
  const row = state.sessions.find((item) => item.id === id)
  state.current = { id, kind: 'history', title: row ? row.title : '历史对话' }
  state.readOnly = true
  setTitle((row && row.title) || '历史对话')
  try {
    const data = await api('history-item?id=' + encodeURIComponent(id))
    state.messages = (data.messages || []).map((message) => ({
      role: message.role,
      text: message.text,
      thinking: message.thinking,
      readOnly: message.role === 'assistant',
    }))
    state.hasMore = false
    renderMessages()
    renderReadOnlyBar(true)
  } catch (error) {
    toast('打开历史失败：' + error.message)
  }
  renderList()
}

/** 只读提示条：显示在输入框位置上方。 */
function renderReadOnlyBar(show) {
  let bar = $('readonly-bar')
  if (!bar) {
    bar = document.createElement('div')
    bar.id = 'readonly-bar'
    bar.className = 'readonly-bar'
    document.body.appendChild(bar)
  }
  bar.hidden = !show
  if (!show) return
  bar.innerHTML = ''
  const text = document.createElement('span')
  text.textContent = '历史记录（只读）'
  bar.appendChild(text)
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = '继续对话'
  button.addEventListener('click', () => continueFromHistory())
  bar.appendChild(button)
}

/** 基于历史记录新建一个会话并继续。 */
async function continueFromHistory() {
  if (!state.current || state.current.kind !== 'history') return
  const transcript = state.messages
    .filter((message) => message.text)
    .map((message) => (message.role === 'user' ? '用户：' : '助手：') + message.text)
    .join('\n\n')
    .slice(0, 20000)
  try {
    const created = await api('new', { method: 'POST', body: {} })
    showDialog({ title: '已新建会话', text: '历史内容会作为第一条消息发送，之后可以继续聊。', confirm: '继续', mode: 'confirm' })
    const prompt = '以下是我之前的一段对话记录，请据此了解上下文，之后我们继续聊：\n\n' + transcript
    await api('send', { method: 'POST', body: { sessionId: created.sessionId, text: prompt } })
    await loadList()
    state.readOnly = false
    renderReadOnlyBar(false)
    await openSession(created.sessionId)
  } catch (error) {
    toast('继续对话失败：' + error.message)
  }
}

async function startFollow(sessionId) {
  stopFollow()
  const source = new EventSource('api/follow?sessionId=' + encodeURIComponent(sessionId) + '&max=30')
  state.source = source
  setConn(true)
  source.onmessage = (event) => {
    let frame
    try {
      frame = JSON.parse(event.data)
    } catch {
      return
    }
    if (frame.type === 'snapshot') {
      state.records = frame.records || []
      state.messages = buildMessages(state.records)
      renderMessages()
    } else if (frame.type === 'event') {
      if (frame.event && frame.event.type === 'assistant/message') {
        state.running = false
        state.liveText = ''
        state.liveThinking = ''
        renderSend()
      }
      const next = buildMessages([{ event: frame.event }])
      if (next.length) {
        if (next.some((item) => item.role === 'user')) {
          state.messages = state.messages.filter((item) => !item.local)
        }
        state.messages = state.messages.concat(next)
        renderMessages()
      }
    } else if (frame.type === 'assistant-stream') {
      const delta = extractDelta(frame.frame || frame)
      if (delta.text || delta.reasoning) {
        if (delta.text) state.liveText += delta.text
        if (delta.reasoning) state.liveThinking += delta.reasoning
        renderMessages()
      }
    } else if (frame.type === 'error') {
      state.running = false
      renderSend()
      toast('连接异常：' + (frame.message || ''))
    }
  }
  source.onerror = () => {
    setConn(false)
    // 断线后 3 秒重连（仍是当前会话才重连，避免切走后还在后台拉流）
    clearTimeout(startFollow.timer)
    startFollow.timer = setTimeout(() => {
      if (state.current && state.current.id === sessionId) startFollow(sessionId)
    }, 3000)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 发送后轮询直到出现新的助手消息。
 * SSE 正常时它会先到，这个循环只是保险；最坏情况下也能在 1.5 秒内看到结果。
 */
async function pollForReply(sessionId, baselineAssistants) {
  const deadline = Date.now() + 5 * 60 * 1000
  while (Date.now() < deadline) {
    await sleep(1500)
    if (!state.current || state.current.id !== sessionId) return
    try {
      const data = await api('page?sessionId=' + encodeURIComponent(sessionId) + '&max=60')
      const next = buildMessages(data.records)
      const assistants = next.filter((item) => item.role === 'assistant').length
      // 只有在出现「新的助手消息」时才整体替换，避免把流式中的文本覆盖成空
      if (assistants > baselineAssistants) {
        state.messages = next
        state.running = false
        state.liveText = ''
        state.liveThinking = ''
        renderMessages()
        renderSend()
        return
      }
    } catch {
      // 网络抖动继续重试
    }
  }
  state.running = false
  renderSend()
}

function stopFollow() {
  if (state.source) {
    try { state.source.close() } catch {}
    state.source = null
  }
}

function setConn(online) {
  el.conn.className = 'conn ' + (online ? 'online' : 'offline')
}

// ── 发送 / 停止 ───────────────────────────────────────────
async function ensureSession() {
  if (state.current) return state.current.id
  const created = await api('new', { method: 'POST', body: {} })
  await loadList()
  const id = created.sessionId
  state.current = state.sessions.find((item) => item.id === id) || { id }
  setTitle('新对话')
  startFollow(id)
  return id
}

async function sendMessage() {
  if (state.readOnly) {
    toast('这是历史记录，点「继续对话」后可以继续聊')
    return
  }
  const text = el.input.value.trim()
  if (!text) return
  if (state.running) return
  el.input.value = ''
  autoGrow()
  try {
    if (state.editing) {
      const editing = state.editing
      state.editing = null
      const result = await api('fork', {
        method: 'POST',
        body: { sessionId: state.current.id, atSeq: editing.atSeq, text },
      })
      await loadList()
      await openSession(result.sessionId)
      state.running = true
      renderSend()
      return
    }
    const id = await ensureSession()
    const images = state.pendingImages.map((item) => ({
      mediaType: item.mediaType,
      data: item.data,
      ...(item.name ? { name: item.name } : {}),
    }))
    const baseline = state.messages.filter((item) => item.role === 'assistant').length
    // 乐观显示：不等服务端回显，先把这条放到界面上
    state.messages = state.messages.concat([{
      role: 'user',
      text: outgoing,
      images: state.pendingImages.map((item) => ({ localUrl: item.dataUrl })),
      files: state.pendingFiles.map((item) => ({ name: item.name })),
      local: true,
    }])
    state.pendingImages = []
    renderPending()
    state.running = true
    state.liveText = ''
    state.liveThinking = ''
    renderMessages()
    renderSend()
    // 文件处理：文本类直接把内容附在正文里（模型真能读到）；
    // 二进制仍作为附件上传，但只记录引用。
    const fileReceipts = []
    let inlineText = ''
    for (const item of state.pendingFiles) {
      const text = decodeTextFile(item.data, item.name)
      if (text !== null) {
        inlineText += '\n\n[附件 ' + item.name + ']\n```\n' + text + '\n```'
        continue
      }
      const uploaded = await api('upload-file', {
        method: 'POST',
        body: { sessionId: id, name: item.name, data: item.data },
      })
      fileReceipts.push({ receiptId: uploaded.receiptId })
    }
    const files = fileReceipts
    const outgoing = text + inlineText
    await api('send', { method: 'POST', body: { sessionId: id, text: outgoing, images, files } })
    state.pendingFiles = []
    // 轮询兜底：即使 SSE 不工作，也能看到回复
    pollForReply(id, baseline)
  } catch (error) {
    toast('发送失败：' + error.message)
  }
}

async function stopMessage() {
  if (!state.current) return
  try {
    await api('cancel', { method: 'POST', body: { sessionId: state.current.id } })
  } catch (error) {
    toast('停止失败：' + error.message)
  }
}

function renderSend() {
  el.send.classList.toggle('stop', state.running)
  el.send.setAttribute('aria-label', state.running ? '停止' : '发送')
  el.send.innerHTML = state.running
    ? '<svg viewBox="0 0 24 24" class="icon"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>'
    : '<svg viewBox="0 0 24 24" class="icon"><path d="M12 19V5M6 11l6-6 6 6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>'
}

// ── 芯片与开关 ───────────────────────────────────────────
function renderChips() {
  el.effortChip.textContent = '思考强度:' + (EFFORT_LABEL[state.effort] || '高')
  el.webChip.textContent = state.web ? '🌐 开' : '🌐 关'
  el.webChip.classList.toggle('chip-on', state.web)
}

async function applyEffort(effort) {
  state.effort = effort
  localStorage.setItem('chat-lite:effort', effort)
  renderChips()
  if (state.current) {
    try {
      await api('effort', { method: 'POST', body: { sessionId: state.current.id, effort } })
    } catch (error) {
      toast('档位设置失败：' + error.message)
    }
  }
}

async function toggleWeb() {
  const next = !state.web
  state.web = next
  localStorage.setItem('chat-lite:web', next ? '1' : '0')
  renderChips()
  if (state.current) {
    try {
      await api('web', { method: 'POST', body: { sessionId: state.current.id, enabled: next } })
    } catch (error) {
      toast('联网开关失败：' + error.message)
    }
  }
}

// ── 抽屉 ─────────────────────────────────────────────────
function openDrawer() {
  // 每次打开抽屉都静默拉一次列表（新会话、标题变化不用手动刷新）
  loadList().catch(() => {})
  el.drawer.classList.add('open')
  el.drawer.setAttribute('aria-hidden', 'false')
  el.scrim.hidden = false
  requestAnimationFrame(() => el.scrim.classList.add('show'))
}
function closeDrawer() {
  el.drawer.classList.remove('open')
  el.drawer.setAttribute('aria-hidden', 'true')
  el.scrim.classList.remove('show')
  setTimeout(() => { el.scrim.hidden = true }, 200)
}

// ── 事件绑定 ─────────────────────────────────────────────
function autoGrow() {
  el.input.style.height = 'auto'
  el.input.style.height = Math.min(140, el.input.scrollHeight) + 'px'
}

el.input.addEventListener('input', autoGrow)
el.send.addEventListener('click', () => (state.running ? stopMessage() : sendMessage()))
el.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    sendMessage()
  }
})
$('open-drawer').addEventListener('click', openDrawer)
el.scrim.addEventListener('click', closeDrawer)
$('new-chat').addEventListener('click', newChat)
$('new-chat-top').addEventListener('click', newChat)
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => runSearch(state.scope), 260)
})
el.searchTabs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-scope]')
  if (!button) return
  state.scope = button.dataset.scope
  for (const item of el.searchTabs.querySelectorAll('button')) {
    item.classList.toggle('active', item === button)
  }
  runSearch(state.scope)
})
$('refresh').addEventListener('click', () => location.reload())
$('hard-reload').addEventListener('click', hardReload)

/**
 * 卡在旧前端时的唯一可靠手段：注销 Service Worker、清空所有缓存，再带参数重进。
 */
async function hardReload() {
  try {
    const registrations = await navigator.serviceWorker.getRegistrations()
    await Promise.all(registrations.map((item) => item.unregister()))
    const keys = await caches.keys()
    await Promise.all(keys.map((key) => caches.delete(key)))
  } catch {
    // 忽略：能清多少算多少
  }
  location.replace(location.pathname + '?fresh=' + Date.now())
}

// 消息区下拉刷新（页面本身不可滚动，所以自己实现）
let pullStart = 0
el.messages.addEventListener('touchstart', (event) => {
  pullStart = el.messages.scrollTop <= 0 ? event.touches[0].clientY : 0
}, { passive: true })
el.messages.addEventListener('touchmove', (event) => {
  if (!pullStart) return
  if (event.touches[0].clientY - pullStart > 90) {
    pullStart = 0
    location.reload()
  }
}, { passive: true })

// SW 更新后自动接管一次，避免"改了看不到"
let reloading = false
if (navigator.serviceWorker) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading) return
    reloading = true
    location.reload()
  })
}

// ── 会话菜单（原实现丢失，这里补回；用页面内弹窗，PWA 里可用）─────
let menuSheet = null

function closeMenu() {
  if (menuSheet && menuSheet.parentNode) menuSheet.parentNode.removeChild(menuSheet)
  menuSheet = null
}

function openSessionMenu(id) {
  closeMenu()
  const isPinned = state.pinned.has(id)
  const sheet = document.createElement('div')
  sheet.className = 'menu-sheet'
  sheet.innerHTML =
    '<button type="button" data-op="rename">重命名</button>' +
    '<button type="button" data-op="' + (isPinned ? 'unpin' : 'pin') + '">' + (isPinned ? '取消置顶' : '置顶') + '</button>' +
    '<button type="button" class="danger" data-op="archive">删除</button>'
  sheet.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-op]')
    if (!button) return
    const op = button.getAttribute('data-op')
    closeMenu()
    await runSessionOp(id, op)
  })
  document.body.appendChild(sheet)
  menuSheet = sheet
  setTimeout(() => {
    document.addEventListener('click', closeMenu, { once: true })
  }, 0)
}

async function runSessionOp(id, op) {
  const session = state.sessions.find((item) => item.id === id)
  try {
    if (op === 'rename') {
      const current = (session && session.title) || ''
      const title = await showDialog({
        title: '重命名对话',
        value: current,
        placeholder: '输入新的标题',
        confirm: '保存',
      })
      if (title === null) return
      const trimmed = String(title).trim()
      if (!trimmed || trimmed === current) return
      await api('session-op', { method: 'POST', body: { op: 'rename', sessionId: id, title: trimmed } })
      await loadList()
      if (state.current && state.current.id === id) setTitle(trimmed)
      toast('已重命名')
      return
    }
    if (op === 'pin' || op === 'unpin') {
      await api('session-op', { method: 'POST', body: { op, sessionId: id } })
      if (op === 'pin') state.pinned.add(id)
      else state.pinned.delete(id)
      renderList()
      toast(op === 'pin' ? '已置顶' : '已取消置顶')
      return
    }
    if (op === 'archive') {
      const ok = await showDialog({
        title: '删除这条对话？',
        text: '它会从列表里移除。内容仍保留在磁盘上，可在 DSH 桌面端恢复。',
        confirm: '删除',
        danger: true,
        mode: 'confirm',
      })
      if (!ok) return
      await api('session-op', { method: 'POST', body: { op: 'archive', sessionId: id } })
      state.hidden.add(id)
      if (state.current && state.current.id === id) state.current = null
      await loadList()
      toast('已从列表移除')
      return
    }
  } catch (error) {
    toast('操作失败：' + error.message)
  }
}
// 惰性新建：只切到空态，真正创建留给第一次发送（避免堆一串空会话）
function newChat() {
  closeDrawer()
  stopFollow()
  state.current = null
  state.messages = []
  state.records = []
  setTitle('闲聊')
  renderMessages()
  renderList()
  el.input.focus()
}

el.list.addEventListener('click', (event) => {
  const more = event.target.closest('[data-more]')
  if (more) {
    event.stopPropagation()
    openSessionMenu(more.dataset.more)
    return
  }
  if (event.target.closest('#load-more-history')) {
    loadMoreHistory()
    return
  }
  const row = event.target.closest('.row')
  if (!row || !row.dataset.id) return
  const target = state.sessions.find((item) => item.id === row.dataset.id)
  if (target && target.kind === 'history') openHistory(row.dataset.id)
  else if (!target) openHistory(row.dataset.id)   // 搜索结果里的历史条目
  else openSession(row.dataset.id)
})

el.messages.addEventListener('click', async (event) => {
  if (event.target.closest('#load-earlier')) {
    loadEarlier()
    return
  }
  const toolChip = event.target.closest('[data-tool]')
  if (toolChip) {
    const index = Number(toolChip.dataset.tool)
    if (state.expandedTools.has(index)) state.expandedTools.delete(index)
    else state.expandedTools.add(index)
    renderMessages(true)
    return
  }
  const thinking = event.target.closest('[data-thinking]')
  if (thinking) {
    const index = thinking.dataset.thinking
    const body = el.messages.querySelector('[data-thinking-body="' + index + '"]')
    if (body) {
      body.hidden = !body.hidden
      thinking.textContent = (body.hidden ? '▸ ' : '▾ ') + '思考'
    }
    return
  }
  const action = event.target.closest('[data-action]')
  if (!action || action.disabled) return
  const index = Number(action.dataset.index)
  const message = state.messages[index]
  if (!message) return
  const kind = action.dataset.action
  if (kind === 'copy') {
    const ok = await copyText(message.text || '')
    toast(ok ? '已复制整条消息' : '复制失败，请手动选择')
    return
  }
  const prevSeq = (i) => (i > 0 ? state.messages[i - 1].seq : undefined)
  try {
    if (kind === 'edit') {
      if (message.role !== 'user') return toast('只有你自己的消息可以修改')
      if (prevSeq(index) === undefined) return toast('第一条消息暂不支持修改')
      state.editing = { atSeq: prevSeq(index) }
      el.input.value = message.text
      autoGrow()
      el.input.focus()
      toast('修改后发送，将从这一条重新分叉')
      return
    }
    if (kind === 'regen') {
      const prev = state.messages[index - 1]
      if (!prev || prev.role !== 'user') return toast('找不到对应的用户消息')
      const atSeq = prevSeq(index - 1)
      if (atSeq === undefined) return toast('第一条无法重新生成')
      await forkAndOpen(atSeq, prev.text)
      return
    }
    if (kind === 'branch') {
      await forkAndOpen(message.seq)
      return
    }
    if (kind === 'delete') {
      const atSeq = prevSeq(index)
      if (atSeq === undefined) return toast('第一条之前没有可保留的内容')
      await forkAndOpen(atSeq)
      return
    }
  } catch (error) {
    toast('操作失败：' + error.message)
  }
})

/** 分叉并在新会话里继续（可选立刻发一条）。 */
async function forkAndOpen(atSeq, text) {
  if (!state.current) return toast('当前没有会话')
  const body = { sessionId: state.current.id }
  if (atSeq !== undefined) body.atSeq = atSeq
  if (text) body.text = text
  const result = await api('fork', { method: 'POST', body })
  await loadList()
  await openSession(result.sessionId)
  toast(text ? '已在新会话重发' : '已分叉到新会话')
}

el.effortChip.addEventListener('click', () => {
  const rect = el.effortChip.getBoundingClientRect()
  el.effortPop.hidden = false
  el.effortPop.style.left = Math.max(8, rect.left) + 'px'
  el.effortPop.style.bottom = window.innerHeight - rect.top + 8 + 'px'
})
el.effortPop.addEventListener('click', (event) => {
  const button = event.target.closest('[data-effort]')
  if (!button) return
  el.effortPop.hidden = true
  applyEffort(button.dataset.effort)
})
document.addEventListener('click', (event) => {
  if (!el.effortPop.hidden && !event.target.closest('#effort-pop') && !event.target.closest('#effort-chip')) {
    el.effortPop.hidden = true
  }
})

el.webChip.addEventListener('click', toggleWeb)
el.attach.addEventListener('click', () => { el.attachSheet.hidden = !el.attachSheet.hidden })
el.attachSheet.addEventListener('click', (event) => {
  const button = event.target.closest('[data-kind]')
  if (!button || button.disabled) return
  el.attachSheet.hidden = true
  if (button.dataset.kind === 'camera') el.fileCamera.click()
  if (button.dataset.kind === 'file') el.fileDoc.click()
  if (button.dataset.kind === 'album') el.fileAlbum.click()
})
el.fileCamera.addEventListener('change', () => pickImages(el.fileCamera))
el.fileDoc.addEventListener('change', () => pickFiles(el.fileDoc))
el.fileAlbum.addEventListener('change', () => pickImages(el.fileAlbum))

/** 读取本地图片 → 上传宿主 → 记入待发送列表 */
async function pickImages(input) {
  const files = Array.from(input.files || [])
  input.value = ''
  for (const file of files) {
    if (state.pendingImages.length >= 4) { toast('一次最多 4 张图片'); break }
    if (file.size > 10 * 1024 * 1024) { toast('图片超过 10MB，已跳过'); continue }
    try {
      const rawUrl = await readAsDataUrl(file)
      const compressed = await compressImage(rawUrl)
      state.pendingImages.push({
        mediaType: compressed.mediaType,
        data: compressed.dataUrl.slice(compressed.dataUrl.indexOf(',') + 1),
        name: file.name,
        dataUrl: compressed.dataUrl,
      })
      renderPending()
    } catch (error) {
      toast('读取图片失败：' + error.message)
    }
  }
}

/**
 * 压缩图片：长边超过 1600 或体积偏大时，用 canvas 重编码为 JPEG。
 * 手机上原图往往 3-5MB，压完通常只剩几百 KB，发送更快也更省流量。
 */
function compressImage(dataUrl, maxSide = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    const image = new Image()
    image.onload = () => {
      const { width, height } = image
      const longSide = Math.max(width, height)
      const bytes = Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 0.75)
      if (longSide <= maxSide && bytes <= 900 * 1024) {
        resolve({ dataUrl, mediaType: dataUrl.slice(5, dataUrl.indexOf(';')) || 'image/jpeg' })
        return
      }
      const scale = Math.min(1, maxSide / longSide)
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(width * scale)
      canvas.height = Math.round(height * scale)
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0, canvas.width, canvas.height)
      try {
        resolve({ dataUrl: canvas.toDataURL('image/jpeg', quality), mediaType: 'image/jpeg' })
      } catch {
        resolve({ dataUrl, mediaType: 'image/jpeg' })
      }
    }
    image.onerror = () => resolve({ dataUrl, mediaType: 'image/jpeg' })
    image.src = dataUrl
  })
}

/** 尝试把 base64 内容按 UTF-8 文本解码；二进制或过大则返回 null。 */
function decodeTextFile(base64, name) {
  const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|js|mjs|cjs|ts|tsx|jsx|py|java|c|h|cpp|cs|go|rs|rb|php|sh|ps1|html|htm|css|scss|xml|yml|yaml|ini|toml|sql)$/i
  if (!TEXT_EXT.test(String(name || ''))) return null
  try {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    if (bytes.length > 200 * 1024) return null
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text.replace(/\u0000/g, '').slice(0, 60000)
  } catch {
    return null
  }
}

function readAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(new Error('读取文件失败'))
    reader.readAsDataURL(file)
  })
}

/** 选择普通文件：先暂存内容，发送时再按会话上传并取收据。 */
async function pickFiles(input) {
  const files = Array.from(input.files || [])
  input.value = ''
  for (const file of files) {
    if (file.size > 10 * 1024 * 1024) {
      toast('文件超过 10MB，已跳过')
      continue
    }
    try {
      const dataUrl = await readAsDataUrl(file)
      state.pendingFiles.push({
        name: file.name,
        data: dataUrl.slice(dataUrl.indexOf(',') + 1),
      })
      renderPending()
    } catch (error) {
      toast('读取文件失败：' + error.message)
    }
  }
}

function renderPending() {
  const images = state.pendingImages
  const files = state.pendingFiles
  el.pending.hidden = images.length === 0 && files.length === 0
  const imageHtml = images.map((item, index) =>
    '<div class="pending-item"><img src="' + item.dataUrl + '" alt="待发送图片" />' +
    '<button type="button" data-remove="' + index + '" aria-label="移除">×</button></div>',
  ).join('')
  const fileHtml = files.map((item, index) =>
    '<div class="pending-file">📄 ' + escapeHtml(String(item.name || '文件')) +
    '<button type="button" data-remove-file="' + index + '" aria-label="移除">×</button></div>',
  ).join('')
  el.pending.innerHTML = imageHtml + fileHtml
}

el.pending.addEventListener('click', (event) => {
  const imageButton = event.target.closest('[data-remove]')
  if (imageButton) {
    state.pendingImages.splice(Number(imageButton.dataset.remove), 1)
    renderPending()
    return
  }
  const fileButton = event.target.closest('[data-remove-file]')
  if (fileButton) {
    state.pendingFiles.splice(Number(fileButton.dataset.removeFile), 1)
    renderPending()
  }
})

function updateOnlineState() {
  const offline = navigator.onLine === false
  if (el.offlineBanner) el.offlineBanner.hidden = !offline
  setConn(!offline)
}

window.addEventListener('online', updateOnlineState)
window.addEventListener('offline', updateOnlineState)

// Service Worker：离线壳 + 最近 3 天缓存
if (navigator.serviceWorker) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js', { scope: './' }).then((registration) => {
      // 每次回到前台都查一次更新，避免长期卡在旧版本
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') registration.update().catch(() => {})
      })
    }).catch(() => {
      // https/localhost 之外注册会失败，属于预期
    })
  })
}

// ── 启动 ─────────────────────────────────────────────────
let dialogResolve = null

/** 页面内弹窗：mode='input' 改名，mode='confirm' 确认。返回 Promise<值|null> */
function showDialog(options) {
  const { title, value = '', placeholder = '', text = '', confirm = '确定', danger = false, mode = 'input' } = options
  el.dialogTitle.textContent = title || ''
  el.dialogText.hidden = mode !== 'confirm'
  el.dialogText.textContent = text
  el.dialogInput.hidden = mode !== 'input'
  el.dialogInput.value = value
  el.dialogInput.placeholder = placeholder
  el.dialogOk.textContent = confirm
  el.dialogOk.className = 'dialog-btn ' + (danger ? 'danger' : 'primary')
  el.dialog.hidden = false
  if (mode === 'input') {
    setTimeout(() => {
      el.dialogInput.focus()
      el.dialogInput.setSelectionRange(el.dialogInput.value.length, el.dialogInput.value.length)
    }, 60)
  }
  return new Promise((resolve) => {
    dialogResolve = resolve
  })
}

function closeDialog(result) {
  el.dialog.hidden = true
  const resolve = dialogResolve
  dialogResolve = null
  if (resolve) resolve(result)
}

el.dialogOk.addEventListener('click', () => {
  closeDialog(el.dialogInput.hidden ? true : el.dialogInput.value.trim())
})
el.dialogCancel.addEventListener('click', () => closeDialog(null))
el.dialog.addEventListener('click', (event) => {
  if (event.target === el.dialog) closeDialog(null)
})

function showPairing(message) {
  el.pairing.hidden = false
  el.pairingMsg.textContent = message || ''
  setTimeout(() => el.pairingInput.focus(), 60)
}

function hidePairing() {
  el.pairing.hidden = true
  el.pairingMsg.textContent = ''
}

async function submitPairing() {
  const raw = el.pairingInput.value.trim()
  if (!raw) {
    el.pairingMsg.textContent = '请先粘贴配对链接'
    return
  }
  el.pairingSubmit.disabled = true
  el.pairingMsg.textContent = '正在连接…'
  try {
    const result = await fetch('api/pair', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'x-chat-lite': '1' },
      body: JSON.stringify({ token: raw }),
    }).then((response) => response.json())
    if (!result.ok) throw new Error(result.error || '配对失败')
    el.pairingInput.value = ''
    hidePairing()
    await loadList()
    renderMessages()
    toast('已连接')
  } catch (error) {
    el.pairingMsg.textContent = String(error.message || error)
  } finally {
    el.pairingSubmit.disabled = false
  }
}

el.pairingSubmit.addEventListener('click', submitPairing)
$('settings-entry').addEventListener('click', () => {
  closeDrawer()
  showPairing('粘贴新的配对链接即可换绑这台设备')
})

async function boot() {
  document.title = '闲聊 v' + BUILD
  if (!checkElements()) return
  const build = $('build')
  if (build) build.textContent = 'v' + BUILD
  renderChips()
  renderSend()
  updateOnlineState()
  try {
    await loadList()
  } catch (error) {
    if (error.needPair) showPairing()
    else toast('加载失败：' + error.message)
  }
  renderMessages()

  // 测试/书签用深链：#drawer 打开抽屉；#s:<sessionId> 直接进会话
  const hash = decodeURIComponent(location.hash || '')
  if (hash === '#drawer') openDrawer()
  if (hash.startsWith('#s:')) {
    const raw = hash.slice(3)
    state.static = raw.includes('static')
    const id = raw.split('&')[0]
    if (id) openSession(id)
  }
}

boot()