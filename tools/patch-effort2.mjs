import { readFileSync, writeFileSync } from 'node:fs'

// ── 宿主：清理其它设备 ────────────────────────────────────────
const mobileFile = 'mobile.js'
let mobile = readFileSync(mobileFile, 'utf8')
const notes = []

if (!mobile.includes("action === 'prune-devices'")) {
  mobile = mobile.replace(
    "          if (action === 'bootstrap') {",
    `          // 只保留当前这台设备，清掉其余（测试遗留设备用）
          if (action === 'prune-devices') {
            const state = await auth.load()
            const before = (state.devices || []).length
            state.devices = (state.devices || []).filter((item) => item.id === device.id)
            await auth.save()
            return sendJson(res, 200, { ok: true, removed: before - state.devices.length, devices: state.devices.length })
          }

          if (action === 'bootstrap') {`,
  )
  notes.push('host: prune-devices')
}

writeFileSync(mobileFile, mobile)

// ── 前端：新会话/分叉带档位；设置页折叠地址、清理设备 ──────────────
const file = 'ui/app.js'
let source = readFileSync(file, 'utf8')

source = source.replace(
  "  const created = await api('new', { method: 'POST', body: {} })",
  "  const created = await api('new', { method: 'POST', body: { effort: state.effort } })",
)
source = source.replace(
  "    const created = await api('new', { method: 'POST', body: {} })\n    await loadList()",
  "    const created = await api('new', { method: 'POST', body: { effort: state.effort } })\n    await loadList()",
)
// fork 带档位（编辑重发 & 分支/删除）
source = source.replace(
  "        body: { sessionId: state.current.id, atSeq: editing.atSeq, text },",
  "        body: { sessionId: state.current.id, atSeq: editing.atSeq, text, effort: state.effort },",
)
source = source.replace(
  "  const body = { sessionId: state.current.id }\n  if (atSeq !== undefined) body.atSeq = atSeq",
  "  const body = { sessionId: state.current.id, effort: state.effort }\n  if (atSeq !== undefined) body.atSeq = atSeq",
)

// 地址折叠 + 清理设备按钮
source = source.replace(
  `    el.settingUrls.textContent = (status.urls || []).join('\\n')`,
  `    state.urls = status.urls || []
    renderSettingUrls()`,
)
if (!source.includes('function renderSettingUrls')) {
  source = source.replace(
    'function closeSettings() {',
    `/** 地址默认只显示当前这条，展开后看全部。 */
function renderSettingUrls() {
  const urls = state.urls || []
  if (!urls.length) {
    el.settingUrls.textContent = '—'
    return
  }
  const shown = state.urlsExpanded ? urls : urls.slice(0, 1)
  el.settingUrls.textContent = shown.join('\\n')
  if (urls.length > 1) {
    el.settingUrls.textContent += (state.urlsExpanded ? '\\n（点一下收起）' : '\\n（共 ' + urls.length + ' 条，点一下展开）')
  }
}

function closeSettings() {`,
  )
}

// 点击地址行切换展开
source = source.replace(
  "el.settingsPanel.addEventListener('click', (event) => {",
  `el.settingUrls.addEventListener('click', () => {
  state.urlsExpanded = !state.urlsExpanded
  renderSettingUrls()
})

el.settingsPanel.addEventListener('click', (event) => {`,
)

// 清理设备按钮
source = source.replace(
  "$('settings-clear').addEventListener('click', hardReload)",
  `$('settings-clear').addEventListener('click', hardReload)
$('settings-prune').addEventListener('click', async () => {
  const ok = await showDialog({
    title: '清理其它设备？',
    text: '只保留当前这台设备的配对，其它设备需要重新配对才能继续使用。',
    confirm: '清理',
    danger: true,
    mode: 'confirm',
  })
  if (!ok) return
  try {
    const result = await api('prune-devices', { method: 'POST', body: {} })
    toast('已清理 ' + result.removed + ' 台，当前设备保留')
    openSettings()
  } catch (error) {
    toast('清理失败：' + error.message)
  }
})`,
)

// state 初始值
if (!source.includes('urlsExpanded')) {
  source = source.replace("  searching: false,", "  searching: false,\n  urls: [],\n  urlsExpanded: false,")
}

writeFileSync(file, source)
console.log(notes.concat(['client: effort + settings']).join('\n'))

// ── HTML：加清理设备按钮 ─────────────────────────────────────
const htmlFile = 'ui/index.html'
let html = readFileSync(htmlFile, 'utf8')
if (!html.includes('settings-prune')) {
  html = html.replace(
    `    <div class="setting-row">
      <div class="setting-label">缓存</div>`,
    `    <div class="setting-row">
      <div class="setting-label">设备清理</div>
      <div class="setting-value">
        <button id="settings-prune" type="button" class="mini">清理其它设备</button>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-label">缓存</div>`,
  )
  writeFileSync(htmlFile, html)
  console.log('html: prune button')
}
