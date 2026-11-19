/**
 * 办公文档文本提取（docx / pptx / xlsx），纯 Node 实现，无外部依赖。
 * 原理：Office 文档是 zip + XML，先解析 zip 中央目录，再用 inflateRaw 解压，
 * 最后从 XML 里抽文字。比让模型自己找工具稳定得多。
 */
import { inflateRawSync } from 'node:zlib'

/** 读 zip 里的全部条目（name → Buffer）。 */
export function unzipEntries(buffer) {
  const entries = new Map()
  let eocd = -1
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 66000; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return entries

  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)

  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')

    if (buffer.readUInt32LE(localOffset) === 0x04034b50) {
      const localNameLength = buffer.readUInt16LE(localOffset + 26)
      const localExtraLength = buffer.readUInt16LE(localOffset + 28)
      const dataStart = localOffset + 30 + localNameLength + localExtraLength
      const raw = buffer.subarray(dataStart, dataStart + compressedSize)
      try {
        entries.set(name, method === 0 ? raw : inflateRawSync(raw))
      } catch {
        // 跳过坏条目
      }
    }

    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

const decodeXmlText = (xml) =>
  xml
    .replace(/<w:p[ >]/g, '\n<w:p ')
    .replace(/<a:p>/g, '\n<a:p>')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim()

export function extractDocxText(buffer, maxChars = 12000) {
  const entries = unzipEntries(buffer)
  const xml = entries.get('word/document.xml')
  if (!xml) return ''
  const text = decodeXmlText(xml.toString('utf8'))
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

export function extractPptxText(buffer, maxChars = 12000) {
  const entries = unzipEntries(buffer)
  const slides = [...entries.keys()]
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]))
  const parts = []
  slides.forEach((name, index) => {
    const text = decodeXmlText(entries.get(name).toString('utf8'))
    if (text) parts.push('第 ' + (index + 1) + ' 页\n' + text)
  })
  const joined = parts.join('\n\n')
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined
}

export function extractXlsxText(buffer, maxChars = 12000) {
  const entries = unzipEntries(buffer)
  const parts = []
  const shared = entries.get('xl/sharedStrings.xml')
  if (shared) {
    const xml = shared.toString('utf8')
    const values = [...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((match) => match[1])
    if (values.length) parts.push('字符串表:\n' + values.map((value) => decodeXmlText(value)).join('\n'))
  }
  const sheets = [...entries.keys()].filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name)).sort()
  for (const name of sheets) {
    const text = decodeXmlText(entries.get(name).toString('utf8'))
    if (text) parts.push(name.replace('xl/worksheets/', '') + ':\n' + text)
  }
  const joined = parts.join('\n\n')
  return joined.length > maxChars ? joined.slice(0, maxChars) : joined
}

/** 按扩展名分派；不支持的类型返回空串。 */
export function extractOfficeText(name, buffer, maxChars = 12000) {
  const lower = String(name || '').toLowerCase()
  try {
    if (lower.endsWith('.docx')) return extractDocxText(buffer, maxChars)
    if (lower.endsWith('.pptx')) return extractPptxText(buffer, maxChars)
    if (lower.endsWith('.xlsx')) return extractXlsxText(buffer, maxChars)
  } catch {
    return ''
  }
  return ''
}
