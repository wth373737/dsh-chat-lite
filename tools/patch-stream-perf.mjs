import { readFileSync, writeFileSync } from 'node:fs'

const notes = []

// ═══════════ A. 宿主：follow 快照瘦身 ═══════════
const mobileFile = 'mobile.js'
let mobile = readFileSync(mobileFile, 'utf8')
if (!mobile.includes("frame.type === 'snapshot'")) {
  mobile = mobile.replace(
    `              for await (const frame of stream) {
                res.write('data: ' + JSON.stringify(frame) + '\\n\\n')
              }`,
    `              for await (const frame of stream) {
                // 快照按 page 的口径瘦身：长会话原始事件可达数百 KB，手机上解析即卡顿
                const payload = frame && frame.type === 'snapshot' && Array.isArray(frame.records)
                  ? { ...frame, records: slimRecords(frame.records) }
                  : frame
                res.write('data: ' + JSON.stringify(payload) + '\\n\\n')
              }`,
  )
  notes.push('A: follow 快照瘦身')
}
writeFileSync(mobileFile, mobile)

// ═══════════ B/C. 前端 ═══════════
const file = 'ui/app.js'
let source = readFileSync(file, 'utf8')

// 1) renderMessages：不再把流式内容混进整体重建
if (!source.includes('function paintLive')) {
  source = source.replace(
    `  const thinkingLive = state.liveThinking
    ? '<div class="thinking-body live">' + escapeHtml(state.liveThinking) + '</div>'
    : ''
  const typing = state.running
    ? state.liveText || state.liveThinking
      ? '<div class="msg assistant">' + thinkingLive +
        (state.liveText ? '<div class="body">' + renderMarkdown(state.liveText) + '</div>' : '') +
        '</div>'
      : '<div class="msg assistant"><div class="typing"><span></span><span></span><span></span></div></div>'
    : ''
`,
    `  // 流式内容单独用一个「活动气泡」，不走整体重建
  const typing = ''
`,
  )
  source = source.replace(
    `  el.messages.innerHTML = earlier + state.messages.map(messageHtml).join('') + typing`,
    `  el.messages.innerHTML = earlier + state.messages.map(messageHtml).join('') + typing
  if (state.running) paintLive()`,
  )
  notes.push('B1: renderMessages 去掉流式混排')
}

// 2) 新增活动气泡的渲染函数（直接改文本节点，60ms 节流）
if (!source.includes('function ensureLiveBubble')) {
  const block = `/** 取（或创建）流式活动气泡。 */
function ensureLiveBubble() {
  if (el.liveBubble && el.liveBubble.parentNode === el.messages) return el.liveBubble
  const node = document.createElement('div')
  node.className = 'msg assistant live'
  node.innerHTML =
    '<button class="thinking-toggle" hidden>▸ 思考</button>' +
    '<div class="thinking-body live" hidden></div>' +
    '<div class="body live-body"></div>'
  el.messages.appendChild(node)
  el.liveBubble = node
  return node
}

/** 把累积的流式文本画到活动气泡上（不重建整表）。 */
function paintLive() {
  const text = state.liveText || ''
  const thinking = state.liveThinking || ''
  if (!text && !thinking) return
  const node = ensureLiveBubble()
  const toggle = node.querySelector('.thinking-toggle')
  const thinkBody = node.querySelector('.thinking-body')
  const body = node.querySelector('.live-body')
  thinkBody.hidden = !thinking
  thinkBody.textContent = thinking
  toggle.hidden = !thinking
  toggle.textContent = (thinkBody.dataset.open === '1' ? '▾' : '▸') + ' 思考'
  body.textContent = text
  const nearBottom = el.messages.scrollHeight - el.messages.scrollTop - el.messages.clientHeight < 120
  if (nearBottom) el.messages.scrollTop = el.messages.scrollHeight
}

/** 流式增量节流：最多每 60ms 画一次。 */
function schedulePaintLive() {
  if (schedulePaintLive.timer) return
  schedulePaintLive.timer = setTimeout(() => {
    schedulePaintLive.timer = 0
    paintLive()
  }, 60)
}

/** 清掉活动气泡（生成结束或切换会话时）。 */
function clearLive() {
  if (el.liveBubble) {
    el.liveBubble.remove()
    el.liveBubble = null
  }
}

/** 生成结束后拉一次完整消息，保证与增量拼接的结果一致。 */
async function refreshPageOnce(sessionId) {
  try {
    const data = await api('page?sessionId=' + encodeURIComponent(sessionId) + '&max=60')
    if (!state.current || state.current.id !== sessionId) return
    state.records = data.records || []
    state.messages = buildMessages(state.records)
    state.hasMore = Boolean(data.hasMore)
    state.earliestSeq = state.records.length ? state.records[0].event.seq : 0
    renderMessages()
  } catch {
    // 忽略：下一次轮询/重连会补上
  }
}

`
  const anchor = '/** 向上翻页：取更早的一页并接在前面。 */'
  source = source.replace(anchor, block + anchor)
  notes.push('B2: paintLive/clearLive/refreshPageOnce')
}

