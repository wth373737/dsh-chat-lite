// dsh-chat-lite — 宿主侧（Node）
//
// 职责：
//   1. 加载自检（不注册任何工具——闲聊区不应具备工作区工具权限）
//   2. 暴露一个最小 HTTP 路由，供设置页读取/写回闲聊 preset 的 persona 提示词
//
// 为什么需要宿主路由：preset 的 persona 定义在插件包的 `cordis.patch.yml` 里，
// 浏览器侧无法直接读写文件；官方也没有「写回 preset」的 Remote 接口
// （`agentPresets.read` 只读）。所以由宿主半边读写这个 YAML。
//
// 写回后需要重启 DSH 才生效（bundle 补丁在启动时合成）。

import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const name = 'chat-lite'

// 只用 webServer 注册路由；不注入 tools，也不注册任何工具。
export const inject = ['webServer']

const ROUTE = '/chat-lite/api'
const PATCH_PATH = fileURLToPath(new URL('./cordis.patch.yml', import.meta.url))
const MAX_PERSONA_BYTES = 64 * 1024

/** 读 JSON 请求体（限长）。 */
async function readJsonBody(req, limit = MAX_PERSONA_BYTES * 2) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('payload too large')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  return JSON.parse(text)
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

/** 只接受本机来源（loopback host）。 */
function isLocalRequest(req) {
  const host = String(req.headers.host || '').toLowerCase()
  const hostname = host.replace(/:\d+$/, '')
  const hostOk = hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]'
  if (!hostOk) return false
  const origin = req.headers.origin
  if (!origin) return true
  try {
    const url = new URL(String(origin))
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  } catch {
    return false
  }
}

/**
 * 从 patch YAML 里取出 persona 的 `prefix: |` 块标量。
 * 返回 { prefix, indent } 或 null。indent 是内容行相对文件左侧的缩进宽度。
 */
function extractPrefix(text) {
  const lines = text.split(/\r?\n/)
  const keyIndex = lines.findIndex((line) => /^\s*prefix:\s*\|\s*$/.test(line))
  if (keyIndex < 0) return null
  const keyIndent = lines[keyIndex].match(/^\s*/)[0].length
  let contentIndent = -1
  const out = []
  for (let i = keyIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') {
      out.push('')
      continue
    }
    const indent = line.match(/^\s*/)[0].length
    if (indent <= keyIndent) break
    if (contentIndent < 0) contentIndent = indent
    out.push(line.slice(contentIndent))
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop()
  return { prefix: out.join('\n'), indent: contentIndent < 0 ? keyIndent + 2 : contentIndent }
}

/** 把 prefix 块替换成新的内容（保持原有缩进）。 */
function replacePrefix(text, prefix, indent) {
  const lines = text.split(/\r?\n/)
  const keyIndex = lines.findIndex((line) => /^\s*prefix:\s*\|\s*$/.test(line))
  if (keyIndex < 0) throw new Error('patch 里找不到 persona 的 prefix 块')
  const keyIndent = lines[keyIndex].match(/^\s*/)[0].length
  let end = lines.length
  for (let i = keyIndex + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (line.match(/^\s*/)[0].length <= keyIndent) {
      end = i
      break
    }
  }
  const pad = ' '.repeat(indent)
  const body = prefix
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => (line.trim() === '' ? '' : pad + line))
  // 块标量后留一行空行，避免与下一个 key 粘连
  const next = [...lines.slice(0, keyIndex + 1), ...body, '', ...lines.slice(end)]
  return next.join('\n')
}

async function readPersona() {
  const text = await readFile(PATCH_PATH, 'utf8')
  const parsed = extractPrefix(text)
  if (!parsed) throw new Error('patch 里找不到 persona 的 prefix 块')
  return { prefix: parsed.prefix, path: PATCH_PATH }
}

