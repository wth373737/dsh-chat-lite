// dsh-chat-lite —— 移动端后端（独立页面 + 独立认证）
//
// 目标：手机打开 http://<局域网IP>:<端口>/chat-lite/m/ 就能用，**不受官方壳与第三方插件影响**，
// 且 DSH 重启后**不需要重新扫码**。
//
// 认证模型：
//   - 首次访问带 ?t=<令牌>（令牌由设置页/本机接口给出，长期有效，存在 <闲聊目录>/.chat-lite/auth.json）
//   - 交换成功后下发设备 Cookie（HttpOnly），重启后 Cookie 依然有效
//   - loopback 直接放行，方便桌面自测
//
// 数据通道：直接调用宿主服务 sessionController（create / prompt / cancel / page / follow），
// 与官方 Web UI 用的是同一套会话，不复制数据。

import { randomBytes, createHash } from 'node:crypto'
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { inflateSync, inflateRawSync } from 'node:zlib'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'
import { createServer } from 'node:http'
import { extractOfficeText } from './office.js'

const MOUNT = '/chat-lite/m'
// 备用挂载点：路径不同 = Service Worker 作用域不同，旧缓存不会劫持它
const MOUNT_ALIASES = ['/chat-lite/app']
const UI_DIR = fileURLToPath(new URL('./ui/', import.meta.url))
const COOKIE_NAME = 'chat_lite_dev'

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

const AUTH_FILE = 'auth.json'
const MAX_BODY = 4 * 1024 * 1024

// ── 小工具 ─────────────────────────────────────────────────────────────────

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(body)
}

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
}

/** 只保留 UI 需要的事件字段，避免把工具结果/搜索原文整包发给手机。 */
function slimRecords(records) {
  const out = []
  for (const record of records || []) {
    const event = record && record.event
    if (!event) continue
    if (event.type === 'user/message') {
      const source = (event.data && event.data.source) || {}
      if (source.kind && source.kind !== 'user') continue
      const content = ((event.data && event.data.content) || [])
        .filter((part) => part && (part.type === 'text' || ((part.type === 'image' || part.type === 'file') && part.attachment)))
        .map((part) => part.type === 'text'
          ? { type: 'text', text: part.text }
          : part.type === 'image'
            ? {
              type: 'image',
              attachment: {
                attachmentId: part.attachment.attachmentId,
                mediaType: part.attachment.mediaType,
                width: part.attachment.width,
                height: part.attachment.height,
              },
            }
            : {
              type: 'file',
              attachment: {
                attachmentId: part.attachment.attachmentId,
                name: part.attachment.name,
                bytes: part.attachment.bytes,
              },
            })
      if (!content.length) continue
      out.push({ event: { type: event.type, seq: event.seq, time: event.time, data: { content, source: { kind: source.kind || 'user' } } } })
    } else if (event.type === 'assistant/message') {
      const blocks = (event.data && event.data.message && event.data.message.content) || []
      const content = blocks.filter((part) => part && (part.type === 'text' || part.type === 'reasoning'))
      if (!content.length) continue
      out.push({
        event: {
          type: event.type,
          seq: event.seq,
          time: event.time,
          data: { message: { content }, usage: event.data && event.data.usage },
        },
      })
    } else if (event.type === 'tool/call') {
      out.push({
        event: {
          type: event.type,
          seq: event.seq,
          time: event.time,
          data: {
            name: event.data && event.data.name,
            callId: event.data && event.data.callId,
            arguments: String((event.data && event.data.arguments) || '').slice(0, 600),
          },
        },
      })
    } else if (event.type === 'tool/result') {
      const meta = (event.data && event.data.message) || {}
      const text = ((meta.content || [])
        .filter((part) => part && part.type === 'text')
        .map((part) => part.text)
        .join('\n') || '').slice(0, 1200)
      out.push({
        event: {
          type: event.type,
          seq: event.seq,
          time: event.time,
          data: {
            callId: (meta.toolCallId || (meta.source && meta.source.callId)) || '',
            text,
            isError: Boolean(meta.isError),
          },
        },
      })
    }
  }
  return out
}

/** 定位宿主 sessions 根目录（从 DSH_HOME 推导，兼容 .dsh 嵌套）。 */
function defaultSessionsRoot() {
  const home = process.env.DSH_HOME || ''
  if (!home) return ''
  const candidates = [path.join(home, 'sessions'), path.join(home, '.dsh', 'sessions')]
  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isDirectory()) return candidate
    } catch {
      // 试下一个
    }
  }
  return candidates[0]
}

/** 读取宿主持久化的工作区状态（归档/置顶集合）。 */
async function readWorkspaceState(sessionsRoot) {
  const empty = { archived: new Set(), pinned: new Set() }
  try {
    const file = path.join(path.dirname(sessionsRoot), 'storages', 'workspace.json')
    const raw = JSON.parse(await readFile(file, 'utf8'))
    const global = (raw && raw.global) || {}
    return {
      archived: new Set((global.archivedSessionIds || []).map(String)),
      pinned: new Set((global.pinnedSessionIds || []).map(String)),
    }
  } catch {
    return empty
  }
}

const IMAGE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