// 3) SSE：增量只画活动气泡；完成时才整体渲染一次
source = source.replace(
  `    } else if (frame.type === 'assistant-stream') {
      const delta = extractDelta(frame.frame || frame)
      if (delta.text || delta.reasoning) {
        if (delta.text) state.liveText += delta.text
        if (delta.reasoning) state.liveThinking += delta.reasoning
        renderMessages()
      }
    }`,
  `    } else if (frame.type === 'assistant-stream') {
      const delta = extractDelta(frame.frame || frame)
      if (delta.text || delta.reasoning) {
        if (delta.text) state.liveText += delta.text
        if (delta.reasoning) state.liveThinking += delta.reasoning
        schedulePaintLive()
      }
    }`,
)

source = source.replace(
  `    } else if (frame.type === 'event') {
      if (frame.event && frame.event.type === 'assistant/message') {
        state.running = false
        state.liveText = ''
        state.liveThinking = ''
        renderSend()
      }`,
  `    } else if (frame.type === 'event') {
      if (frame.event && frame.event.type === 'assistant/message') {
        state.running = false
        state.liveText = ''
        state.liveThinking = ''
        clearLive()
        renderSend()
        // 完成后一次性对齐完整消息
        void refreshPageOnce(sessionId)`,
)
notes.push('B3: 增量走 paintLive，完成才整体渲染')

// 4) 连接健康标记 + 断线时清活动气泡
source = source.replace(
  `    if (frame.type === 'snapshot') {
      state.records = frame.records || []`,
  `    if (frame.type === 'snapshot') {
      state.sseLive = true
      state.records = frame.records || []`,
)
source = source.replace(
  `  source.onerror = () => {
    setConn(false)`,
  `  source.onerror = () => {
    state.sseLive = false
    setConn(false)`,
)
notes.push('C1: sseLive 标记')

// 5) 轮询：SSE 正常时退化为低频兜底
source = source.replace(
  `  const deadline = Date.now() + 5 * 60 * 1000
  while (Date.now() < deadline) {
    await sleep(1500)
    if (!state.current || state.current.id !== sessionId) return`,
  `  const deadline = Date.now() + 5 * 60 * 1000
  while (Date.now() < deadline) {
    // SSE 健康时只做低频兜底，避免每 1.5s 整页拉取 + 整表重绘
    await sleep(state.sseLive ? 4000 : 1500)
    if (!state.current || state.current.id !== sessionId) return
    if (!state.running) return`,
)
notes.push('C2: 轮询降频')

// 6) 打开会话/新建时清空活动气泡
source = source.replace(
  `  state.messages = []
  state.records = []`,
  `  state.messages = []
  state.records = []
  state.liveText = ''
  state.liveThinking = ''
  clearLive()`,
)

// 7) 思考区点击展开（活动气泡里那个）
source = source.replace(
  `el.messages.addEventListener('click', (event) => {`,
  `el.messages.addEventListener('click', (event) => {
  const liveToggle = event.target.closest && event.target.closest('.msg.live .thinking-toggle')
  if (liveToggle) {
    const body = liveToggle.parentNode.querySelector('.thinking-body')
    const open = body.dataset.open === '1'
    body.dataset.open = open ? '0' : '1'
    body.hidden = open
    liveToggle.textContent = (open ? '▸' : '▾') + ' 思考'
    return
  }
`,
)

// state 初始值
if (!source.includes('sseLive:')) {
  source = source.replace("  liveThinking: '',", "  liveThinking: '',\n  sseLive: false,")
}

writeFileSync(file, source)
console.log(notes.join('\n'))
