import { readFileSync, writeFileSync } from 'node:fs'

const file = 'ui/app.js'
let source = readFileSync(file, 'utf8')
const notes = []

// 1) state 增加历史相关字段
if (!source.includes('historyCursor')) {
  source = source.replace(
    "  hasMore: false,",
    `  hasMore: false,
  readOnly: false,        // 历史记录只读
  historyCursor: 0,
  historyHasMore: false,`,
  )
  notes.push('state fields')
}

// 2) loadList 合并历史库
if (!source.includes("api('history?limit=")) {
  source = source.replace(
    `async function loadList() {
  const data = await api('bootstrap')`,
    `async function loadList() {
  const data = await api('bootstrap')
  let history = { items: [], hasMore: false }
  try {
    history = await api('history?limit=60' + (state.historyCursor ? '&before=' + state.historyCursor : ''))
  } catch {
    history = { items: [], hasMore: false }
  }`,
  )
  source = source.replace(
    `  renderList()
}

// ── 会话 ───`,
    `  // 合并历史库（同 id 以 DSH 会话为准，避免重复）
  const liveIds = new Set(state.sessions.map((item) => item.id))
  const historyRows = (history.items || [])
    .filter((item) => !liveIds.has(item.id))
    .map((item) => ({ ...item, kind: 'history' }))
  state.sessions = state.sessions.concat(historyRows)
  state.historyHasMore = Boolean(history.hasMore)
  const last = state.sessions[state.sessions.length - 1]
  state.historyCursor = last && last.kind === 'history' ? last.updatedAt : state.historyCursor
  renderList()
}

// ── 会话 ───`,
  )
  notes.push('loadList merge')
}

// 3) 行点击区分历史
source = source.replace(
  `  openSession(row.dataset.id)`,
  `  const target = state.sessions.find((item) => item.id === row.dataset.id)
  if (target && target.kind === 'history') openHistory(row.dataset.id)
  else openSession(row.dataset.id)`,
)

// 4) 只读渲染：不给操作行
source = source.replace(
  `  const actions =
    '<div class="actions">' +`,
  `  const actions = message.readOnly
    ? ''
    : '<div class="actions">' +`,
)
source = source.replace(
  `    actionBtn('delete', '删除该段', index) +
    '</div>'`,
  `    actionBtn('delete', '删除该段', index) +
    '</div>'
  if (message.readOnly) {
    return (
      '<div class="msg assistant"><div class="body">' + renderMarkdown(message.text) + '</div></div>'
    )
  }`,
)

// 5) openHistory 实现
if (!source.includes('async function openHistory')) {
  source = source.replace(
    'async function startFollow(sessionId) {',
    `/** 打开历史库里的会话（只读）。 */
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
    .join('\\n\\n')
    .slice(0, 20000)
  try {
    const created = await api('new', { method: 'POST', body: {} })
    showDialog({ title: '已新建会话', text: '历史内容会作为第一条消息发送，之后可以继续聊。', confirm: '继续', mode: 'confirm' })
    const prompt = '以下是我之前的一段对话记录，请据此了解上下文，之后我们继续聊：\\n\\n' + transcript
    await api('send', { method: 'POST', body: { sessionId: created.sessionId, text: prompt } })
    await loadList()
    state.readOnly = false
    renderReadOnlyBar(false)
    await openSession(created.sessionId)
  } catch (error) {
    toast('继续对话失败：' + error.message)
  }
}

async function startFollow(sessionId) {`,
  )
  notes.push('openHistory')
}

// 6) 打开普通会话时关掉只读条
source = source.replace(
  `async function openSession(id) {
  closeDrawer()`,
  `async function openSession(id) {
  closeDrawer()
  state.readOnly = false
  renderReadOnlyBar(false)`,
)

// 7) 只读时禁止发送
source = source.replace(
  `async function sendMessage() {
  const text = el.input.value.trim()`,
  `async function sendMessage() {
  if (state.readOnly) {
    toast('这是历史记录，点「继续对话」后可以继续聊')
    return
  }
  const text = el.input.value.trim()`,
)

writeFileSync(file, source)
console.log(notes.join('\n') || '(no changes)')