/** 把图片按内容哈希存到 <chatDir>/.chat-lite/img/，供历史回显。 */
async function saveLocalImage(chatDir, hash, mediaType, bytes) {
  try {
    const dir = path.join(chatDir, '.chat-lite', 'img')
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, hash + '.' + (IMAGE_EXT[mediaType] || 'bin')), bytes)
  } catch {
    // 本地副本失败不影响发送
  }
}

/** 读取本地图片副本（attachmentId 形如 sha256:<hex>）。 */
async function readLocalImage(chatDir, attachmentId) {
  const id = String(attachmentId || '')
  const hex = id.startsWith('sha256:') ? id.slice('sha256:'.length) : id
  if (!/^[0-9a-f]{8,128}$/.test(hex)) return null
  const dir = path.join(chatDir, '.chat-lite', 'img')
  for (const [mediaType, ext] of Object.entries(IMAGE_EXT)) {
    try {
      const data = await readFile(path.join(dir, hex + '.' + ext))
      return { mediaType, data }
    } catch {
      // 继续尝试下一个扩展名
    }
  }
  return null
}

/** 下发首页时把 app.js/app.css 的 URL 换成内容版本号，旧缓存永远命中不了。 */
async function sendIndex(res) {
  try {
    const html = await readFile(path.join(UI_DIR, 'index.html'), 'utf8')
    const stampOf = async (name) => {
      try {
        const stat = await statMtime(path.join(UI_DIR, name))
        return String(stat)
      } catch {
        return '0'
      }
    }
    const jsStamp = await stampOf('app.js')
    const cssStamp = await stampOf('app.css')
    const body = html
      .replace(/ui\/app\.js(\?v=[^"']*)?/, 'ui/app.js?v=' + jsStamp)
      .replace(/ui\/app\.css(\?v=[^"']*)?/, 'ui/app.css?v=' + cssStamp)
      .replace('__BUILD__', jsStamp)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  } catch {
    sendText(res, 500, 'index.html 读取失败')
  }
}

async function statMtime(file) {
  const { stat } = await import('node:fs/promises')
  const info = await stat(file)
  return info.mtimeMs
}


// ── 历史库（.chat-lite）查询 ─────────────────────────────────────────────
const HISTORY_DEFAULT_MONTHS = 3
const SEARCH_CHUNK_LIMIT = 40

const historyDir = (chatDir) => path.join(chatDir, '.chat-lite')

/** 读取 index.jsonl（每行一条会话摘要）。 */
async function readHistoryIndex(chatDir) {
  const file = path.join(historyDir(chatDir), 'index.jsonl')
  const raw = await readFile(file, 'utf8')
  const rows = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text) continue
    try {
      rows.push(JSON.parse(text))
    } catch {
      // 跳过坏行
    }
  }
  return rows
}

/** 把索引行转成移动端需要的形状。 */
function toHistoryItem(row) {
  return {
    id: String(row.id),
    title: String(row.title || row.first || '未命名对话').slice(0, 80),
    updatedAt: Date.parse(row.updated || row.inserted || 0) || 0,
    messages: Number(row.messages || 0),
    source: row.source || 'import',
    preview: String(row.first || '').slice(0, 120),
  }
}

/** 历史会话正文。 */
async function readHistoryItem(chatDir, id) {
  const safe = String(id || '').replace(/[^\w.-]/g, '')
  if (!safe) return null
  const file = path.join(historyDir(chatDir), 'sessions', safe + '.jsonl')
  const raw = await readFile(file, 'utf8')
  const messages = []
  let meta = null
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (!text) continue
    let row
    try {
      row = JSON.parse(text)
    } catch {
      continue
    }
    if (row.kind === 'meta') {
      meta = row
      continue
    }
    if (row.role === 'user' || row.role === 'assistant') {
      messages.push({
        role: row.role,
        ts: Date.parse(row.ts || 0) || 0,
        text: String(row.text || ''),
        thinking: row.thinking ? String(row.thinking) : '',
        files: Array.isArray(row.files) ? row.files : [],
      })
    }
  }
  return { meta, messages }
}

/** 全文搜索：按分块从新到旧扫描，命中即收集，达到上限提前结束。 */
async function searchHistoryFull(chatDir, query, limit) {
  const dir = path.join(historyDir(chatDir), 'search')
  let names = []
  try {
    names = (await readdir(dir)).filter((name) => /^c\d+\.jsonl$/.test(name)).sort().reverse()
  } catch {
    names = []
  }
  if (names.length > SEARCH_CHUNK_LIMIT) names = names.slice(0, SEARCH_CHUNK_LIMIT)

  const needle = query.toLowerCase()
  const hits = []
  const seen = new Set()

  const scan = async (fileName) => {
    let raw
    try {
      raw = await readFile(path.join(dir, fileName), 'utf8')
    } catch {
      return
    }
    for (const line of raw.split('\n')) {
      const text = line.trim()
      if (!text) continue
      let row
      try {
        row = JSON.parse(text)
      } catch {
        continue
      }
      const haystack = String(row.t || '')
      const at = haystack.toLowerCase().indexOf(needle)
      if (at < 0) continue
      const id = String(row.id || '')
      if (seen.has(id)) continue
      seen.add(id)
      const start = Math.max(0, at - 40)
      const snippet = haystack.slice(start, Math.min(haystack.length, at + needle.length + 80)).replace(/\s+/g, ' ')
      hits.push({ id, snippet })
      if (hits.length >= limit) return
    }
  }

  for (const name of names) {
    await scan(name)
    if (hits.length >= limit) break
  }
  if (hits.length < limit) {
    try {
      await scan('live.jsonl')
    } catch {
      // 忽略
    }
  }
  return hits
}


/** 极简 PDF 文本提取：解压 FlateDecode 流，按定位操作符分段抽取文本。 */
export function extractPdfText(buffer, maxChars) {
  const streams = []
  let index = 0
  while ((index = buffer.indexOf('stream', index)) !== -1) {
    let start = index + 6
    if (buffer[start] === 0x0d && buffer[start + 1] === 0x0a) start += 2
    else if (buffer[start] === 0x0a || buffer[start] === 0x0d) start += 1
    const end = buffer.indexOf('endstream', start)
    if (end === -1) break
    const chunk = buffer.subarray(start, end)
    let decoded = null
    try {
      decoded = inflateSync(chunk).toString('latin1')
    } catch {
      try {
        decoded = inflateRawSync(chunk).toString('latin1')
      } catch {
        decoded = null
      }
    }
    if (decoded) streams.push(decoded)
    index = end + 9
  }

  const pieces = []
  for (const content of streams) {
    const segments = content.split(/\bT[dDm]\b|\bT\*\b|\bET\b|\bBT\b/)
    for (const segment of segments) {
      const line = []
      for (const match of segment.matchAll(/\(((?:\\.|[^\\()])*)\)/g)) {
        line.push(unescapePdfString(match[1]))
      }
      for (const match of segment.matchAll(/<([0-9A-Fa-f\s]{4,})>/g)) {
        const hex = match[1].replace(/\s+/g, '')
        if (hex.length % 2 !== 0) continue
        let decoded = ''
        for (let i = 0; i < hex.length; i += 2) decoded += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16))
        if (/[ -~]/.test(decoded)) line.push(decoded)
      }
      const text = line.join('').replace(/\u0000/g, '').trim()
      if (text) pieces.push(text)
    }
  }

  const text = pieces
    .join('\n')
    .replace(/\b[a-z]{2}-[A-Z]{2}\b/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return text.length > maxChars ? text.slice(0, maxChars) : text
}

/** 反解 PDF 字符串里的转义序列。 */
function unescapePdfString(raw) {
  let out = ''
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (ch !== '\\') {
      out += ch
      continue
    }
    const next = raw[i + 1]
    i += 1
    if (next === 'n') out += '\n'
    else if (next === 'r') out += '\r'
    else if (next === 't') out += '\t'
    else if (next === '(' || next === ')' || next === '\\') out += next
    else if (/[0-7]/.test(next || '')) {
      let oct = next
      while (oct.length < 3 && /[0-7]/.test(raw[i + 1] || '')) {
        oct += raw[i + 1]
        i += 1
      }
      out += String.fromCharCode(parseInt(oct, 8))
    } else out += next || ''
  }
  return out
}

async function sendFile(res, file) {
  try {
    const data = await readFile(file)
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    })
    res.end(data)
  } catch {
    sendText(res, 404, 'not found')
  }
}

