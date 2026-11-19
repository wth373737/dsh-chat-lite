import { readFileSync, writeFileSync } from 'node:fs'

const file = 'ui/app.js'
let source = readFileSync(file, 'utf8')
const notes = []

// 抽屉刷新只取第一页历史，避免每次打开都往后翻
source = source.replace(
  "history = await api('history?limit=60' + (state.historyCursor ? '&before=' + state.historyCursor : ''))",
  "history = await api('history?limit=60')",
)

// 去掉自动推进游标的逻辑（改为手动「加载更多」）
source = source.replace(
  `  state.historyHasMore = Boolean(history.hasMore)
  const last = state.sessions[state.sessions.length - 1]
  state.historyCursor = last && last.kind === 'history' ? last.updatedAt : state.historyCursor
  renderList()`,
  `  state.historyHasMore = Boolean(history.hasMore)
  renderList()`,
)

// 列表底部「加载更多历史」
if (!source.includes('load-more-history')) {
  source = source.replace(
    `  el.list.innerHTML = html
}`,
    `  if (state.historyHasMore) {
    html += '<div class="load-earlier"><button type="button" id="load-more-history">加载更多历史</button></div>'
  }
  el.list.innerHTML = html
}

/** 继续取下一页历史库（按更新时间倒序）。 */
async function loadMoreHistory() {
  const rows = state.sessions.filter((item) => item.kind === 'history')
  const cursor = rows.length ? rows[rows.length - 1].updatedAt : state.historyCursor
  const button = $('load-more-history')
  if (button) button.disabled = true
  try {
    const data = await api('history?limit=60&before=' + encodeURIComponent(cursor))
    const liveIds = new Set(state.sessions.filter((item) => item.kind !== 'history').map((item) => item.id))
    const more = (data.items || [])
      .filter((item) => !liveIds.has(item.id))
      .filter((item) => !state.sessions.some((existing) => existing.id === item.id))
      .map((item) => ({ ...item, kind: 'history' }))
    state.sessions = state.sessions.concat(more)
    state.historyHasMore = Boolean(data.hasMore)
    renderList()
  } catch (error) {
    toast('加载历史失败：' + error.message)
  }
}`,
  )
  notes.push('load more history')
}

// 事件绑定
source = source.replace(
  `  const row = event.target.closest('.row')`,
  `  if (event.target.closest('#load-more-history')) {
    loadMoreHistory()
    return
  }
  const row = event.target.closest('.row')`,
)

writeFileSync(file, source)
console.log(notes.join('\n') || '(no changes)')
