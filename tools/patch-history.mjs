import { readFileSync, writeFileSync } from 'node:fs'

const file = 'mobile.js'
let source = readFileSync(file, 'utf8')
const before = source

const helpers = `
// ── 历史库（.chat-lite）查询 ─────────────────────────────────────────────
const HISTORY_DEFAULT_MONTHS = 3
const SEARCH_CHUNK_LIMIT = 40

const historyDir = (chatDir) => path.join(chatDir, '.chat-lite')

/** 读取 index.jsonl（每行一条会话摘要）。 */
async function readHistoryIndex(chatDir) {
  const file = path.join(historyDir(chatDir), 'index.jsonl')
  const raw = await readFile(file, 'utf8')
  const rows = []
  for (const line of raw.split('\\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      rows.push(JSON.parse(text))
    } catch {
      // 跳过坏行
    }
  }
  return rows
}

/** 把索引行转成移动端需要的形状。 */
function toHistoryItem(row) {
  return {
    id: String(row.id),
    title: String(row.title || row.first || '未命名对话').slice(0, 80),
    updatedAt: Date.parse(row.updated || row.inserted || 0) || 0,
    messages: Number(row.messages || 0),
    source: row.source || 'import',
    preview: String(row.first || '').slice(0, 120),
  }
}

/** 历史会话正文。 */
async function readHistoryItem(chatDir, id) {
  const safe = String(id || '').replace(/[^\\w.-]/g, '')
  if (!safe) return null
  const file = path.join(historyDir(chatDir), 'sessions', safe + '.jsonl')
  const raw = await readFile(file, 'utf8')
  const messages = []
  let meta = null
  for (const line of raw.split('\\n')) {
    const text = line.trim()
    if (!text) continue
    let row
    try {
      row = JSON.parse(text)
    } catch {
      continue
    }
    if (row.kind === 'meta') {
      meta = row
      continue
    }
    if (row.role === 'user' || row.role === 'assistant') {
      messages.push({
        role: row.role,
        ts: Date.parse(row.ts || 0) || 0,
        text: String(row.text || ''),
        thinking: row.thinking ? String(row.thinking) : '',
        files: Array.isArray(row.files) ? row.files : [],
      })
    }
  }
  return { meta, messages }
}

/** 全文搜索：按分块从新到旧扫描，命中即收集，达到上限提前结束。 */
async function searchHistoryFull(chatDir, query, limit) {
  const dir = path.join(historyDir(chatDir), 'search')
  let names = []
  try {
    names = (await readdir(dir)).filter((name) => /^c\\d+\\.jsonl$/.test(name)).sort().reverse()
  } catch {
    names = []
  }
  if (names.length > SEARCH_CHUNK_LIMIT) names = names.slice(0, SEARCH_CHUNK_LIMIT)

  const needle = query.toLowerCase()
  const hits = []
  const seen = new Set()

  const scan = async (fileName) => {
    let raw
    try {
      raw = await readFile(path.join(dir, fileName), 'utf8')
    } catch {
      return
    }
    for (const line of raw.split('\\n')) {
      const text = line.trim()
      if (!text) continue
      let row
      try {
        row = JSON.parse(text)
      } catch {
        continue
      }
      const haystack = String(row.t || '')
      const at = haystack.toLowerCase().indexOf(needle)
      if (at < 0) continue
      const id = String(row.id || '')
      if (seen.has(id)) continue
      seen.add(id)
      const start = Math.max(0, at - 40)
      const snippet = haystack.slice(start, Math.min(haystack.length, at + needle.length + 80)).replace(/\\s+/g, ' ')
      hits.push({ id, snippet })
      if (hits.length >= limit) return
    }
  }

  for (const name of names) {
    await scan(name)
    if (hits.length >= limit) break
  }
  if (hits.length < limit) {
    try {
      await scan('live.jsonl')
    } catch {
      // 忽略
    }
  }
  return hits
}

`

if (!source.includes('async function readHistoryIndex')) {
  source = source.replace('async function sendFile(res, file) {', helpers + 'async function sendFile(res, file) {')
  source = source.replace("import { readFile, writeFile, mkdir } from 'node:fs/promises'", "import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'")
}

writeFileSync(file, source)
console.log('changed =', before !== source)
console.log('helpers =', source.includes('async function readHistoryIndex'), 'readdir =', source.includes(', readdir }'))
