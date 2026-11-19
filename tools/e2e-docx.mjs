// 端到端：上传 docx → 让模型自己用办公文档工具读取 → 看是否答出内容
// 用法: node tools/e2e-docx.mjs <file.docx>
import { readFile } from 'node:fs/promises'

const BASE = 'http://127.0.0.1:8787/chat-lite/m/api'
const headers = { 'content-type': 'application/json', 'x-chat-lite': '1' }

const file = process.argv[2]
if (!file) {
  console.error('用法: node tools/e2e-docx.mjs <file.docx>')
  process.exit(1)
}

const call = async (path, body) => {
  const response = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await response.json()
  if (!json.ok) throw new Error(path + ' → ' + JSON.stringify(json).slice(0, 200))
  return json
}

const name = file.split(/[\\/]/).pop()
const created = await call('/new', {})
console.log('会话:', created.sessionId)

const bytes = await readFile(file)
const uploaded = await call('/upload-file', {
  sessionId: created.sessionId,
  name,
  data: bytes.toString('base64'),
})
console.log('已上传:', JSON.stringify(uploaded.file), ' textPreview:', (uploaded.textPreview || '').length)

await call('/send', {
  sessionId: created.sessionId,
  text: '这个文档里写了什么？把要点原样告诉我。',
  files: [{ receiptId: uploaded.receiptId }],
})
console.log('已发送，等待…')

const deadline = Date.now() + 180000
let lastCount = 0
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 4000))
  const page = await call('/page?sessionId=' + encodeURIComponent(created.sessionId) + '&max=20')
  const tools = page.records.filter((record) => record.event.type === 'tool/call')
  if (tools.length !== lastCount) {
    lastCount = tools.length
    for (const tool of tools) console.log('  工具:', tool.event.data.name, String(tool.event.data.arguments || '').slice(0, 120))
  }
  const assistants = page.records.filter((record) => record.event.type === 'assistant/message')
  if (assistants.length) {
    const content = assistants[assistants.length - 1].event.data.message.content
    const text = content.filter((part) => part.type === 'text').map((part) => part.text).join('')
    if (text.trim()) {
      console.log('--- 模型回答 ---')
      console.log(text.slice(0, 800))
      process.exit(0)
    }
  }
}
console.log('超时')
process.exit(1)