function sendText(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(body)
}

async function readBody(req, limit = MAX_BODY) {
  let size = 0
  const chunks = []
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  return JSON.parse(text)
}

function parseCookies(req) {
  const raw = req.headers.cookie || ''
  const out = {}
  for (const part of String(raw).split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return out
}

function isLoopback(req) {
  // 经过反向代理（Tailscale Serve / Cloudflare Tunnel）的请求一定带这个头，
  // 即使 socket 是本机也必须按外部处理，否则令牌接口会被手机拿到。
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip']) return false
  const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '')
  if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]') return true
  const socket = req.socket && req.socket.remoteAddress
  if (socket && (socket === '127.0.0.1' || socket === '::1' || socket === '::ffff:127.0.0.1')) {
    // 经 LAN 转发器进来的请求也会是 loopback socket，所以还必须看 Host
    return host === '127.0.0.1' || host === 'localhost' || host === '[::1]'
  }
  return false
}

/** 列出本机所有局域网 IPv4 地址（用于给出手机可用的完整链接）。 */
function lanHosts() {
  const out = []
  try {
    const nets = networkInterfaces()
    for (const name of Object.keys(nets)) {
      for (const net of nets[name] || []) {
        if (net.family !== 'IPv4' || net.internal) continue
        out.push(net.address)
      }
    }
  } catch {
    // 忽略
  }
  return out
}

/** 由请求 Host 推导端口，再拼出局域网可用的配对链接。 */
function mobileUrls(req, token, fixedPort, publicBaseUrl) {
  const publicBase = String(publicBaseUrl || '').replace(/\/+$/, '')
  const host = String(req.headers.host || '')
  const hostPort = host.includes(':') ? host.slice(host.lastIndexOf(':') + 1) : '80'
  const port = String(fixedPort || hostPort)
  const lan = lanHosts().map((ip) => 'http://' + ip + ':' + port + MOUNT + '/?t=' + token)
  if (publicBase) {
    // 别名地址排最前：全新 Service Worker 作用域，用于从旧缓存里脱身
    return [
      publicBase + MOUNT_ALIASES[0] + '/?t=' + token,
      publicBase + MOUNT + '/?t=' + token,
      ...lan,
      'http://' + host + MOUNT + '/?t=' + token,
    ]
  }
  return [...lan, 'http://' + host + MOUNT + '/?t=' + token]
}

