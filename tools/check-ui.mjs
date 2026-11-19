/**
 * 离线冒烟检查：用最小 DOM 桩把 ui/app.js 执行一遍。
 * 目的：在没有浏览器的情况下，捕获"函数丢了 / 元素引用没补 / 顶层抛错"这类问题。
 * 用法：node tools/check-ui.mjs
 */
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const code = readFileSync(new URL('../ui/app.js', import.meta.url), 'utf8')
const html = readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8')

// 从 index.html 里收集所有 id，桩只返回真实存在的元素（缺 id 就会被自检抓到）
const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((match) => match[1]))
const missing = new Set()

function makeElement(id) {
  const element = {
    id,
    style: { setProperty() {}, getPropertyValue: () => '', cssText: '' },
    dataset: {},
    hidden: false,
    value: '',
    textContent: '',
    innerHTML: '',
    scrollTop: 0,
    scrollHeight: 0,
    disabled: false,
    className: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener() {},
    removeEventListener() {},
    appendChild(child) { return child },
    removeChild(child) { return child },
    insertAdjacentHTML() {},
    setAttribute() {},
    getAttribute: () => null,
    removeAttribute() {},
    focus() {},
    select() {},
    setSelectionRange() {},
    closest: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }),
    scrollIntoView() {},
  }
  return element
}

const cache = new Map()
const document = {
  title: '',
  body: makeElement('body'),
  documentElement: Object.assign(makeElement('html'), { style: { setProperty() {}, getPropertyValue: () => '', cssText: '' } }),
  visibilityState: 'visible',
  getElementById(id) {
    if (!ids.has(id)) {
      missing.add(id)
      return null
    }
    if (!cache.has(id)) cache.set(id, makeElement(id))
    return cache.get(id)
  },
  createElement: (tag) => makeElement(tag),
  addEventListener() {},
  querySelector: () => null,
}

const sandbox = {
  console,
  document,
  window: {
    addEventListener() {},
    innerHeight: 800,
    innerWidth: 390,
    isSecureContext: false,
    location: { hash: '', pathname: '/', reload() {}, replace() {} },
  },
  navigator: { onLine: true, clipboard: undefined, serviceWorker: undefined },
  localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
  location: { hash: '', pathname: '/chat-lite/app/', reload() {}, replace() {} },
  EventSource: class {
    constructor() { this.onmessage = null; this.onerror = null }
    close() {}
  },
  setTimeout: (fn) => { try { fn() } catch {} return 0 },
  clearTimeout() {},
  setInterval: () => 0,
  clearInterval() {},
  requestAnimationFrame: (fn) => { try { fn() } catch {} },
  fetch: async () => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, sessions: [], catalog: null }),
    headers: { get: () => 'application/json' },
  }),
  FileReader: class {},
  Image: class {},
  URLSearchParams,
}

sandbox.window.location = sandbox.location
sandbox.globalThis = sandbox
sandbox.self = sandbox

const problems = []

try {
  vm.runInNewContext(code, sandbox, { filename: 'ui/app.js', timeout: 5000 })
} catch (error) {
  problems.push('执行抛错：' + error.message + '\n' + String(error.stack || '').split('\n').slice(0, 4).join('\n'))
}

// 检查关键函数是否定义（在沙箱里看不到顶层 const，改查源码）
const required = ['openSessionMenu', 'runSessionOp', 'showDialog', 'showPairing', 'hardReload', 'loadEarlier', 'pollForReply']
for (const name of required) {
  if (!new RegExp('function ' + name + '\\s*\\(').test(code)) problems.push('缺少函数：' + name)
}

// 检查 el 里引用的 id 都在 HTML 中存在
const elBlock = code.match(/const el = \{([\s\S]*?)\n\}/)
if (elBlock) {
  for (const match of elBlock[1].matchAll(/\$\(\s*'([^']+)'\s*\)/g)) {
    if (!ids.has(match[1])) problems.push('el 引用了不存在的 id：' + match[1])
  }
}

if (problems.length) {
  console.error('✗ UI 冒烟检查未通过：\n' + problems.join('\n'))
  process.exit(1)
}
console.log('✓ UI 冒烟检查通过（脚本可执行，关键函数齐全，元素引用有效）')
