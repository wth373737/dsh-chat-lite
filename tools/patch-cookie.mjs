import { readFileSync, writeFileSync } from 'node:fs'

const file = 'mobile.js'
let source = readFileSync(file, 'utf8')
const before = source

// 1) 用统一的 cookie 构造替换新增的 pair 入口调用
source = source.replace(
  "res.setHeader('set-cookie', cookieFor(device.cookie))",
  "res.setHeader('set-cookie', cookieHeader(device.cookie))",
)

// 2) 注入 cookieHeader 辅助函数
if (!source.includes('function cookieHeader')) {
  const anchor = 'const hashOf = (value) =>'
  const helper = [
    '/** 设备 Cookie 的统一格式（Path 限定在挂载点内，HttpOnly，一年）。 */',
    'function cookieHeader(cookieValue) {',
    '  return [',
    '    COOKIE_NAME + \'=\' + encodeURIComponent(cookieValue),',
    '    \'Path=\' + MOUNT,',
    '    \'HttpOnly\',',
    '    \'SameSite=Lax\',',
    '    \'Max-Age=31536000\',',
    '  ].join(\'; \')',
    '}',
    '',
    anchor,
  ].join('\n')
  source = source.replace(anchor, helper)
}

// 3) 旧的 ?t= 流程复用同一函数
source = source.replace(
  /`\$\{COOKIE_NAME\}=\$\{encodeURIComponent\(granted\.cookie\)\};[^`]*`/,
  'cookieHeader(granted.cookie)',
)

writeFileSync(file, source)
console.log('changed =', before !== source)
console.log('has cookieHeader =', source.includes('function cookieHeader'))
console.log('has cookieFor =', source.includes('cookieFor'))
