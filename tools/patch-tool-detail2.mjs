import { readFileSync, writeFileSync } from 'node:fs'

const file = 'ui/app.js'
let source = readFileSync(file, 'utf8')
const notes = []
const before = source

// 1) buildMessages：保留参数并合并结果
if (!source.includes("item.callId === callId")) {
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
  notes.push('tool events')
}

// 2) toolSummary
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

// 3) expandedTools 状态
if (!source.includes('expandedTools')) {
  source = source.replace('  searching: false,', '  searching: false,\n  expandedTools: new Set(),')
  notes.push('expandedTools')
}

// 4) 点击展开（插在 thinking 之前）
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
  notes.push('click toggle')
}

writeFileSync(file, source)
console.log(notes.join('\n') || '(no changes)', '\nchanged =', before !== source)
