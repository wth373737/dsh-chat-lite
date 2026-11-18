// 从 DeepSeek 导出包（zip）生成闲聊历史库
//
// 产物（写到 --out 指定的目录，也就是闲聊目录下的 .chat-lite/）：
//   index.jsonl              每行一条会话索引（id/title/updated/turns/chars/thinking/files/first）
//   sessions/<id>.jsonl      单条会话正文：第一行 meta，其后一行一条可见消息
//   files/<id>/<filename>    附件原件
//   search/cNNNN.jsonl       全文搜索分块，每行 {id, t}，t ≤ 2000 字符
//   search/manifest.json     {"chunks": N}
//
// 设计：
//   - 索引 1.4MB，客户端分页读取；正文按需读，避免一次性载入几百 MB
//   - 全文分块按「更新时间倒序」生成：常见查询在前几块命中，不必扫完整个语料
//   - 每行 ≤ 2000 字符：单行过大会让读取接口抛错（踩过）
//
// 用法：
//   node tools/build-history.mjs --zip <导出包.zip> --out <chat>/.chat-lite [--no-files] [--limit N]
//
// 典型：
//   node tools/build-history.mjs --zip ~/Downloads/deepseek_data-2026-11-17.zip --out I:\agent\chat\.chat-lite
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

// ---------------------------------------------------------------- ZIP
function readZipEntries(zipPath) {
  const buf = fs.readFileSync(zipPath)
  let eocd = -1
  const stop = Math.max(0, buf.length - 0x10000 - 22)
  for (let i = buf.length - 22; i >= stop; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('找不到 zip EOCD')
  const entryCount = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < entryCount; i++) {
    if (buf.readUInt32LE(offset) !== 0x02014b50) throw new Error('中央目录签名不符')
    const method = buf.readUInt16LE(offset + 10)
    const compressedSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.toString('utf8', offset + 46, offset + 46 + nameLen)
    entries.push({ name, method, compressedSize, localOffset })
    offset += 46 + nameLen + extraLen + commentLen
  }
  return { buf, entries }
}

function readZipFile(zip, entry) {
  const lo = entry.localOffset
  if (zip.buf.readUInt32LE(lo) !== 0x04034b50) throw new Error('本地头签名不符: ' + entry.name)
  const nameLen = zip.buf.readUInt16LE(lo + 26)
  const extraLen = zip.buf.readUInt16LE(lo + 28)
  const dataStart = lo + 30 + nameLen + extraLen
  const raw = zip.buf.subarray(dataStart, dataStart + entry.compressedSize)
  if (entry.method === 0) return raw
  if (entry.method === 8) return zlib.inflateRawSync(raw)
  throw new Error('不支持的压缩方式 ' + entry.method)
}

// ---------------------------------------------------------------- 索引字段
const FRAGMENT_TEXT = new Set(['REQUEST', 'RESPONSE', 'THINK'])

/** 按 current_message_id + 最大 id 子节点，取「当前可见分支」。 */
function visiblePath(session) {
  const list = session.messages || []
  const byId = new Map()
  for (const message of list) byId.set(message.id, message)
  const pickChild = (parentId, preferredId) => {
    const kids = list.filter((m) => (m.parent_id ?? null) === parentId)
    if (kids.length === 0) return undefined
    if (preferredId !== undefined && kids.some((k) => k.id === preferredId)) {
      return kids.find((k) => k.id === preferredId)
    }
    return kids.reduce((a, b) => (b.id > a.id ? b : a))
  }
  const current = session.current_message_id ?? null
  if (current !== null && byId.has(current)) {
    const chain = []
    let node = byId.get(current)
    while (node) {
      chain.push(node)
      node = node.parent_id === null || node.parent_id === undefined ? undefined : byId.get(node.parent_id)
    }
    return chain.reverse()
  }
  const chain = []
  let node = pickChild(null)
  while (node) {
    chain.push(node)
    node = pickChild(node.id)
  }
  return chain
}

function textOf(message, type) {
  const parts = []
  for (const fragment of message.fragments || []) {
    if (fragment.type === type && typeof fragment.content === 'string') parts.push(fragment.content)
  }
  return parts.join('\n')
}

/** 取出该消息的附件（export_path 的 basename 就是 files/<sid>/ 下的文件名）。 */
function filesOf(message) {
  const out = []
  for (const fragment of message.fragments || []) {
    if (fragment.type !== 'FILE') continue
    for (const file of fragment.files || []) {
      const base = String(file.export_path || '').split('/').pop() || file.id
      out.push({
        name: base,
        label: file.file_name || base,
        image: file.is_image === true,
        w: file.width || 0,
        h: file.height || 0,
        size: file.file_size || 0,
      })
    }
  }
  return out
}

/** 展平成「一行一条消息」的 JSONL：客户端按行分页读即可，不用处理消息树。 */
function flattenToJsonl(session) {
  const lines = [
    JSON.stringify({
      kind: 'meta',
      id: session.id,
      title: session.title || '',
      inserted: session.inserted_at,
      updated: session.updated_at,
    }),
  ]
  for (const message of visiblePath(session)) {
    if (message.role === 'USER') {
      const text = textOf(message, 'REQUEST')
      const files = filesOf(message)
      if (!text.trim() && files.length === 0) continue
      lines.push(JSON.stringify({ role: 'user', ts: message.inserted_at, text, files }))
    } else if (message.role === 'ASSISTANT') {
      const thinking = textOf(message, 'THINK')
      const text = textOf(message, 'RESPONSE') || textOf(message, 'TEMPLATE_RESPONSE')
      const files = filesOf(message)
      if (!thinking.trim() && !text.trim() && files.length === 0) continue
      lines.push(JSON.stringify({ role: 'assistant', ts: message.inserted_at, thinking, text, files }))
    }
  }
  return lines.join('\n') + '\n'
}

