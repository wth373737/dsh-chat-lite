import { readFileSync, writeFileSync } from 'node:fs'

// ── CSS：把关键字号改成可缩放 ────────────────────────────────
const cssFile = 'ui/app.css'
let css = readFileSync(cssFile, 'utf8')
css = css.replace(':root {', ':root {\n  --fs: 1;   /* 字体缩放系数，由设置页调整 */')

const replacements = [
  ['  font: 15px/1.6 system-ui', '  font: calc(15px * var(--fs, 1))/1.6 system-ui'],
  ['.row-title { flex: 1; min-width: 0; font-size: 15px;', '.row-title { flex: 1; min-width: 0; font-size: calc(15px * var(--fs, 1));'],
  ['.drawer-title { font-size: 20px;', '.drawer-title { font-size: calc(20px * var(--fs, 1));'],
  ['.title {\n  flex: 1; min-width: 0; text-align: center;\n  font-size: 16px;', '.title {\n  flex: 1; min-width: 0; text-align: center;\n  font-size: calc(16px * var(--fs, 1));'],
  ['.empty-text { font-size: 17px;', '.empty-text { font-size: calc(17px * var(--fs, 1));'],
  ['.usage { font-size: 11.5px;', '.usage { font-size: calc(11.5px * var(--fs, 1));'],
  ['.thinking-body {\n  border-left: 2px solid var(--line); padding: 6px 0 6px 10px;\n  color: var(--ink-2); font-size: 13px;', '.thinking-body {\n  border-left: 2px solid var(--line); padding: 6px 0 6px 10px;\n  color: var(--ink-2); font-size: calc(13px * var(--fs, 1));'],
  ['.chip {\n  height: 28px; padding: 0 10px; border-radius: 14px;\n  border: 1px solid var(--line); background: var(--panel);\n  color: var(--ink-2); font-size: 12px;', '.chip {\n  height: 28px; padding: 0 10px; border-radius: 14px;\n  border: 1px solid var(--line); background: var(--panel);\n  color: var(--ink-2); font-size: calc(12px * var(--fs, 1));'],
  ['.thinking-toggle {\n  display: inline-flex; align-items: center; gap: 6px;\n  border: 0; background: transparent; color: var(--ink-3);\n  font-size: 12.5px;', '.thinking-toggle {\n  display: inline-flex; align-items: center; gap: 6px;\n  border: 0; background: transparent; color: var(--ink-3);\n  font-size: calc(12.5px * var(--fs, 1));'],
  ['.tool-chip {\n  align-self: flex-start; border: 1px solid var(--line); background: var(--bg);\n  color: var(--ink-2); font-size: 12px;', '.tool-chip {\n  align-self: flex-start; border: 1px solid var(--line); background: var(--bg);\n  color: var(--ink-2); font-size: calc(12px * var(--fs, 1));'],
  ['.row-snippet {\n  font-size: 12px;', '.row-snippet {\n  font-size: calc(12px * var(--fs, 1));'],
]

let changed = 0
for (const [from, to] of replacements) {
  if (css.includes(from)) {
    css = css.replace(from, to)
    changed += 1
  }
}
writeFileSync(cssFile, css)
console.log('css 字号替换:', changed + '/' + replacements.length)

// ── JS：缩放控制 ─────────────────────────────────────────────
const file = 'ui/app.js'
let source = readFileSync(file, 'utf8')
const notes = []

if (!source.includes('function applyFontScale')) {
  source = source.replace(
    "function showPairing(message) {",
    `const FONT_STEPS = [0.9, 1, 1.1, 1.2, 1.3]
let fontIndex = 1

function applyFontScale(index, persist) {
  fontIndex = Math.max(0, Math.min(FONT_STEPS.length - 1, index))
  const scale = FONT_STEPS[fontIndex]
  document.documentElement.style.setProperty('--fs', String(scale))
  const label = $('font-value')
  if (label) label.textContent = Math.round(scale * 100) + '%'
  if (persist) localStorage.setItem('chat-lite:font', String(fontIndex))
}

function showPairing(message) {`,
  )
  notes.push('applyFontScale')
}

if (!source.includes("$('font-plus')")) {
  source = source.replace(
    "el.pairingSubmit.addEventListener('click', submitPairing)",
    `$('font-plus').addEventListener('click', () => applyFontScale(fontIndex + 1, true))
$('font-minus').addEventListener('click', () => applyFontScale(fontIndex - 1, true))

el.pairingSubmit.addEventListener('click', submitPairing)`,
  )
  notes.push('font buttons')
}

// 启动时恢复
if (!source.includes("localStorage.getItem('chat-lite:font')")) {
  source = source.replace(
    "  if (!checkElements()) return",
    `  if (!checkElements()) return
  applyFontScale(Number(localStorage.getItem('chat-lite:font') || 1), false)`,
  )
  notes.push('restore font')
}

writeFileSync(file, source)
console.log(notes.join('\n') || '(no changes)')
