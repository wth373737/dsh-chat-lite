import { readFileSync, writeFileSync } from 'node:fs'

const file = 'ui/app.js'
let source = readFileSync(file, 'utf8')
const notes = []

// 1) 去掉消息区「下拉刷新」手势（抽屉里的 ⟳ 已足够）
const pullStart = source.indexOf("// 消息区下拉刷新（页面本身不可滚动，所以自己实现）")
if (pullStart >= 0) {
  const pullEnd = source.indexOf("// SW 更新后自动接管一次", pullStart)
  if (pullEnd > pullStart) {
    source = source.slice(0, pullStart) + source.slice(pullEnd)
    notes.push('移除下拉刷新手势')
  }
}

// 2) 区分「点击」与「滑动」：滑动/滚动后短暂屏蔽按钮点击
if (!source.includes('suppressUntil')) {
  const block = `// 误触防护：滑动或滚动结束时浏览器仍可能派发 click，
// 用一个短暂的屏蔽窗口把这类「手势残留」挡掉。
const gestureGuard = { until: 0 }
let touchOrigin = null

function markGesture() {
  gestureGuard.until = Date.now() + 300
}

document.addEventListener('touchstart', (event) => {
  const touch = event.touches && event.touches[0]
  touchOrigin = touch ? { x: touch.clientX, y: touch.clientY } : null
}, { passive: true })

document.addEventListener('touchmove', (event) => {
  const touch = event.touches && event.touches[0]
  if (!touchOrigin || !touch) return
  const dx = Math.abs(touch.clientX - touchOrigin.x)
  const dy = Math.abs(touch.clientY - touchOrigin.y)
  if (dx > 12 || dy > 12) markGesture()
}, { passive: true })

document.addEventListener('touchend', () => { touchOrigin = null }, { passive: true })
el.messages.addEventListener('scroll', markGesture, { passive: true })

/** 这次点击是不是手势残留（滑动/刚滚动完）？ */
function isGestureResidue() {
  return Date.now() < gestureGuard.until
}

`
  const anchor = "el.input.addEventListener('input', autoGrow)"
  source = source.replace(anchor, block + anchor)
  notes.push('加入手势防护')
}

// 3) 发送按钮点击时先判手势残留
source = source.replace(
  "el.send.addEventListener('click', () => (state.running ? stopMessage() : sendMessage()))",
  `el.send.addEventListener('click', () => {
    if (isGestureResidue()) return // 滑动/滚动刚结束，忽略这次误触
    if (state.running) stopMessage()
    else sendMessage()
  })`,
)

// 4) 附件/工具/消息操作也防一下滑动残留（只影响手势残留，正常点击不受影响）
source = source.replace(
  "el.attach.addEventListener('click', () => { el.attachSheet.hidden = !el.attachSheet.hidden })",
  `el.attach.addEventListener('click', () => {
    if (isGestureResidue()) return
    el.attachSheet.hidden = !el.attachSheet.hidden
  })`,
)

writeFileSync(file, source)
console.log(notes.join('\n') || '(no changes)')