function summarize(session) {
  const messages = session.messages || []
  let turns = 0
  let thinking = false
  let firstUser = ''
  let chars = 0
  let files = 0
  for (const message of messages) {
    if (message.role === 'USER') turns++
    for (const fragment of message.fragments || []) {
      if (FRAGMENT_TEXT.has(fragment.type) && typeof fragment.content === 'string') {
        chars += fragment.content.length
        if (fragment.type === 'REQUEST' && !firstUser) firstUser = fragment.content.slice(0, 160)
        if (fragment.type === 'THINK' && fragment.content.trim()) thinking = true
      }
      if (fragment.type === 'FILE') files += (fragment.files || []).length
    }
  }
  return { turns, thinking, firstUser, chars, files }
}

// ---------------------------------------------------------------- 主流程
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const index = argv.indexOf('--' + name)
  return index >= 0 && argv[index + 1] !== undefined ? argv[index + 1] : fallback
}
const zipPath = arg('zip')
const outDir = arg('out')
const withFiles = !argv.includes('--no-files')
const limit = Number(arg('limit', '0'))
if (!zipPath || !outDir) {
  console.error('用法: node build-history.mjs --zip <zip> --out <dir> [--no-files] [--limit N]')
  process.exit(1)
}

const zip = readZipEntries(zipPath)
const sessionEntries = zip.entries.filter((e) => /^chat_sessions\/[^/]+\.json$/.test(e.name))
const fileEntries = zip.entries.filter((e) => /^chat_sessions\/[^/]+_files\//.test(e.name))

fs.mkdirSync(path.join(outDir, 'sessions'), { recursive: true })
fs.mkdirSync(path.join(outDir, 'search'), { recursive: true })
if (withFiles) fs.mkdirSync(path.join(outDir, 'files'), { recursive: true })

// 全文搜索分块：每块约 1MB，客户端按需顺序读取（67M 字符不可能一次载入）
const SEARCH_CHUNK_CHARS = 300000
let searchBuffer = []
let searchBufferChars = 0
let searchChunkIndex = 0
let searchChunkCount = 0
function flushSearchChunk() {
  if (searchBuffer.length === 0) return
  const name = 'c' + String(searchChunkIndex++).padStart(4, '0') + '.jsonl'
  fs.writeFileSync(path.join(outDir, 'search', name), searchBuffer.join('\n') + '\n')
  searchChunkCount++
  searchBuffer = []
  searchBufferChars = 0
}

const indexLines = []
const sessionTexts = []
let done = 0
let count = 0
for (const entry of sessionEntries) {
  if (limit > 0 && done >= limit) break
  const session = JSON.parse(readZipFile(zip, entry).toString('utf8'))
  const id = session.id || path.basename(entry.name, '.json')
  const s = summarize(session)
  const jsonl = flattenToJsonl(session)
  fs.writeFileSync(path.join(outDir, 'sessions', id + '.jsonl'), jsonl)

  // 全文索引用「去掉 JSON 包装后的纯文本」，切成 ≤2000 字符的小片段逐行存放。
  // 单行过大（一条会话可达 27 万字符）会让读取接口抛错，所以必须切片。
  const plain = jsonl
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const row = JSON.parse(line)
      if (row.kind === 'meta') return ''
      return (row.thinking ? row.thinking + '\n' : '') + (row.text || '')
    })
    .filter(Boolean)
    .join('\n')
  sessionTexts.push({ id, updated: session.updated_at || '', plain })

  indexLines.push(
    JSON.stringify({
      id,
      title: session.title || '',
      inserted: session.inserted_at,
      updated: session.updated_at,
      current: session.current_message_id ?? null,
      messages: (session.messages || []).length,
      turns: s.turns,
      chars: s.chars,
      thinking: s.thinking,
      files: s.files,
      first: s.firstUser,
    }),
  )
  done++
  count += (session.messages || []).length
}

// 最近优先：按更新时间倒序切块，常见查询在前几块就能命中，不必扫完整个语料
sessionTexts.sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
for (const item of sessionTexts) {
  for (let at = 0; at < item.plain.length; at += 1500) {
    const record = JSON.stringify({ id: item.id, t: item.plain.slice(at, at + 2000) })
    searchBuffer.push(record)
    searchBufferChars += record.length
    if (searchBufferChars >= SEARCH_CHUNK_CHARS) flushSearchChunk()
  }
}
flushSearchChunk()
fs.writeFileSync(path.join(outDir, 'search', 'manifest.json'), JSON.stringify({ chunks: searchChunkCount }) + '\n')

fs.writeFileSync(path.join(outDir, 'index.jsonl'), indexLines.join('\n') + '\n')

let fileCount = 0
if (withFiles) {
  for (const entry of fileEntries) {
    const match = /^chat_sessions\/([^/]+)_files\/(.+)$/.exec(entry.name)
    if (!match) continue
    const dir = path.join(outDir, 'files', match[1])
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, match[2]), readZipFile(zip, entry))
    fileCount++
  }
}

const indexSize = fs.statSync(path.join(outDir, 'index.jsonl')).size
console.log('会话: ' + done + ' 条, 消息: ' + count + ' 条')
console.log('索引: ' + indexLines.length + ' 行, ' + Math.round(indexSize / 1024) + ' KB')
console.log('全文分块: ' + searchChunkCount + ' 个（每块约 1MB）')
console.log('附件: ' + fileCount + ' 个' + (withFiles ? '' : '（已跳过）'))
console.log('输出: ' + outDir)