/** 设备 Cookie 的统一格式（Path 限定在挂载点内，HttpOnly，一年）。 */
function cookieHeader(cookieValue, mount) {
  const base = mount || MOUNT
  return [
    COOKIE_NAME + '=' + encodeURIComponent(cookieValue),
    'Path=' + base,
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=31536000',
  ].join('; ')
}

const hashOf = (value) => createHash('sha256').update(String(value)).digest('hex').slice(0, 32)

// ── 认证存储 ───────────────────────────────────────────────────────────────

export class MobileAuth {
  constructor(chatDir) {
    this.dir = path.join(chatDir, '.chat-lite')
    this.file = path.join(this.dir, AUTH_FILE)
    this.state = null
  }

  async load() {
    if (this.state) return this.state
    try {
      this.state = JSON.parse(await readFile(this.file, 'utf8'))
    } catch {
      this.state = null
    }
    if (!this.state || !this.state.token) {
      this.state = {
        version: 1,
        token: randomBytes(24).toString('hex'),
        devices: [],
        createdAt: new Date().toISOString(),
      }
      await this.save()
    }
    return this.state
  }

  async save() {
    await mkdir(this.dir, { recursive: true })
    await writeFile(this.file, JSON.stringify(this.state, null, 2) + '\n', 'utf8')
  }

  /** 校验令牌；成功则登记/刷新设备并返回设备 Cookie 值。 */
  async redeem(token, label) {
    const state = await this.load()
    if (!token || token !== state.token) return null
    const id = randomBytes(8).toString('hex')
    const secret = randomBytes(16).toString('hex')
    state.devices.push({
      id,
      secret: hashOf(secret),
      label: String(label || '').slice(0, 60),
      createdAt: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    })
    // 只保留最近 20 台，避免无限增长
    if (state.devices.length > 20) state.devices = state.devices.slice(-20)
    await this.save()
    return { cookie: id + '.' + secret, deviceId: id }
  }

  /** 校验设备 Cookie。 */
  async verify(cookieValue) {
    if (!cookieValue || !cookieValue.includes('.')) return null
    const state = await this.load()
    const [id, secret] = cookieValue.split('.')
    const device = state.devices.find((item) => item.id === id)
    if (!device) return null
    if (device.secret !== hashOf(secret)) return null
    device.lastSeen = new Date().toISOString()
    return device
  }

  async revokeAll() {
    const state = await this.load()
    state.devices = []
    state.token = randomBytes(24).toString('hex')
    await this.save()
    return state.token
  }

  async token() {
    const state = await this.load()
    return state.token
  }
}

// ── 路由注册 ───────────────────────────────────────────────────────────────

