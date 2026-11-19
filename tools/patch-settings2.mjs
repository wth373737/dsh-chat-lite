import { readFileSync, writeFileSync } from 'node:fs'

// ── index.html：抽屉底部收敛为「设置」，字体控件移入面板 ──────────────
const htmlFile = 'ui/index.html'
let html = readFileSync(htmlFile, 'utf8')

// 去掉抽屉里的字体行与清缓存行（都进设置面板）
html = html.replace(/\s*<div class="font-row">[\s\S]*?<\/div>\n/, '\n')
html = html.replace(/\s*<button id="hard-reload"[\s\S]*?<\/button>\n/, '\n')

// 设置入口文案
html = html.replace(
  /<button id="settings-entry" class="drawer-foot" type="button">[\s\S]*?<\/button>/,
  `<button id="settings-entry" class="drawer-foot" type="button">
    <svg viewBox="0 0 24 24" class="icon"><path d="M12 8a4 4 0 100 8 4 4 0 000-8zm9 4a7 7 0 01-.1 1.2l2 1.6-2 3.4-2.4-1a7 7 0 01-2 1.2l-.3 2.6h-4l-.3-2.6a7 7 0 01-2-1.2l-2.4 1-2-3.4 2-1.6A7 7 0 013 12c0-.4 0-.8.1-1.2l-2-1.6 2-3.4 2.4 1a7 7 0 012-1.2L7.8 3h4l.3 2.6a7 7 0 012 1.2l2.4-1 2 3.4-2 1.6c.1.4.1.8.1 1.2z"/></svg>
    设置
    <span id="build" class="build"></span>
  </button>`,
)
writeFileSync(htmlFile, html)
console.log('html updated')

// ── app.js：设置面板逻辑 ─────────────────────────────────────
const file = 'ui/app.js'
let source = readFileSync(file, 'utf8')
const notes = []

if (!source.includes("$('settings-panel')")) {
  source = source.replace(
    "  pairingMsg: $('pairing-msg'),",
    `  pairingMsg: $('pairing-msg'),
  settingsPanel: $('settings-panel'),
  settingDevice: $('setting-device'),
  settingDevices: $('setting-devices'),
  settingUrls: $('setting-urls'),
  settingBuild: $('setting-build'),`,
  )
  notes.push('el refs')
}

if (!source.includes('function openSettings')) {
  source = source.replace(
    "function showPairing(message) {",
    `/** 打开设置面板并拉取连接信息。 */
async function openSettings() {
  el.settingsPanel.hidden = false
  el.settingDevice.textContent = '读取中…'
  el.settingDevices.textContent = '—'
  el.settingUrls.textContent = '—'
  el.settingBuild.textContent = BUILD
  syncFontLabels()
  try {
    const status = await api('status')
    el.settingDevice.textContent = (status.device && status.device.label) || (status.device && status.device.id) || '—'
    el.settingDevices.textContent = String(status.devices || 0) + ' 台'
    el.settingUrls.textContent = (status.urls || []).join('\\n')
  } catch (error) {
    el.settingDevice.textContent = '读取失败'
    el.settingUrls.textContent = String(error.message || error)
  }
}

function closeSettings() {
  el.settingsPanel.hidden = true
}

function syncFontLabels() {
  const label = Math.round(FONT_STEPS[fontIndex] * 100) + '%'
  for (const id of ['font-value', 'font-value2']) {
    const node = $(id)
    if (node) node.textContent = label
  }
}

function showPairing(message) {`,
  )
  notes.push('openSettings')
}

// 字体标签同步
source = source.replace(
  `  const label = $('font-value')
  if (label) label.textContent = Math.round(scale * 100) + '%'`,
  `  const label = Math.round(scale * 100) + '%'
  for (const id of ['font-value', 'font-value2']) {
    const node = $(id)
    if (node) node.textContent = label
  }`,
)

// 绑定
if (!source.includes("el.settingsPanel.addEventListener")) {
  source = source.replace(
    "el.pairingSubmit.addEventListener('click', submitPairing)",
    `$('settings-close').addEventListener('click', closeSettings)
el.settingsPanel.addEventListener('click', (event) => {
  if (event.target === el.settingsPanel) closeSettings()
})
$('font-plus2').addEventListener('click', () => applyFontScale(fontIndex + 1, true))
$('font-minus2').addEventListener('click', () => applyFontScale(fontIndex - 1, true))
$('settings-pair').addEventListener('click', () => {
  closeSettings()
  showPairing('粘贴新的配对链接即可换绑这台设备')
})
$('settings-clear').addEventListener('click', hardReload)

el.pairingSubmit.addEventListener('click', submitPairing)`,
  )
  notes.push('bindings')
}

// 旧的抽屉设置入口改为打开面板
source = source.replace(
  `$('settings-entry').addEventListener('click', () => {
  closeDrawer()
  showPairing('粘贴新的配对链接即可换绑这台设备')
})`,
  `$('settings-entry').addEventListener('click', () => {
  closeDrawer()
  openSettings()
})`,
)

writeFileSync(file, source)
console.log(notes.join('\n'))
