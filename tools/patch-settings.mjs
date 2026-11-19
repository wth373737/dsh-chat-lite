import { readFileSync, writeFileSync } from 'node:fs'

// ── 宿主：/api/status（需要设备 Cookie，返回本机连接信息）────────────
const mobileFile = 'mobile.js'
let mobile = readFileSync(mobileFile, 'utf8')
const notes = []

if (!mobile.includes("action === 'status'")) {
  mobile = mobile.replace(
    "          if (action === 'bootstrap') {",
    `          // 连接状态：给 App 内设置页用（需要设备 Cookie，不对外）
          if (action === 'status') {
            const state = await auth.load()
            return sendJson(res, 200, {
              ok: true,
              device: { id: device.id, label: device.label, lastSeen: device.lastSeen },
              devices: (state.devices || []).length,
              urls: mobileUrls(req, state.token, portRef.value, config.publicBaseUrl).map((url) => url.replace(/[?&]t=[^&]+/, '')),
              chatDir,
              mobilePort: portRef.value,
            })
          }

          if (action === 'bootstrap') {`,
  )
  notes.push('host: /api/status')
}

writeFileSync(mobileFile, mobile)

// ── 前端：设置面板 ────────────────────────────────────────────
const htmlFile = 'ui/index.html'
let html = readFileSync(htmlFile, 'utf8')
if (!html.includes('settings-panel')) {
  html = html.replace(
    '<div id="effort-pop" class="pop" hidden>',
    `<div id="settings-panel" class="sheet-panel" hidden>
  <div class="sheet-panel-head">
    <span>设置</span>
    <button id="settings-close" type="button" aria-label="关闭">×</button>
  </div>
  <div class="sheet-panel-body">
    <div class="setting-row">
      <div class="setting-label">此设备</div>
      <div id="setting-device" class="setting-value">—</div>
    </div>
    <div class="setting-row">
      <div class="setting-label">已配对设备</div>
      <div id="setting-devices" class="setting-value">—</div>
    </div>
    <div class="setting-row column">
      <div class="setting-label">访问地址</div>
      <div id="setting-urls" class="setting-value mono"></div>
    </div>
    <div class="setting-row">
      <div class="setting-label">字体</div>
      <div class="setting-value">
        <button id="font-minus2" type="button" class="mini">A−</button>
        <span id="font-value2" class="font-value">100%</span>
        <button id="font-plus2" type="button" class="mini">A+</button>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-label">配对</div>
      <div class="setting-value">
        <button id="settings-pair" type="button" class="mini">重新配对</button>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-label">缓存</div>
      <div class="setting-value">
        <button id="settings-clear" type="button" class="mini">清缓存并刷新</button>
      </div>
    </div>
    <div class="setting-row">
      <div class="setting-label">版本</div>
      <div id="setting-build" class="setting-value mono">—</div>
    </div>
  </div>
</div>

<div id="effort-pop" class="pop" hidden>`,
  )
  writeFileSync(htmlFile, html)
  notes.push('html: settings panel')
}

// ── CSS ──────────────────────────────────────────────────────
const cssFile = 'ui/app.css'
let css = readFileSync(cssFile, 'utf8')
if (!css.includes('.sheet-panel')) {
  css += `

/* ── 设置面板 ─────────────────────────────────────── */
.sheet-panel {
  position: fixed; inset: auto 0 0 0; z-index: 45;
  background: var(--panel); border-top-left-radius: 18px; border-top-right-radius: 18px;
  padding: 8px 14px calc(16px + var(--safe-b));
  box-shadow: 0 -8px 28px rgba(0,0,0,.18);
  max-height: 80vh; overflow: auto;
}
.sheet-panel-head {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 16px; font-weight: 600; padding: 6px 2px 10px;
}
.sheet-panel-head button {
  border: 0; background: transparent; color: var(--ink-3); font-size: 22px; line-height: 1;
}
.sheet-panel-body { display: flex; flex-direction: column; }
.setting-row {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 11px 2px; border-bottom: 1px solid var(--line);
  font-size: calc(14px * var(--fs, 1));
}
.setting-row.column { flex-direction: column; align-items: flex-start; gap: 6px; }
.setting-label { color: var(--ink-2); }
.setting-value { color: var(--ink); text-align: right; }
.setting-row.column .setting-value { text-align: left; }
.setting-value.mono { font-size: calc(12px * var(--fs, 1)); color: var(--ink-3); word-break: break-all; }
.mini {
  border: 1px solid var(--line); background: var(--bg); color: var(--ink);
  border-radius: 8px; padding: 5px 12px; font-size: calc(13px * var(--fs, 1));
}
`
  writeFileSync(cssFile, css)
  notes.push('css: settings panel')
}

console.log(notes.join('\n'))
