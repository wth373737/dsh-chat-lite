import { readFileSync, writeFileSync } from 'node:fs'

const file = 'mobile.js'
let source = readFileSync(file, 'utf8')
const before = source

const oldBlock = `      } else if (event.type === 'tool/call') {
        out.push({ event: { type: event.type, seq: event.seq, time: event.time, data: { name: event.data && event.data.name } } })
      }`

const newBlock = `      } else if (event.type === 'tool/call') {
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
        const text = ((message.content || [])
          .filter((part) => part && part.type === 'text')
          .map((part) => part.text)
          .join('\\n') || '').slice(0, 1200)
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
      }`

if (!source.includes("event.type === 'tool/result'")) {
  if (!source.includes(oldBlock)) {
    console.log('未匹配到工具事件片段')
    process.exit(1)
  }
  source = source.replace(oldBlock, newBlock)
}

writeFileSync(file, source)
console.log('changed =', before !== source, ' hasResult =', source.includes("'tool/result'"))
