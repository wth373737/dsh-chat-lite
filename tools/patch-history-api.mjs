import { readFileSync, writeFileSync } from 'node:fs'

const file = 'mobile.js'
let source = readFileSync(file, 'utf8')
const before = source

const actions = `
          // 历史库列表（默认最近 3 个月，滚动时用 before 游标继续取）
          if (action === 'history') {
            const limit = Math.min(100, Number(url.searchParams.get('limit') || 60))
            const beforeCursor = Number(url.searchParams.get('before') || 0)
            const all = url.searchParams.get('all') === '1'
            const rows = await readHistoryIndex(chatDir)
            const cutoff = all ? 0 : Date.now() - HISTORY_DEFAULT_MONTHS * 30 * 86400000
            let items = rows
              .map(toHistoryItem)
              .filter((item) => item.updatedAt >= cutoff)
            items.sort((a, b) => b.updatedAt - a.updatedAt)
            if (beforeCursor) items = items.filter((item) => item.updatedAt < beforeCursor)
            const page = items.slice(0, limit)
            return sendJson(res, 200, {
              ok: true,
              items: page,
              hasMore: items.length > page.length,
              total: rows.length,
              cutoff,
            })
          }

          // 历史会话正文（只读）
          if (action === 'history-item') {
            const id = url.searchParams.get('id') || ''
            const data = await readHistoryItem(chatDir, id)
            if (!data) return sendJson(res, 404, { ok: false, error: '找不到历史会话' })
            return sendJson(res, 200, {
              ok: true,
              id,
              title: (data.meta && data.meta.title) || '',
              messages: data.messages,
            })
          }

          // 搜索：scope=title 只查标题与首句；scope=full 扫全文分块
          if (action === 'search') {
            const query = String(url.searchParams.get('q') || '').trim()
            const scope = url.searchParams.get('scope') === 'full' ? 'full' : 'title'
            const limit = Math.min(60, Number(url.searchParams.get('limit') || 30))
            if (!query) return sendJson(res, 200, { ok: true, items: [], scope })
            const rows = await readHistoryIndex(chatDir)
            const byId = new Map(rows.map((row) => [String(row.id), row]))
            if (scope === 'title') {
              const needle = query.toLowerCase()
              const items = rows
                .filter((row) => String(row.title || row.first || '').toLowerCase().includes(needle))
                .map((row) => ({ ...toHistoryItem(row), snippet: String(row.first || '').slice(0, 120) }))
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .slice(0, limit)
              return sendJson(res, 200, { ok: true, items, scope })
            }
            const hits = await searchHistoryFull(chatDir, query, limit)
            const items = hits.map((hit) => {
              const row = byId.get(hit.id)
              return {
                id: hit.id,
                snippet: hit.snippet,
                title: row ? String(row.title || row.first || '未命名对话') : '未命名对话',
                updatedAt: row ? toHistoryItem(row).updatedAt : 0,
              }
            })
            return sendJson(res, 200, { ok: true, items, scope })
          }

`

if (!source.includes("action === 'history'")) {
  source = source.replace("          if (action === 'pair') {", actions + "          if (action === 'pair') {")
}

writeFileSync(file, source)
console.log('changed =', before !== source)
