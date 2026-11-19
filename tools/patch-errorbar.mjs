import { readFileSync, writeFileSync } from 'node:fs'

const file = 'ui/app.js'
let source = readFileSync(file, 'utf8')

const start = source.indexOf('// 运行期错误直接显示在页面顶部')
const end = source.indexOf("const $ = (id) => document.getElementById(id)")
if (start < 0 || end < 0 || end < start) {
  console.log('未找到要替换的错误提示块，保持原样')
  process.exit(0)
}

const replacement = `// 运行期错误：底部小条，可关闭，绝不遮挡界面
function showErrorBar(text) {
  let bar = document.getElementById('error-bar')
  if (!bar) {
    bar = document.createElement('div')
    bar.id = 'error-bar'
    bar.style.cssText =
      'position:fixed;left:8px;right:8px;bottom:8px;z-index:999;padding:8px 34px 8px 10px;' +
      'background:rgba(160,20,20,.94);color:#fff;font:12px/1.5 monospace;border-radius:10px;' +
      'max-height:32vh;overflow:auto;white-space:pre-wrap'
    const close = document.createElement('button')
    close.textContent = '×'
    close.style.cssText =
      'position:absolute;right:6px;top:4px;width:24px;height:24px;border:0;border-radius:50%;' +
      'background:rgba(255,255,255,.2);color:#fff;font-size:14px;line-height:1'
    close.addEventListener('click', () => bar.remove())
    bar.appendChild(close)
    const body = document.createElement('span')
    body.id = 'error-bar-text'
    bar.appendChild(body)
    document.body.appendChild(bar)
  }
  const body = bar.querySelector('#error-bar-text')
  if (body) body.textContent = String(text || '').slice(0, 600)
}

window.addEventListener('error', (event) => {
  showErrorBar('[error] ' + (event.message || '') + ' @ ' + (event.lineno || ''))
})
window.addEventListener('unhandledrejection', (event) => {
  showErrorBar('[rejection] ' + String((event.reason && event.reason.message) || event.reason))
})

`

source = source.slice(0, start) + replacement + source.slice(end)
writeFileSync(file, source)
console.log('错误提示条已改为底部可关闭')
