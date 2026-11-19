import { readFileSync, writeFileSync } from 'node:fs'

// ── 宿主：瘦身时保留工具参数与结果摘要 ────────────────────────
const mobileFile = 'mobile.js'
let mobile = readFileSync(mobileFile, 'utf8')
const notes = []

if (!mobile.includes("event.type === 'tool/result'")) {
  mobile = mobile.replace(
    `    } else if (event.type === 'tool/call') {
      out.push({ event: { type: event.type, seq: event.seq, time: event.time, data: { name: event.data && event.data.name } } })
    }`,
    `    } else if (event.type === 'tool/call') {
      out.push({
        event: {
          type: event.type,
          seq: event.seq,
          time: event.time,
          data: {
            name: event.data && event.data.name,
            callId: event.data && event.data.callId,
            arguments: String((event.data && event.data.arguments) || '').slice(0, 600),
          },
        },
      })
    } else if (event.type === 'tool/result') {
      const message = (event.data && event.data.message) || {}
      const text = ((message.content || []).filter((part) => part && part.type === 'text').map((part) => part.text).join('\\n') || '').slice(0, 1200)
      out.push({
        event: {
          type: event.type,
          seq: event.seq,
          time: event.time,
          data: {
            callId: (message.toolCallId || (message.source && message.source.callId)) || '',
            text,
            isError: Boolean(message.isError),
          },
        },
      })
    }`,
  )
  notes.push('host tool events')
}

writeFileSync(mobileFile, mobile)

// ── 前端：工具芯片可展开 ─────────────────────────────────────
const file = 'ui/app.js'
let source = readFileSync(file, 'utf8')

if (!source.includes("event.type === 'tool/result'")) {
  source = source.replace(
    `    } else if (event.type === 'tool/call') {
      const name = String((event.data && event.data.name) || 'tool')
      out.push({ role: 'tool', seq: event.seq, name })
    }`,
    `    } else if (event.type === 'tool/call') {
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
    }`,
  )
  notes.push('client tool events')
}

if (!source.includes('function toolSummary')) {
  source = source.replace(
    'function actionBtn(kind, label, index, disabled) {',
    `/** 从工具参数里挑一行最有信息量的摘要。 */
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

function actionBtn(kind, label, index, disabled) {`,
  )
  notes.push('toolSummary')
}

// 渲染：芯片 + 可展开详情
source = source.replace(
  `  if (message.role === 'tool') {
    const label = /web_search/.test(message.name)`,
  `  if (message.role === 'tool') {
    const expanded = state.expandedTools.has(index)
    const summary = toolSummary(message)
    const mark = message.isError ? ' ⚠' : message.result ? ' ✓' : ''
    const chip =
      '<button type="button" class="tool-chip' + (message.isError ? ' error' : '') + '" data-tool="' + index + '">' +
      (/web_search/.test(message.name)
        ? '🌐 联网搜索'
        : /web_fetch/.test(message.name)
          ? '🌐 读取网页'
          : '🔧 ' + escapeHtml(message.name)) +
      (summary ? ' · ' + escapeHtml(summary.slice(0, 60)) : '') + mark +
      '</button>'
    const detail = expanded
      ? '<pre class="tool-detail">' +
        escapeHtml((message.args ? message.args + '\\n\\n' : '') + (message.result || '（无结果）')) +
        '</pre>'
      : ''
    return '<div class="msg tool"><div class="tool-cell">' + chip + detail + '</div></div>'
  }

  if (false) {
    const label = /web_search/.test(message.name)`,
)

// 展开状态
if (!source.includes('expandedTools')) {
  source = source.replace("  searching: false,", "  searching: false,\n  expandedTools: new Set(),")
}

// 点击展开
if (!source.includes("closest('[data-tool]')")) {
  source = source.replace(
    "  const thinking = event.target.closest('[data-thinking]')",
    `  const toolChip = event.target.closest('[data-tool]')
  if (toolChip) {
    const index = Number(toolChip.dataset.tool)
    if (state.expandedTools.has(index)) state.expandedTools.delete(index)
    else state.expandedTools.add(index)
    renderMessages(true)
    return
  }
  const thinking = event.target.closest('[data-thinking]')`,
  )
}

writeFileSync(file, source)
console.log(notes.join('\n') || '(no changes)')
