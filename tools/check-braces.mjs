// 粗略扫描：找出让括号失衡的位置（跳过字符串/注释/模板串）
import { readFileSync } from 'node:fs'

const source = readFileSync(process.argv[2], 'utf8')
let depth = 0
let line = 1
let mode = null // 'str' | 'tpl' | 'line' | 'block'
let quote = ''

const report = []
for (let i = 0; i < source.length; i += 1) {
  const ch = source[i]
  const next = source[i + 1]
  if (ch === '\n') {
    line += 1
    if (mode === 'line') mode = null
    continue
  }
  if (mode === 'line') continue
  if (mode === 'block') {
    if (ch === '*' && next === '/') {
      mode = null
      i += 1
    }
    continue
  }
  if (mode === 'str' || mode === 'tpl') {
    if (ch === '\\') {
      i += 1
      continue
    }
    if (ch === quote) mode = null
    continue
  }
  if (ch === '/' && next === '/') {
    mode = 'line'
    i += 1
    continue
  }
  if (ch === '/' && next === '*') {
    mode = 'block'
    i += 1
    continue
  }
  if (ch === "'" || ch === '"') {
    mode = 'str'
    quote = ch
    continue
  }
  if (ch === '`') {
    mode = 'tpl'
    quote = ch
    continue
  }
  if (ch === '{' || ch === '(' || ch === '[') {
    depth += 1
    if (depth > 40) report.push('行 ' + line + ': depth=' + depth)
  } else if (ch === '}' || ch === ')' || ch === ']') {
    depth -= 1
    if (depth < 0) {
      console.log('负数：行 ' + line + ' depth=' + depth)
      process.exit(0)
    }
  }
}

console.log('结束时总深度 =', depth)
console.log('深度超过 40 的行数:', report.length)
console.log(report.slice(0, 5).join('\n'))
