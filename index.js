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

import { readFile, writeFile, copyFile, mkdir, rename } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const name = 'chat-lite'

// 只用 webServer 注册路由；不注入 tools，也不注册任何工具。
export const inject = ['webServer', 'agents', 'sessionPersistence']

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
export function extractPrefix(text) {
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
export function replacePrefix(text, prefix, indent) {
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

export function findRowRange(lines, id) {
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

export function readWebEnabled(text) {
  const lines = text.split(/\r?\n/)
  const range = findRowRange(lines, WEB_ROW_ID)
  if (!range) return false
  for (let i = range.start; i < range.end; i++) {
    const match = lines[i].match(/^\s*disabled:\s*(true|false)\s*$/)
    if (match) return match[1] === 'false'
  }
  return true // 没有 disabled 字段 = 启用
}

export function setWebEnabled(text, enabled) {
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

// ── 会话级联网开关（即时生效，不需要重启）──────────────────────────────────
// 工具本身常驻；这里对「单个会话」打限制：
//   1. tools.restrict({deny})  —— 让模型连工具都看不到（优先）
//   2. tools.guard(...)        —— 万一看得到，也拦下调用并给出说明
// 两者都注册在 agent 自己的作用域上，只影响这个会话。
const WEB_TOOLS = ['web_search', 'web_fetch']
const sessionWebOff = new Map()

function setSessionWeb(ctx, sessionId, enabled) {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('缺少 sessionId')
  const existing = sessionWebOff.get(sessionId)
  if (enabled === true) {
    if (existing) {
      existing.lift()
      sessionWebOff.delete(sessionId)
    }
    return { enabled: true }
  }
  if (existing) return { enabled: false }

  const agent = ctx.agents.get(sessionId)
  if (!agent || !agent.ctx || !agent.ctx.tools) throw new Error('会话未运行或拿不到工具上下文')
  const disposers = []
  try {
    disposers.push(agent.ctx.tools.restrict({ deny: WEB_TOOLS }))
  } catch (error) {
    // 某些组合下 restrict 可能不适用，guard 仍然兜底
  }
  try {
    disposers.push(
      agent.ctx.tools.guard((execution) => {
        if (WEB_TOOLS.includes(execution.name)) {
          return '联网搜索已在输入框关闭。请直接凭已有知识回答；确实需要最新信息时，告诉用户你无法联网。'
        }
        return undefined
      }),
    )
  } catch (error) {
    // 忽略：restrict 已生效即可
  }
  sessionWebOff.set(sessionId, {
    lift: () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          // 忽略注销失败
        }
      }
    },
  })
  return { enabled: false, restricted: disposers.length }
}

function readSessionWeb(ctx, sessionId) {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('缺少 sessionId')
  return { enabled: !sessionWebOff.has(sessionId) }
}

// ── 自动归档：把闲聊工作区里的会话写进 <chatDir>/.chat-lite/ ────────────────
// 边界（硬约束）：
//   1. 只处理 header.cwd === chatDir 的会话，别的一律跳过；
//   2. 只写 chatDir/.chat-lite/ 下的文件，不碰工作区其它内容。
const ARCHIVE_DIR = '.chat-lite'
const archiveState = new Map() // sessionId -> revision（本进程内去重）
let archiveBusy = false

export function splitBlocks(blocks) {
  let text = ''
  let thinking = ''
  for (const block of blocks || []) {
    if (block && block.type === 'text' && typeof block.text === 'string') text += block.text
    else if (block && block.type === 'reasoning' && typeof block.text === 'string') thinking += block.text
  }
  return { text, thinking }
}

async function readLines(file) {
  try {
    return (await readFile(file, 'utf8')).split('\n').filter(Boolean)
  } catch {
    return []
  }
}

async function writeAtomic(file, content) {
  const tmp = file + '.tmp'
  await writeFile(tmp, content, 'utf8')
  await rename(tmp, file)
}

const isoOf = (ms) => (ms ? new Date(ms).toISOString() : new Date().toISOString())

/**
 * 把会话事件流映射成历史库格式（纯函数，便于测试）。
 * @returns {{title:string, lines:string[], turns:number, chars:number, thinking:boolean, first:string, inserted:number, updated:number}}
 */
export function eventsToArchive(events) {
  const lines = []
  let title = ''
  let first = ''
  let turns = 0
  let chars = 0
  let thinkingFlag = false
  let inserted = 0
  let updated = 0

  for (const event of events || []) {
    if (typeof event.time === 'number') {
      if (!inserted) inserted = event.time
      if (event.time > updated) updated = event.time
    }
    if (event.type === 'session/title' && event.data && event.data.title) {
      title = String(event.data.title)
      continue
    }
    if (event.type === 'user/message') {
      const { text } = splitBlocks(event.data && event.data.content)
      if (!text.trim()) continue
      turns++
      chars += text.length
      if (!first) first = text.slice(0, 160)
      lines.push(JSON.stringify({ role: 'user', ts: event.time, text, files: [] }))
      continue
    }
    if (event.type === 'assistant/message') {
      const blocks = event.data && event.data.message && event.data.message.content
      const { text, thinking } = splitBlocks(blocks)
      if (!text.trim() && !thinking.trim()) continue
      chars += text.length + thinking.length
      if (thinking.trim()) thinkingFlag = true
      lines.push(JSON.stringify({ role: 'assistant', ts: event.time, thinking, text, files: [] }))
    }
  }

  return { title, lines, turns, chars, thinking: thinkingFlag, first, inserted, updated }
}

async function archiveChatSessions(ctx, chatDir) {
  if (archiveBusy) return { archived: 0, note: 'busy' }
  if (!chatDir) return { archived: 0, note: 'no chatDir' }
  archiveBusy = true
  try {
    const libDir = path.join(chatDir, ARCHIVE_DIR)
    const sessionsDir = path.join(libDir, 'sessions')
    const searchDir = path.join(libDir, 'search')
    await mkdir(sessionsDir, { recursive: true })
    await mkdir(searchDir, { recursive: true })

    const snapshots = await ctx.sessionPersistence.list()
    const targets = snapshots.filter((snap) => snap.header && snap.header.cwd === chatDir)

    const indexFile = path.join(libDir, 'index.jsonl')
    const byId = new Map()
    for (const line of await readLines(indexFile)) {
      try {
        const row = JSON.parse(line)
        if (row && row.id) byId.set(row.id, row)
      } catch {
        // 跳过坏行
      }
    }

    let changed = 0
    for (const snap of targets) {
      const id = String(snap.id)
      const revision = String(snap.revision)
      if (archiveState.get(id) === revision) continue

      const handle = await ctx.sessionPersistence.open(snap.id, 'read')
      let events = []
      try {
        const result = await handle.read(0, snap.eventCount ?? 100000)
        events = result.events || []
      } finally {
        await handle.close()
      }

      const mapped = eventsToArchive(events)
      const { lines, title, first, turns, chars, thinkingFlag } = {
        lines: mapped.lines,
        title: mapped.title,
        first: mapped.first,
        turns: mapped.turns,
        chars: mapped.chars,
        thinkingFlag: mapped.thinking,
      }
      const inserted = mapped.inserted
      const updated = mapped.updated

      const meta = {
        kind: 'meta',
        id,
        title: title || (first ? first.slice(0, 24) : ''),
        inserted: isoOf(inserted),
        updated: isoOf(updated),
      }
      const body = [JSON.stringify(meta), ...lines].join('\n') + '\n'
      await writeAtomic(path.join(sessionsDir, id + '.jsonl'), body)

      byId.set(id, {
        id,
        title: meta.title,
        inserted: meta.inserted,
        updated: meta.updated,
        current: null,
        messages: lines.length,
        turns,
        chars,
        thinking: thinkingFlag,
        files: 0,
        first,
      })
      archiveState.set(id, revision)
      changed++
    }

    if (changed > 0) {
      const rows = [...byId.values()].sort((a, b) =>
        String(b.updated || '').localeCompare(String(a.updated || '')),
      )
      await writeAtomic(indexFile, rows.map((row) => JSON.stringify(row)).join('\n') + '\n')

      // 让全文搜索也能覆盖到新会话：重建 chat 区的 live 分块
      const records = []
      for (const snap of targets) {
        const id = String(snap.id)
        const lines = await readLines(path.join(sessionsDir, id + '.jsonl'))
        const plain = lines
          .map((line) => {
            try {
              const row = JSON.parse(line)
              if (row.kind === 'meta') return ''
              return (row.thinking ? row.thinking + '\n' : '') + (row.text || '')
            } catch {
              return ''
            }
          })
          .filter(Boolean)
          .join('\n')
        for (let at = 0; at < plain.length; at += 1500) {
          records.push(JSON.stringify({ id, t: plain.slice(at, at + 2000) }))
        }
      }
      await writeAtomic(path.join(searchDir, 'live.jsonl'), records.join('\n') + '\n')
    }

    return { archived: changed, total: targets.length }
  } finally {
    archiveBusy = false
  }
}

/**
 * cordis 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ enabled?: boolean }} [config]
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return

  const chatDir = config.chatDir || ''

  // 定时归档：只扫 chatDir 下的会话，只在 <chatDir>/.chat-lite/ 里写文件。
  // 客户端也会在打开历史页时主动 POST 一次，保证"聊完就能看到"。
  if (chatDir) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        archiveChatSessions(ctx, chatDir).catch((error) => {
          process.stderr.write('[chat-lite] archive failed: ' + String(error && error.message) + '\n')
        })
      }, 60000)
      return () => clearInterval(timer)
    })
  }

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
          // 会话级开关：即时生效，不需要重启
          if (req.method === 'GET' && action === 'session-web') {
            const value = readSessionWeb(ctx, url.searchParams.get('sessionId') || '')
            sendJson(res, 200, { ok: true, ...value })
            return
          }
          if (req.method === 'POST' && action === 'session-web') {
            const body = await readJsonBody(req)
            const value = setSessionWeb(ctx, body.sessionId || '', body.enabled === true)
            sendJson(res, 200, { ok: true, ...value, restartRequired: false })
            return
          }
          // 立即归档一次（客户端打开历史页时调用）
          if (req.method === 'POST' && action === 'archive') {
            const value = await archiveChatSessions(ctx, chatDir)
            sendJson(res, 200, { ok: true, chatDir, ...value })
            return
          }
          sendJson(res, 404, { ok: false, error: 'not found' })
        } catch (error) {
          sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
        }
      },
    }),
  )

  // 插件卸载时把还挂着的会话级限制全部解除，避免残留
  ctx.effect(() => () => {
    for (const entry of sessionWebOff.values()) {
      try {
        entry.lift()
      } catch {
        // 忽略
      }
    }
    sessionWebOff.clear()
  })
}
