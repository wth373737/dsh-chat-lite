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
  editing: null,   // { atSeq, text } 修改用户消息时使用
  liveText: '',
  liveThinking: '',
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
    throw new Error(message)
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
  state.sessions = (data.sessions || [])
    .filter((item) => !item.blank)   // 隐藏空会话（惰性新建后不应该再出现）
    .map((item) => ({
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

function renderMessages() {
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
  el.messages.innerHTML = state.messages.map(messageHtml).join('') + typing
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
      if (frame.event && frame.event.type === 'assistant/message') {
        state.running = false
        state.liveText = ''
        state.liveThinking = ''
        renderSend()
      }
      const next = buildMessages([{ event: frame.event }])
      if (next.length) {
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
    await api('send', { method: 'POST', body: { sessionId: id, text } })
    state.running = true
    state.liveText = ''
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
