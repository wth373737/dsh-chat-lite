import { readFileSync, writeFileSync } from 'node:fs'

// ── 1) index.html：抽屉里加搜索 tab ────────────────────────────
const htmlFile = 'ui/index.html'
let html = readFileSync(htmlFile, 'utf8')
if (!html.includes('search-tabs')) {
  html = html.replace(
    '  <div id="list" class="list"></div>',
    `  <div id="search-tabs" class="search-tabs" hidden>
    <button type="button" data-scope="title" class="active">标题</button>
    <button type="button" data-scope="full">全文</button>
  </div>
  <div id="list" class="list"></div>`,
  )
  writeFileSync(htmlFile, html)
  console.log('html: tabs added')
}

// ── 2) app.js ─────────────────────────────────────────────────
const file = 'ui/app.js'
let source = readFileSync(file, 'utf8')
const notes = []

// 2a) el 增加 searchTabs
if (!source.includes("searchTabs: $('search-tabs')")) {
  source = source.replace(
    "  search: $('search'),",
    "  search: $('search'),\n  searchTabs: $('search-tabs'),",
  )
  notes.push('el.searchTabs')
}

// 2b) state 增加 scope
if (!source.includes("scope: 'title'")) {
  source = source.replace(
    '  readOnly: false,        // 历史记录只读',
    "  readOnly: false,        // 历史记录只读\n  scope: 'title',         // 搜索范围：title | full",
  )
  notes.push('state.scope')
}

// 2c) 搜索函数（插在“会话”分区之前）
if (!source.includes('async function runSearch')) {
  const block = `// ── 搜索（标题 / 全文）────────────────────────────────────────
let searchTimer = null
let searchSeq = 0

function renderSearchResults(items, query) {
  if (!items.length) {
    el.list.innerHTML = '<div class="empty-list">没有匹配「' + escapeHtml(query) + '」</div>'
    return
  }
  el.list.innerHTML = items
    .map((item) => {
      const time = item.updatedAt ? timeLabel(item.updatedAt) : ''
      const snippet = item.snippet
        ? '<div class="row-snippet">' + escapeHtml(item.snippet) + '</div>'
        : ''
      return (
        '<div class="row" data-id="' + escapeHtml(item.id) + '">' +
        '<div class="row-title"><div>' + escapeHtml(item.title || '未命名对话') + '</div>' + snippet + '</div>' +
        '<div class="row-time">' + time + '</div>' +
        '</div>'
      )
    })
    .join('')
}

async function runSearch(scope) {
  const query = el.search.value.trim()
  if (!query) {
    el.searchTabs.hidden = true
    state.searching = false
    renderList()
    return
  }
  state.searching = true
  el.searchTabs.hidden = false
  const seq = ++searchSeq
  el.list.innerHTML = '<div class="empty-list">搜索中…</div>'
  try {
    const data = await api('search?q=' + encodeURIComponent(query) + '&scope=' + scope + '&limit=40')
    if (seq !== searchSeq) return
    renderSearchResults(data.items || [], query)
  } catch (error) {
    if (seq !== searchSeq) return
    el.list.innerHTML = '<div class="empty-list">搜索失败：' + escapeHtml(error.message) + '</div>'
  }
}

`
  source = source.replace('// ── 会话 ─', block + '// ── 会话 ─')
  notes.push('runSearch')
}

// 2d) 搜索框输入改为走搜索（防抖）；清空则回到列表
source = source.replace(
  "el.search.addEventListener('input', renderList)",
  `el.search.addEventListener('input', () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(() => runSearch(state.scope), 260)
})
el.searchTabs.addEventListener('click', (event) => {
  const button = event.target.closest('[data-scope]')
  if (!button) return
  state.scope = button.dataset.scope
  for (const item of el.searchTabs.querySelectorAll('button')) {
    item.classList.toggle('active', item === button)
  }
  runSearch(state.scope)
})`,
)

// 2e) renderList 时不覆盖搜索结果
source = source.replace(
  `function renderList() {
  const query = el.search.value.trim()`,
  `function renderList() {
  if (state.searching) return
  const query = el.search.value.trim()`,
)

// 2f) state.searching 初值
if (!source.includes('searching: false')) {
  source = source.replace("  scope: 'title',         // 搜索范围：title | full", "  scope: 'title',         // 搜索范围：title | full\n  searching: false,")
}

writeFileSync(file, source)
console.log(notes.join('\n') || '(no changes)')
