// 端到端：上传 PDF → 抽文本 → 拼进正文发送 → 读回模型回答
// 用法: node tools/e2e-pdf.mjs <file.pdf>
import { readFile } from 'node:fs/promises'

const BASE = 'http://127.0.0.1:8787/chat-lite/m/api'
const headers = { 'content-type': 'application/json', 'x-chat-lite': '1' }

const file = process.argv[2]
if (!file) {
  console.error('用法: node tools/e2e-pdf.mjs <file.pdf>')
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

const created = await call('/new', {})
console.log('会话:', created.sessionId)

const bytes = await readFile(file)
const uploaded = await call('/upload-file', {
  sessionId: created.sessionId,
  name: file.split(/[\\/]/).pop(),
  data: bytes.toString('base64'),
})
console.log('textPreview 长度:', (uploaded.textPreview || '').length, ' pdfScanned:', uploaded.pdfScanned)

const prompt = [
  '这份课件讲了什么？用三句话概括。',
  '',
  '[附件 ' + file.split(/[\\/]/).pop() + ' 的文本内容]',
  '```',
  uploaded.textPreview || '(抽取失败)',
  '```',
].join('\n')

await call('/send', {
  sessionId: created.sessionId,
  text: prompt,
  files: [{ receiptId: uploaded.receiptId }],
})
console.log('已发送，等待回复…')

const deadline = Date.now() + 120000
while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 3000))
  const page = await call('/page?sessionId=' + encodeURIComponent(created.sessionId) + '&max=10')
  const assistants = page.records.filter((record) => record.event.type === 'assistant/message')
  if (assistants.length) {
    const last = assistants[assistants.length - 1].event.data.message.content
    const text = last.filter((part) => part.type === 'text').map((part) => part.text).join('')
    console.log('--- 模型回答 ---')
    console.log(text.slice(0, 600))
    process.exit(0)
  }
}
console.log('超时未拿到回复')
process.exit(1)