export function registerMobile(ctx, config) {
  const chatDir = config.chatDir || ''
  if (!chatDir) return () => {}

  const auth = new MobileAuth(chatDir)
  // 宿主方法需要 AbortSignal；插件卸载时统一取消
  const lifetime = new AbortController()

  /** 找到闲聊目录对应的工作区 id（新建会话时用于绑定）。 */
  async function resolveWorkspace() {
    try {
      const list = ctx.workspaceRegistry.list()
      const target = path.resolve(chatDir).toLowerCase()
      for (const workspace of list) {
        if (String(workspace.path || '').toLowerCase() === target) return workspace.id
      }
      return list.length ? list[0].id : undefined
    } catch {
      return undefined
    }
  }

  const deviceOf = async (req) => {
    if (isLoopback(req)) return { id: 'loopback', label: '本机', loopback: true }
    const cookie = parseCookies(req)[COOKIE_NAME]
    return auth.verify(cookie)
  }

  const guard = async (req, res) => {
    const device = await deviceOf(req)
    if (!device) {
      sendJson(res, 401, { ok: false, error: 'unauthorized', needPair: true })
      return null
    }
    if (req.method !== 'GET' && req.headers['x-chat-lite'] !== '1') {
      sendJson(res, 400, { ok: false, error: 'missing x-chat-lite header' })
      return null
    }
    return device
  }

  // 固定端口：手机地址不随 DSH 重启变化（DSH 自己每次都换随机端口）
  const portRef = { value: Number(config.mobilePort || 8787) }

  const handler = async (req, res) => {
        const url = new URL(req.url || '/', 'http://localhost')
        const route = resolveMount(url.pathname)
        if (!route) return sendJson(res, 404, { ok: false, error: 'not found' })
        const mount = route.mount
        const sub = route.sub

        try {
          // 页面本身
          if (req.method === 'GET' && (sub === '/' || sub === '')) {
            const token = url.searchParams.get('t')
            if (token) {
              const granted = await auth.redeem(token, req.headers['user-agent'])
              if (!granted) return sendText(res, 403, '配对令牌无效', 'text/plain; charset=utf-8')
              res.setHeader(
                'set-cookie',
                cookieHeader(granted.cookie, mount),
              )
              // 去掉 ?t= 再跳一次，避免令牌留在地址栏/历史里
              res.writeHead(302, { location: mount + '/' })
              return res.end()
            }
            return sendIndex(res)
          }

          // 版本自检：在浏览器里直接打开即可确认走的是不是最新代码
          if (req.method === 'GET' && sub === '/__version') {
            const { stat } = await import('node:fs/promises')
            let stamp = 0
            try {
              stamp = (await stat(path.join(UI_DIR, 'app.js'))).mtimeMs
            } catch {
              stamp = 0
            }
            return sendText(res, 200, 'chat-lite build=' + stamp + '\nmount=' + mount + '\n', 'text/plain; charset=utf-8')
          }

          // Service Worker 必须挂在作用域根部，否则控制不到 /chat-lite/m/
          if (req.method === 'GET' && sub === '/sw.js') {
            try {
              const code = await readFile(path.join(UI_DIR, 'sw.js'))
              res.writeHead(200, {
                'content-type': 'application/javascript; charset=utf-8',
                'service-worker-allowed': MOUNT + '/',
                'cache-control': 'no-cache',
              })
              res.end(code)
            } catch {
              sendText(res, 404, 'not found')
            }
            return
          }

          // 静态资源：/ui/<file>
          if (req.method === 'GET' && sub.startsWith('/ui/')) {
            const name = sub.slice('/ui/'.length)
            if (!/^[\w.-]+$/.test(name)) return sendJson(res, 400, { ok: false, error: 'bad path' })
            return sendFile(res, path.join(UI_DIR, name))
          }

          if (!sub.startsWith('/api/')) return sendJson(res, 404, { ok: false, error: 'not found' })
          const action = sub.slice('/api/'.length)

          // 令牌信息（仅 loopback）：用于桌面端复制配对链接
          // App 内配对：粘贴配对码/链接后在此换取设备 Cookie

          // 历史库列表（默认最近 3 个月，滚动时用 before 游标继续取）
          if (action === 'history') {
            const limit = Math.min(100, Number(url.searchParams.get('limit') || 60))
            const beforeCursor = Number(url.searchParams.get('before') || 0)
            const all = url.searchParams.get('all') === '1'
            const rows = await readHistoryIndex(chatDir)
            const cutoff = all ? 0 : Date.now() - HISTORY_DEFAULT_MONTHS * 30 * 86400000
            let items = rows
              .map(toHistoryItem)
              .filter((item) => item.updatedAt >= cutoff)
            items.sort((a, b) => b.updatedAt - a.updatedAt)
            if (beforeCursor) items = items.filter((item) => item.updatedAt < beforeCursor)
            const page = items.slice(0, limit)
            return sendJson(res, 200, {
              ok: true,
              items: page,
              hasMore: items.length > page.length,
              total: rows.length,
              cutoff,
            })
          }

          // 历史会话正文（只读）
          if (action === 'history-item') {
            const id = url.searchParams.get('id') || ''
            const data = await readHistoryItem(chatDir, id)
            if (!data) return sendJson(res, 404, { ok: false, error: '找不到历史会话' })
            return sendJson(res, 200, {
              ok: true,
              id,
              title: (data.meta && data.meta.title) || '',
              messages: data.messages,
            })
          }

          // 搜索：scope=title 只查标题与首句；scope=full 扫全文分块
          if (action === 'search') {
            const query = String(url.searchParams.get('q') || '').trim()
            const scope = url.searchParams.get('scope') === 'full' ? 'full' : 'title'
            const limit = Math.min(60, Number(url.searchParams.get('limit') || 30))
            if (!query) return sendJson(res, 200, { ok: true, items: [], scope })
            const rows = await readHistoryIndex(chatDir)
            const byId = new Map(rows.map((row) => [String(row.id), row]))
            if (scope === 'title') {
              const needle = query.toLowerCase()
              const items = rows
                .filter((row) => String(row.title || row.first || '').toLowerCase().includes(needle))
                .map((row) => ({ ...toHistoryItem(row), snippet: String(row.first || '').slice(0, 120) }))
                .sort((a, b) => b.updatedAt - a.updatedAt)
                .slice(0, limit)
              return sendJson(res, 200, { ok: true, items, scope })
            }
            const hits = await searchHistoryFull(chatDir, query, limit)
            const items = hits.map((hit) => {
              const row = byId.get(hit.id)
              return {
                id: hit.id,
                snippet: hit.snippet,
                title: row ? String(row.title || row.first || '未命名对话') : '未命名对话',
                updatedAt: row ? toHistoryItem(row).updatedAt : 0,
              }
            })
            return sendJson(res, 200, { ok: true, items, scope })
          }

          if (action === 'pair') {
            const body = await readBody(req)
            const raw = String(body.token || '').trim()
            if (!raw) return sendJson(res, 400, { ok: false, error: '请粘贴配对链接或令牌' })
            // 支持整条链接，自动取出 t 参数
            let token = raw
            const match = raw.match(/[?&]t=([^&\s]+)/)
            if (match) token = decodeURIComponent(match[1])
            const device = await auth.redeem(token, String(req.headers['user-agent'] || '').slice(0, 60))
            if (!device) return sendJson(res, 403, { ok: false, error: '配对码无效或已失效' })
            res.setHeader('set-cookie', cookieHeader(device.cookie, mount))
            return sendJson(res, 200, { ok: true, deviceId: device.deviceId })
          }

          if (action === 'token') {
            if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
            const device = await deviceOf(req)
            if (!device) return sendJson(res, 401, { ok: false, error: 'unauthorized' })
            const state = await auth.load()
            const host = req.headers.host || '127.0.0.1'
            return sendJson(res, 200, {
              ok: true,
              token: state.token,
              url: 'http://' + host + MOUNT + '/?t=' + state.token,
              urls: mobileUrls(req, state.token, portRef.value, config.publicBaseUrl),
              devices: state.devices.map((item) => ({
                id: item.id,
                label: item.label,
                createdAt: item.createdAt,
                lastSeen: item.lastSeen,
              })),
            })
          }

          const device = await guard(req, res)
          if (!device) return

          // 撤销全部设备并换新令牌（必须从本机发起，避免被人远程踢掉）
          if (action === 'revoke') {
            if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
            const token = await auth.revokeAll()
            const host = req.headers.host || '127.0.0.1'
            return sendJson(res, 200, {
              ok: true,
              token,
              url: 'http://' + host + MOUNT + '/?t=' + token,
              urls: mobileUrls(req, token, portRef.value, config.publicBaseUrl),
            })
          }

          // 连接状态：给 App 内设置页用（需要设备 Cookie，不对外）
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

          if (action === 'bootstrap') {
            const controller = ctx.sessionController
            const listed = await controller.list({}, lifetime.signal)
            const items = (listed.items || []).filter((item) => item.cwd === chatDir && !item.origin)
            // 归档/置顶是宿主全局状态，直接读持久化文件（比订阅流可靠）
            const includeArchived = url.searchParams.get('all') === '1'
            let sessionsRoot = ''
            try {
              sessionsRoot = defaultSessionsRoot()
            } catch {
              sessionsRoot = ''
            }
            const workspaceState = sessionsRoot
              ? await readWorkspaceState(sessionsRoot)
              : { archived: new Set(), pinned: new Set() }
            let catalog = null
            try {
              catalog = await controller.modelCatalog()
            } catch {
              catalog = null
            }
            return sendJson(res, 200, {
              ok: true,
              chatDir,
              device: { id: device.id, label: device.label },
              sessions: items.filter((item) => includeArchived || !workspaceState.archived.has(String(item.sessionId))).map((item) => {
                const values = (item.projections && item.projections.values) || {}
                return {
                  id: item.sessionId,
                  title: values.title || values.displayTitle || '',
                  updatedAt: item.updatedAt,
                  running: item.running,
                  blank: item.blank,
                  parentId: item.parentSessionId || null,
                  archived: workspaceState.archived.has(String(item.sessionId)),
                  pinned: workspaceState.pinned.has(String(item.sessionId)),
                }
              }),
              catalog,
            })
          }

          if (action === 'page') {
            const sessionId = url.searchParams.get('sessionId') || ''
            const beforeSeq = url.searchParams.get('beforeSeq')
            const max = Number(url.searchParams.get('max') || '30')
            const inspected = await ctx.sessionController.inspect(sessionId, lifetime.signal)
            const events = inspected.events || []
            const lastSeq = events.length ? events[events.length - 1].seq : 0
            const value = await ctx.sessionController.page({
              address: { kind: 'session', sessionId },
              throughSeq: lastSeq,
              ...(beforeSeq ? { beforeSeq: Number(beforeSeq) } : {}),
              maxMessages: max,
            }, lifetime.signal)
            return sendJson(res, 200, { ok: true, records: slimRecords(value.records), hasMore: value.hasMore })
          }

          if (action === 'send') {
            const body = await readBody(req)
            if (!body.sessionId || !body.text) return sendJson(res, 400, { ok: false, error: '缺少 sessionId/text' })
            const files = Array.isArray(body.files) ? body.files.filter(Boolean) : []
            const images = Array.isArray(body.images) ? body.images.filter(Boolean) : []
            const content = [{ type: 'text', text: String(body.text || '') }]
            for (const image of images) {
              if (!image || !image.data || !image.mediaType) continue
              const bytes = Buffer.from(String(image.data), 'base64')
              const hash = createHash('sha256').update(bytes).digest('hex')
              await saveLocalImage(chatDir, hash, String(image.mediaType), bytes)
              content.push({
                type: 'image',
                mediaType: String(image.mediaType),
                data: String(image.data),
                ...(image.name ? { name: String(image.name) } : {}),
              })
            }
            for (const file of files) {
              if (!file || !file.receiptId) continue
              content.push({ type: 'file', receiptId: String(file.receiptId) })
            }
            const value = await ctx.sessionController.prompt({
              requestId: 'm-' + randomBytes(8).toString('hex'),
              sessionId: body.sessionId,
              mode: 'queue',
              content,
            }, lifetime.signal)
            return sendJson(res, 200, { ok: true, ...value })
          }

          if (action === 'cancel') {
            const body = await readBody(req)
            const value = ctx.sessionController.cancel({ sessionId: body.sessionId })
            return sendJson(res, 200, { ok: true, ...value })
          }

          if (action === 'effort') {
            const body = await readBody(req)
            if (!body.sessionId) return sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
            const catalog = await ctx.sessionController.modelCatalog()
            const model = String(body.model || (catalog && catalog.default && catalog.default.model) || '')
            const provider = String(body.provider || (catalog && catalog.default && catalog.default.provider) || '')
            if (!provider || !model) return sendJson(res, 400, { ok: false, error: '模型目录为空' })
            const value = await ctx.sessionController.selectModel({
              sessionId: body.sessionId,
              provider,
              model,
              reasoningEffort: body.effort ? String(body.effort) : undefined,
            })
            return sendJson(res, 200, { ok: true, ...value })
          }

          if (action === 'web') {
            const body = await readBody(req)
            if (!body.sessionId) return sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
            if (typeof config.setSessionWeb !== 'function') {
              return sendJson(res, 400, { ok: false, error: '宿主未提供联网开关' })
            }
            const value = config.setSessionWeb(body.sessionId, body.enabled === true)
            return sendJson(res, 200, { ok: true, ...value })
          }

          if (action === 'new') {
            const body = await readBody(req)
            const wsId = await resolveWorkspace()
            const value = await ctx.sessionController.create({
              ...(wsId ? { workspaceId: wsId } : { cwd: chatDir }),
              agentPreset: body.agentPreset || 'chat-zh',
            })
            return sendJson(res, 200, { ok: true, ...value })
          }

          // 图片上传：base64 → attachments.saveImage → 返回持久引用
          if (action === 'upload') {
            const body = await readBody(req, 20 * 1024 * 1024)
            if (!body.data || !body.mediaType) return sendJson(res, 400, { ok: false, error: '缺少图片数据' })
            const attachments = ctx.get ? ctx.get('attachments') : ctx.attachments
            if (!attachments || typeof attachments.saveImage !== 'function') {
              return sendJson(res, 400, { ok: false, error: '宿主不支持附件' })
            }
            const bytes = Buffer.from(String(body.data), 'base64')
            const ref = await attachments.saveImage({
              data: new Uint8Array(bytes),
              mediaType: String(body.mediaType),
              name: body.name ? String(body.name) : undefined,
            })
            return sendJson(res, 200, { ok: true, attachment: ref })
          }

          // 普通文件上传：按会话走 fileUploads.uploadStream，返回与本次 prompt 绑定的收据
          if (action === 'upload-file') {
            const body = await readBody(req, 20 * 1024 * 1024)
            if (!body.data || !body.name) return sendJson(res, 400, { ok: false, error: '缺少文件数据' })
            if (!body.sessionId) return sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
            const uploads = ctx.get ? ctx.get('fileUploads') : ctx.fileUploads
            if (!uploads || typeof uploads.uploadStream !== 'function') {
              return sendJson(res, 400, { ok: false, error: '宿主不支持文件上传' })
            }
            const bytes = Buffer.from(String(body.data), 'base64')
            // PDF / Office：顺手抽出文本，正文里直接给模型看
            let textPreview = ''
            let pdfScanned = false
            const fileName = String(body.name)
            if (/\.(docx|pptx|xlsx)$/i.test(fileName)) {
              try {
                textPreview = extractOfficeText(fileName, bytes, 12000)
              } catch {
                textPreview = ''
              }
            }
            if (/\.pdf$/i.test(fileName)) {
              try {
                textPreview = extractPdfText(bytes, 12000)
                if (textPreview.replace(/\s/g, '').length < 200) {
                  pdfScanned = true
                  textPreview = ''
                }
              } catch {
                textPreview = ''
                pdfScanned = true
              }
            }
            const value = await uploads.uploadStream({
              sessionId: body.sessionId,
              name: String(body.name),
              data: (async function* chunks() {
                yield bytes
              })(),
            })
            return sendJson(res, 200, { ok: true, receiptId: value.receiptId, file: value.file, textPreview, pdfScanned })
          }

          // 读取已存图片（用于回显历史消息里的图片）
          if (action === 'image') {
            const sessionId = url.searchParams.get('sessionId') || ''
            const attachmentId = url.searchParams.get('id') || ''
            if (!sessionId || !attachmentId) return sendJson(res, 400, { ok: false, error: '缺少参数' })
            const local = await readLocalImage(chatDir, attachmentId)
            if (!local) return sendJson(res, 404, { ok: false, error: '找不到图片' })
            return sendJson(res, 200, { ok: true, mediaType: local.mediaType, data: local.data.toString('base64') })
          }

          // 会话菜单：重命名 / 置顶 / 取消置顶 / 删除(归档) / 取消归档
          if (action === 'session-op') {
            const body = await readBody(req)
            if (!body.sessionId) return sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
            const op = String(body.op || '')
            if (op === 'rename') {
              if (!ctx.sessionController || typeof ctx.sessionController.rename !== 'function') {
                return sendJson(res, 400, { ok: false, error: '宿主不支持重命名' })
              }
              const value = await ctx.sessionController.rename({ sessionId: body.sessionId, title: String(body.title || '').slice(0, 120) })
              return sendJson(res, 200, { ok: true, value })
            }
            const workspace = (ctx.get ? ctx.get('workspaceController') : null) || ctx.workspaceController
            if (!workspace) return sendJson(res, 400, { ok: false, error: '宿主缺少 workspaceController' })
            if (op === 'pin') await workspace.pinSession({ sessionId: body.sessionId })
            else if (op === 'unpin') await workspace.unpinSession({ sessionId: body.sessionId })
            else if (op === 'archive') await workspace.archiveSession({ sessionId: body.sessionId })
            else if (op === 'unarchive') await workspace.unarchiveSession({ sessionId: body.sessionId })
            else return sendJson(res, 400, { ok: false, error: '未知操作 ' + op })
            return sendJson(res, 200, { ok: true })
          }

          // 分叉：atSeq 为空则从末尾分叉；text 给了就在新会话里立刻发一条
          // 语义：分支 / 删除该段 / 修改 / 重新生成 都通过它实现
          if (action === 'fork') {
            const body = await readBody(req)
            if (!body.sessionId) return sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
            const raw = await ctx.sessionController.fork({
              sessionId: body.sessionId,
              ...(body.atSeq === undefined ? {} : { atSeq: Number(body.atSeq) }),
            })
            const value = raw && raw.ok !== undefined ? (raw.ok ? raw.value : null) : raw
            if (!value || !value.sessionId) {
              return sendJson(res, 400, { ok: false, error: '分叉失败' })
            }
            if (body.text) {
              await ctx.sessionController.prompt({
                requestId: 'm-' + randomBytes(8).toString('hex'),
                sessionId: value.sessionId,
                mode: 'queue',
                content: [{ type: 'text', text: String(body.text) }],
              }, lifetime.signal)
            }
            return sendJson(res, 200, { ok: true, sessionId: value.sessionId })
          }

          if (action === 'rename') {
            const body = await readBody(req)
            const value = await ctx.sessionController.rename({
              sessionId: body.sessionId,
              title: String(body.title || '').slice(0, 120),
            })
            return sendJson(res, 200, { ok: true, ...value })
          }

          // 增量跟随（SSE）：先发一页快照，再把后续事件推给手机
          if (action === 'follow') {
            const sessionId = url.searchParams.get('sessionId') || ''
            const max = Number(url.searchParams.get('max') || '20')
            res.writeHead(200, {
              'content-type': 'text/event-stream; charset=utf-8',
              'cache-control': 'no-store',
              connection: 'keep-alive',
              'x-accel-buffering': 'no',
            })
            const abort = new AbortController()
            req.on('close', () => abort.abort())
            try {
              const stream = ctx.sessionController.follow(
                { address: { kind: 'session', sessionId }, maxMessages: max, assistantStream: true },
                abort.signal,
              )
              for await (const frame of stream) {
                res.write('data: ' + JSON.stringify(frame) + '\n\n')
              }
            } catch (error) {
              res.write('data: ' + JSON.stringify({ type: 'error', message: String((error && error.message) || error) }) + '\n\n')
            }
            return res.end()
          }

          return sendJson(res, 404, { ok: false, error: 'unknown action: ' + action })
        } catch (error) {
          if (!res.headersSent) {
            sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
          } else {
            try {
              res.end()
            } catch {
              // 忽略
            }
          }
        }
  }

  // 1) 挂在 DSH 自己的 webServer 上（同源访问，桌面浏览器用）
  const disposeRoute = ctx.effect(() =>
    ctx.webServer.register({ kind: 'prefix', path: MOUNT, handler }),
  )

  // 2) 关键：一个固定端口的独立监听，让手机地址不随 DSH 重启变化
  let listening = 0
  let server = null
  const disposeServer = ctx.effect(() => {
    const tryListen = (port, attempt) => {
      const candidate = createServer((req, res) => {
        Promise.resolve(handler(req, res)).catch(() => {
          try {
            res.destroy()
          } catch {
            // 忽略
          }
        })
      })
      candidate.on('error', (error) => {
        if (error && error.code === 'EADDRINUSE' && attempt < 5) {
          tryListen(port + 1, attempt + 1)
          return
        }
        process.stderr.write('[chat-lite] 移动端端口监听失败: ' + String((error && error.message) || error) + '\n')
      })
      candidate.listen(port, '0.0.0.0', () => {
        listening = port
        portRef.value = port
        server = candidate
        process.stderr.write('[chat-lite] 移动端已就绪: http://0.0.0.0:' + port + MOUNT + '/\n')
      })
    }
    tryListen(portRef.value, 0)
    return () => {
      try {
        if (server) server.close()
      } catch {
        // 忽略
      }
    }
  })

  return () => {
    try {
      lifetime.abort()
    } catch {
      // 忽略
    }
    try {
      disposeServer()
    } catch {
      // 忽略
    }
  }
}

/** 极简占位页：等 UI 定稿后替换。 */
function pageHtml() {
  return `<!doctype html>
<html lang="zh"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<title>闲聊</title>
<style>
  body{margin:0;font:15px/1.6 system-ui,-apple-system,"PingFang SC",sans-serif;background:#f5f6f8;color:#1f2329}
  header{padding:14px 16px;background:#fff;border-bottom:1px solid #e5e7eb;font-weight:600}
  main{padding:16px}
  pre{background:#fff;padding:12px;border-radius:10px;overflow:auto;font-size:12px}
  .hint{color:#6b7280;font-size:13px;margin-bottom:12px}
</style></head>
<body>
<header>闲聊 · 移动端（占位页）</header>
<main>
  <p class="hint">后端已连通。下面是 <code>/api/bootstrap</code> 的真实返回，UI 定稿后会替换这一页。</p>
  <pre id="out">加载中…</pre>
</main>
<script>
  fetch('api/bootstrap', { headers: { 'x-chat-lite': '1' } })
    .then(function (r) { return r.json() })
    .then(function (j) { document.getElementById('out').textContent = JSON.stringify(j, null, 2) })
    .catch(function (e) { document.getElementById('out').textContent = '请求失败: ' + e })
</script>
</body></html>`
}