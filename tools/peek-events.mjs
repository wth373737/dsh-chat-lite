import { readEventsFromFile } from '../index.js'

const [file] = process.argv.slice(2)
if (!file) {
  console.error('用法: node tools/peek-events.mjs <session.v4.jsonl.zstd>')
  process.exit(1)
}

const events = await readEventsFromFile(file)
console.log('事件总数:', events.length)
const types = new Map()
for (const event of events) types.set(event.type, (types.get(event.type) || 0) + 1)
console.log('类型分布:', [...types.entries()].map(([k, v]) => k + '×' + v).join(', '))

for (const event of events) {
  if (event.type === 'tool/call' || event.type === 'tool/result') {
    console.log('---', event.type, '---')
    console.log(JSON.stringify(event.data).slice(0, 800))
  }
}
