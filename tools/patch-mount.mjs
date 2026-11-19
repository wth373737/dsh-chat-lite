import { readFileSync, writeFileSync } from 'node:fs'

const file = 'mobile.js'
let source = readFileSync(file, 'utf8')
const before = source
const notes = []

// 1) 增加别名挂载点（新的 Service Worker 作用域，用于脱离旧缓存）
if (!source.includes('MOUNT_ALIASES')) {
  source = source.replace(
    "const MOUNT = '/chat-lite/m'",
    [
      "const MOUNT = '/chat-lite/m'",
      "// 备用挂载点：路径不同 = Service Worker 作用域不同，旧缓存不会劫持它",
      "const MOUNT_ALIASES = ['/chat-lite/app']",
    ].join('\n'),
  )
  notes.push('added MOUNT_ALIASES')
}

// 2) Cookie 按实际挂载点设置（否则别名下的配对不会生效）
if (!source.includes('function cookieHeader(cookieValue, mount)')) {
  source = source.replace(
    'function cookieHeader(cookieValue) {',
    'function cookieHeader(cookieValue, mount) {\n  const base = mount || MOUNT',
  )
  source = source.replace("    'Path=' + MOUNT,", "    'Path=' + base,")
  notes.push('cookieHeader takes mount')
}

// 3) 路由匹配：支持主挂载点与别名
const mountResolver = `
/** 解析请求命中的挂载点（主路径或别名），返回 { mount, sub } 或 null。 */
function resolveMount(pathname) {
  for (const mount of [MOUNT, ...MOUNT_ALIASES]) {
    if (pathname === mount) return { mount, sub: '/' }
    if (pathname.startsWith(mount + '/')) {
      return { mount, sub: pathname.slice(mount.length) }
    }
  }
  return null
}
`
if (!source.includes('function resolveMount(')) {
  source = source.replace('const AUTH_FILE', mountResolver + '\nconst AUTH_FILE')
  notes.push('added resolveMount')
}

writeFileSync(file, source)
console.log('changed =', before !== source)
console.log(notes.join('\n') || '(no changes)')
