// dsh-chat-lite 移动端前端（无框架）
'use strict'

const $ = (id) => document.getElementById(id)
const el = {
  drawer: $('drawer'),
  scrim: $('drawer-scrim'),
  list: $('list'),
  search: $('search'),
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
  if (!json.ok) throw new Error(json.error || 'HTTP ' + response.status)
  return json
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
  const query = el.search.value.trim().toLowerCase()
  const rows = state.sessions
    .filter((item) => !query || String(item.title || '').toLowerCase().includes(query))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))

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
  el.list.innerHTML = html
}

async function loadList() {
  const data = await api('bootstrap')
  state.sessions = (data.sessions || []).map((item) => ({
    ...item,
    title: item.title || '新对话',
  }))
  renderList()
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
      const text = (event.data && event.data.content || [])
        .filter((part) => part && part.type === 'text')
        .map((part) => part.text)
        .join('')
      if (!text.trim()) continue
      out.push({ role: 'user', seq: event.seq, text })
    } else if (event.type === 'tool/call') {
      const name = String((event.data && event.data.name) || 'tool')
      out.push({ role: 'tool', seq: event.seq, name })
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
  const actions =
    '<div class="actions">' +
    actionBtn('copy', '复制', index) +
    actionBtn('edit', '修改', index) +
    actionBtn('speak', '朗读', index, true) +
    actionBtn('regen', '重新生成', index) +
    actionBtn('branch', '分支', index) +
    actionBtn('delete', '删除该段', index) +
    '</div>'

  if (message.role === 'tool') {
    const label = /web_search/.test(message.name)
      ? '🌐 联网搜索'
      : /web_fetch/.test(message.name)
        ? '🌐 读取网页'
        : '🔧 ' + message.name
    return '<div class="msg tool"><span class="tool-chip">' + escapeHtml(label) + '</span></div>'
  }

  if (message.role === 'user') {
    return (
      '<div class="msg user">' +
      '<div class="user-col">' +
      '<div class="bubble">' + escapeHtml(message.text) + '</div>' +
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
  const usage = message.usage
    ? '<div class="usage">本次消耗 ' +
      (message.usage.totalTokens || (message.usage.inputTokens || 0) + (message.usage.outputTokens || 0)) +
      ' tokens（输入 ' + (message.usage.inputTokens || 0) + ' · 输出 ' + (message.usage.outputTokens || 0) + '）</div>'
    : ''
  return (
    '<div class="msg assistant">' +
    thinking +
    '<div class="body">' + renderMarkdown(message.text) + '</div>' +
    usage +
    actions +
    '</div>'
  )
}

function actionBtn(kind, label, index, disabled) {
  return (
    '<button class="icon-btn' + (disabled ? ' disabled' : '') + '" type="button" ' +
    'data-action="' + kind + '" data-index="' + index + '"' + (disabled ? ' disabled' : '') +
    ' title="' + label + '" aria-label="' + label + '">' + iconSvg(kind) + '</button>'
  )
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

function renderMessages() {
  const hasAny = state.messages.length > 0
  el.empty.hidden = hasAny || Boolean(state.current)
  el.messages.hidden = !hasAny
  el.messages.innerHTML = state.messages.map(messageHtml).join('')
  if (hasAny) {
    requestAnimationFrame(() => {
      el.messages.scrollTop = el.messages.scrollHeight
    })
  }
}

async function openSession(id) {
  closeDrawer()
  const session = state.sessions.find((item) => item.id === id)
  state.current = session || { id }
  setTitle(session ? session.title : '对话')
  state.messages = []
  state.records = []
  try {
    const data = await api('page?sessionId=' + encodeURIComponent(id) + '&max=40')
    state.records = data.records || []
    state.messages = buildMessages(state.records)
    renderMessages()
    if (!state.static) startFollow(id)
    renderList()
  } catch (error) {
    toast('打开失败：' + error.message)
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
      const next = buildMessages([{ event: frame.event }])
      if (next.length) {
        state.messages = state.messages.concat(next)
        renderMessages()
      }
    } else if (frame.type === 'error') {
      toast('连接异常：' + (frame.message || ''))
    }
  }
  source.onerror = () => {
    setConn(false)
  }
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
  const text = el.input.value.trim()
  if (!text) return
  if (state.running) return
  el.input.value = ''
  autoGrow()
  try {
    const id = await ensureSession()
    await api('send', { method: 'POST', body: { sessionId: id, text } })
    state.running = true
    renderSend()
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
el.search.addEventListener('input', renderList)

async function newChat() {
  closeDrawer()
  try {
    const created = await api('new', { method: 'POST', body: {} })
    await loadList()
    await openSession(created.sessionId)
    el.input.focus()
  } catch (error) {
    toast('新建失败：' + error.message)
  }
}

el.list.addEventListener('click', (event) => {
  const more = event.target.closest('[data-more]')
  if (more) {
    event.stopPropagation()
    toast('重命名/置顶/删除：下一步实现')
    return
  }
  const row = event.target.closest('.row')
  if (row && row.dataset.id) openSession(row.dataset.id)
})

el.messages.addEventListener('click', async (event) => {
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
    try {
      await navigator.clipboard.writeText(message.text || '')
      toast('已复制')
    } catch {
      toast('复制失败，请长按选择')
    }
    return
  }
  toast('「' + action.getAttribute('title') + '」下一步实现')
})

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
  if (!button) return
  if (button.disabled) return
  toast('图片附件：下一步实现')
})

window.addEventListener('online', () => setConn(true))
window.addEventListener('offline', () => setConn(false))

// ── 启动 ─────────────────────────────────────────────────
async function boot() {
  renderChips()
  renderSend()
  setConn(true)
  try {
    await loadList()
  } catch (error) {
    toast('加载失败：' + error.message)
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
