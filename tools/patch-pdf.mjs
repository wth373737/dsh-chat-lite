import { readFileSync, writeFileSync } from 'node:fs'

const file = 'mobile.js'
let source = readFileSync(file, 'utf8')
const notes = []

// 1) 加入 PDF 提取器（模块级）
if (!source.includes('function extractPdfText')) {
  const block = `
/** 极简 PDF 文本提取：解压 FlateDecode 流，按定位操作符分段抽取文本。 */
function extractPdfText(buffer, maxChars) {
  const streams = []
  let index = 0
  while ((index = buffer.indexOf('stream', index)) !== -1) {
    let start = index + 6
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2
    else if (buffer[start] === 0x0a || buffer[start] === 0x0d) start += 1
    const end = buffer.indexOf('endstream', start)
    if (end === -1) break
    const chunk = buffer.subarray(start, end)
    let decoded = null
    try {
      decoded = inflateSync(chunk).toString('latin1')
    } catch {
      try {
        decoded = inflateRawSync(chunk).toString('latin1')
      } catch {
        decoded = null
      }
    }
    if (decoded) streams.push(decoded)
    index = end + 9
  }

  const pieces = []
  for (const content of streams) {
    const segments = content.split(/\\bT[dDm]\\b|\\bT\\*\\b|\\bET\\b|\\bBT\\b/)
    for (const segment of segments) {
      const line = []
      for (const match of segment.matchAll(/\\(((?:\\\\.|[^\\\\()])*)\\)/g)) {
        line.push(unescapePdfString(match[1]))
      }
      for (const match of segment.matchAll(/<([0-9A-Fa-f\\s]{4,})>/g)) {
        const hex = match[1].replace(/\\s+/g, '')
        if (hex.length % 2 !== 0) continue
        let decoded = ''
        for (let i = 0; i < hex.length; i += 2) decoded += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16))
        if (/[ -~]/.test(decoded)) line.push(decoded)
      }
      const text = line.join('').replace(/\\u0000/g, '').trim()
      if (text) pieces.push(text)
    }
  }

  const text = pieces
    .join('\\n')
    .replace(/\\b[a-z]{2}-[A-Z]{2}\\b/g, ' ')
    .replace(/[ \\t]{2,}/g, ' ')
    .replace(/\\n{3,}/g, '\\n\\n')
    .trim()
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

/** 反解 PDF 字符串里的转义序列。 */
function unescapePdfString(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (ch !== '\\\\') {
      out += ch
      continue
    }
    const next = raw[i + 1]
    i += 1
    if (next === 'n') out += '\\n'
    else if (next === 'r') out += '\\r'
    else if (next === 't') out += '\\t'
    else if (next === '(' || next === ')' || next === '\\\\') out += next
    else if (/[0-7]/.test(next || '')) {
      let oct = next
      while (oct.length < 3 && /[0-7]/.test(raw[i + 1] || '')) {
        oct += raw[i + 1]
        i += 1
      }
      out += String.fromCharCode(parseInt(oct, 8))
    } else out += next || ''
  }
  return out
}

`
  source = source.replace('async function sendFile(res, file) {', block + 'async function sendFile(res, file) {')
  source = source.replace("import { statSync } from 'node:fs'", "import { statSync } from 'node:fs'\nimport { inflateSync, inflateRawSync } from 'node:zlib'")
  notes.push('pdf extractor')
}

// 2) 上传时对 PDF 抽文本
if (!source.includes('textPreview')) {
  source = source.replace(
    "            const value = await uploads.uploadStream({",
    `            // PDF：顺手抽出文本，正文里直接给模型看
            let textPreview = ''
            if (/\\.pdf$/i.test(String(body.name))) {
              try {
                textPreview = extractPdfText(bytes, 12000)
              } catch {
                textPreview = ''
              }
            }
            const value = await uploads.uploadStream({`,
  )
  source = source.replace(
    "            return sendJson(res, 200, { ok: true, receiptId: value.receiptId, file: value.file, savedPath })",
    "            return sendJson(res, 200, { ok: true, receiptId: value.receiptId, file: value.file, savedPath, textPreview })",
  )
  notes.push('upload: pdf preview')
}

writeFileSync(file, source)
console.log(notes.join('\n') || '(no changes)')
