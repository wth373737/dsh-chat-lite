import { readFileSync, writeFileSync } from 'node:fs'

const file = 'ui/app.js'
let source = readFileSync(file, 'utf8')
const before = source

// 发送前处理文件：文本类内联到正文，二进制保留收据
source = source.replace(
  `    const fileReceipts = []
    for (const item of state.pendingFiles) {
      const uploaded = await api('upload-file', {
        method: 'POST',
        body: { sessionId: id, name: item.name, data: item.data },
      })
      fileReceipts.push({ receiptId: uploaded.receiptId })
    }
    const files = fileReceipts`,
  `    // 文件处理：文本类直接把内容附在正文里（模型真能读到）；
    // 二进制仍作为附件上传，但只记录引用。
    const fileReceipts = []
    let inlineText = ''
    for (const item of state.pendingFiles) {
      const text = decodeTextFile(item.data, item.name)
      if (text !== null) {
        inlineText += '\\n\\n[附件 ' + item.name + ']\\n\`\`\`\\n' + text + '\\n\`\`\`'
        continue
      }
      const uploaded = await api('upload-file', {
        method: 'POST',
        body: { sessionId: id, name: item.name, data: item.data },
      })
      fileReceipts.push({ receiptId: uploaded.receiptId })
    }
    const files = fileReceipts
    const outgoing = text + inlineText`,
)

// 用 outgoing 作为实际发送文本
source = source.replace(
  `    await api('send', { method: 'POST', body: { sessionId: id, text, images, files } })`,
  `    await api('send', { method: 'POST', body: { sessionId: id, text: outgoing, images, files } })`,
)

// 乐观显示也用 outgoing
source = source.replace(
  `    state.messages = state.messages.concat([{
      role: 'user',
      text,
      images: state.pendingImages.map((item) => ({ localUrl: item.dataUrl })),
      local: true,
    }])`,
  `    state.messages = state.messages.concat([{
      role: 'user',
      text: outgoing,
      images: state.pendingImages.map((item) => ({ localUrl: item.dataUrl })),
      files: state.pendingFiles.map((item) => ({ name: item.name })),
      local: true,
    }])`,
)

// decodeTextFile 工具函数
if (!source.includes('function decodeTextFile')) {
  source = source.replace(
    "function readAsDataUrl(file) {",
    `/** 尝试把 base64 内容按 UTF-8 文本解码；二进制或过大则返回 null。 */
function decodeTextFile(base64, name) {
  const TEXT_EXT = /\\.(txt|md|markdown|json|jsonl|csv|tsv|log|js|mjs|cjs|ts|tsx|jsx|py|java|c|h|cpp|cs|go|rs|rb|php|sh|ps1|html|htm|css|scss|xml|yml|yaml|ini|toml|sql)$/i
  if (!TEXT_EXT.test(String(name || ''))) return null
  try {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
    if (bytes.length > 200 * 1024) return null
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return text.replace(/\\u0000/g, '').slice(0, 60000)
  } catch {
    return null
  }
}

function readAsDataUrl(file) {`,
  )
}

writeFileSync(file, source)
console.log('changed =', before !== source)
