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
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'
import { createServer } from 'node:http'

const MOUNT = '/chat-lite/m'
const UI_DIR = fileURLToPath(new URL('./ui/', import.meta.url))
const COOKIE_NAME = 'chat_lite_dev'
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
  '.png': 'image/png',
  '.webp': 'image/webp',
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
function mobileUrls(req, token, fixedPort) {
  const host = String(req.headers.host || '')
  const hostPort = host.includes(':') ? host.slice(host.lastIndexOf(':') + 1) : '80'
  const port = String(fixedPort || hostPort)
  const urls = lanHosts().map((ip) => 'http://' + ip + ':' + port + MOUNT + '/?t=' + token)
  urls.push('http://' + host + MOUNT + '/?t=' + token)
  return urls
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

  // 解析该目录对应的 workspaceId：这样新建的会话会出现在工作区里（也才会被自动归档看到）
  let workspaceId = null
  const resolveWorkspace = async () => {
    if (workspaceId) return workspaceId
    try {
      const registry = ctx.workspaceRegistry
      if (!registry || typeof registry.list !== 'function') return null
      const list = registry.list() || []
      const wanted = String(chatDir).toLowerCase()
      const found = list.find((item) => item && item.path && String(item.path).toLowerCase() === wanted)
      if (found) workspaceId = found.id || found.workspaceId || null
    } catch {
      workspaceId = null
    }
    return workspaceId
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
        const sub = url.pathname.slice(MOUNT.length)

        try {
          // 页面本身
          if (req.method === 'GET' && (sub === '/' || sub === '')) {
            const token = url.searchParams.get('t')
            if (token) {
              const granted = await auth.redeem(token, req.headers['user-agent'])
              if (!granted) return sendText(res, 403, '配对令牌无效', 'text/plain; charset=utf-8')
              res.setHeader(
                'set-cookie',
                `${COOKIE_NAME}=${encodeURIComponent(granted.cookie)}; Path=${MOUNT}; HttpOnly; SameSite=Lax; Max-Age=31536000`,
              )
              // 去掉 ?t= 再跳一次，避免令牌留在地址栏/历史里
              res.writeHead(302, { location: MOUNT + '/' })
              return res.end()
            }
            return sendFile(res, path.join(UI_DIR, 'index.html'))
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
              urls: mobileUrls(req, state.token, portRef.value),
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
              urls: mobileUrls(req, token, portRef.value),
            })
          }

          if (action === 'bootstrap') {
            const controller = ctx.sessionController
            const listed = await controller.list({})
            const items = (listed.items || []).filter((item) => item.cwd === chatDir && !item.origin)
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
              sessions: items.map((item) => {
                const values = (item.projections && item.projections.values) || {}
                return {
                  id: item.sessionId,
                  title: values.title || values.displayTitle || '',
                  updatedAt: item.updatedAt,
                  running: item.running,
                  blank: item.blank,
                  parentId: item.parentSessionId || null,
                }
              }),
              catalog,
            })
          }

          if (action === 'page') {
            const sessionId = url.searchParams.get('sessionId') || ''
            const beforeSeq = url.searchParams.get('beforeSeq')
            const max = Number(url.searchParams.get('max') || '30')
            const inspected = await ctx.sessionController.inspect(sessionId)
            const events = inspected.events || []
            const lastSeq = events.length ? events[events.length - 1].seq : 0
            const value = await ctx.sessionController.page({
              address: { kind: 'session', sessionId },
              throughSeq: lastSeq,
              ...(beforeSeq ? { beforeSeq: Number(beforeSeq) } : {}),
              maxMessages: max,
            })
            return sendJson(res, 200, { ok: true, ...value })
          }

          if (action === 'send') {
            const body = await readBody(req)
            if (!body.sessionId || !body.text) return sendJson(res, 400, { ok: false, error: '缺少 sessionId/text' })
            const value = await ctx.sessionController.prompt({
              requestId: 'm-' + randomBytes(8).toString('hex'),
              sessionId: body.sessionId,
              mode: 'queue',
              content: [{ type: 'text', text: String(body.text) }],
            })
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
                { address: { kind: 'session', sessionId }, maxMessages: max },
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
      disposeRoute()
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
