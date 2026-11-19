/**
 * PDF 文本提取（改进版）：按定位操作符分段，段内拼接不加空格，去掉语言标记。
 * 用法: node tools/pdf-probe.mjs <file.pdf> [maxChars]
 */
import { readFile } from 'node:fs/promises'
import { inflateSync, inflateRawSync } from 'node:zlib'

function unescapePdfString(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = raw[i + 1]
    i += 1
    if (next === 'n') out += '\n'
    else if (next === 'r') out += '\r'
    else if (next === 't') out += '\t'
    else if (next === 'b') out += '\b'
    else if (next === 'f') out += '\f'
    else if (next === '(' || next === ')' || next === '\\') out += next
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

/** 从一个内容流里抽文字：段内直接拼接，段落之间换行。 */
function textFromContentStream(content) {
  // 按“定位/换行”类操作符切段
  const segments = content.split(/\bT[dDm]\b|\bT\*\b|\bET\b|\bBT\b/)
  const lines = []
  for (const segment of segments) {
    const pieces = []
    const paren = /\(((?:\\.|[^\\()])*)\)/g
    let match
    while ((match = paren.exec(segment)) !== null) pieces.push(unescapePdfString(match[1]))
    const hex = /<([0-9A-Fa-f\s]{4,})>/g
    while ((match = hex.exec(segment)) !== null) {
      const hexText = match[1].replace(/\s+/g, '')
      if (hexText.length % 2 !== 0) continue
      let decoded = ''
      for (let i = 0; i < hexText.length; i += 2) decoded += String.fromCharCode(parseInt(hexText.slice(i, i + 2), 16))
      if (/[ -~]/.test(decoded)) pieces.push(decoded)
    }
    const line = pieces.join('').replace(/\u0000/g, '').trim()
    if (line) lines.push(line)
  }
  return lines.join('\n')
}

async function extractPdfText(bytes, maxChars = 20000) {
  const streams = []
  let index = 0
  const buffer = Buffer.from(bytes)
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

  const text = streams
    .map(textFromContentStream)
    .join('\n')
    .replace(/\b[a-z]{2}-[A-Z]{2}\b/g, ' ') // 去掉 en-US / en-MY 这类标记
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  return text.length > maxChars ? text.slice(0, maxChars) : text
}

const file = process.argv[2]
const maxChars = Number(process.argv[3] || 1500)
if (!file) {
  console.error('用法: node tools/pdf-probe.mjs <file.pdf> [maxChars]')
  process.exit(1)
}

const text = await extractPdfText(await readFile(file), Number.MAX_SAFE_INTEGER)
console.log('提取字符数:', text.length)
console.log('--- 前 ' + maxChars + ' 字 ---')
console.log(text.slice(0, maxChars))