async function writePersona(prefix) {
  if (typeof prefix !== 'string' || !prefix.trim()) throw new Error('提示词不能为空')
  if (Buffer.byteLength(prefix, 'utf8') > MAX_PERSONA_BYTES) throw new Error('提示词过长')
  const text = await readFile(PATCH_PATH, 'utf8')
  const parsed = extractPrefix(text)
  if (!parsed) throw new Error('patch 里找不到 persona 的 prefix 块')
  // 先备份，坏了好回滚
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${PATCH_PATH}.bak-${stamp}`
  await copyFile(PATCH_PATH, backup)
  await writeFile(PATCH_PATH, replacePrefix(text, prefix, parsed.indent), 'utf8')
  return { path: PATCH_PATH, backup }
}

// ── 联网搜索开关 ──────────────────────────────────────────────────────────
// patch 里常驻一行 tool-web（提供 web_search / web_fetch），用 `disabled:` 控制开关。
// 切换只改一个布尔值，不动插件列表结构。
const WEB_ROW_ID = 'tool-web'

function findRowRange(lines, id) {
  const start = lines.findIndex((line) => new RegExp('^\\s*-\\s*id:\\s*' + id + '\\s*$').test(line))
  if (start < 0) return null
  const indent = lines[start].match(/^\s*/)[0].length
  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '') continue
    const lineIndent = line.match(/^\s*/)[0].length
    if (lineIndent < indent) {
      end = i
      break
    }
    if (lineIndent === indent && /^-\s/.test(line)) {
      end = i
      break
    }
  }
  return { start, end, indent }
}

function readWebEnabled(text) {
  const lines = text.split(/\r?\n/)
  const range = findRowRange(lines, WEB_ROW_ID)
  if (!range) return false
  for (let i = range.start; i < range.end; i++) {
    const match = lines[i].match(/^\s*disabled:\s*(true|false)\s*$/)
    if (match) return match[1] === 'false'
  }
  return true // 没有 disabled 字段 = 启用
}

function setWebEnabled(text, enabled) {
  const lines = text.split(/\r?\n/)
  const range = findRowRange(lines, WEB_ROW_ID)
  if (!range) throw new Error('patch 里找不到 tool-web 行')
  const value = enabled ? 'false' : 'true'
  for (let i = range.start; i < range.end; i++) {
    const match = lines[i].match(/^(\s*)disabled:\s*(true|false)\s*$/)
    if (match) {
      lines[i] = match[1] + 'disabled: ' + value
      return lines.join('\n')
    }
  }
  const indent = ' '.repeat(range.indent + 2)
  lines.splice(range.start + 1, 0, indent + 'disabled: ' + value)
  return lines.join('\n')
}

async function readWebTool() {
  const text = await readFile(PATCH_PATH, 'utf8')
  return { enabled: readWebEnabled(text), path: PATCH_PATH }
}

async function writeWebTool(enabled) {
  const text = await readFile(PATCH_PATH, 'utf8')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const backup = `${PATCH_PATH}.bak-${stamp}`
  await copyFile(PATCH_PATH, backup)
  await writeFile(PATCH_PATH, setWebEnabled(text, enabled === true), 'utf8')
  return { enabled: enabled === true, path: PATCH_PATH, backup }
}

/**
 * cordis 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ enabled?: boolean }} [config]
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE,
      handler: async (req, res) => {
        if (!isLocalRequest(req)) {
          sendJson(res, 403, { ok: false, error: 'forbidden' })
          return
        }
        const url = new URL(req.url || '/', 'http://localhost')
        const action = url.pathname.slice(ROUTE.length).replace(/^\/+/, '')

        try {
          if (req.method === 'GET' && action === 'persona') {
            const value = await readPersona()
            sendJson(res, 200, { ok: true, ...value })
            return
          }
          if (req.method === 'POST' && action === 'persona') {
            const body = await readJsonBody(req)
            const value = await writePersona(body.prefix)
            sendJson(res, 200, { ok: true, ...value, restartRequired: true })
            return
          }
          if (req.method === 'GET' && action === 'web') {
            const value = await readWebTool()
            sendJson(res, 200, { ok: true, ...value })
            return
          }
          if (req.method === 'POST' && action === 'web') {
            const body = await readJsonBody(req)
            const value = await writeWebTool(body.enabled === true)
            sendJson(res, 200, { ok: true, ...value, restartRequired: true })
            return
          }
          sendJson(res, 404, { ok: false, error: 'not found' })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }),
  )
}
