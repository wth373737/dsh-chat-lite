// 宿主半边纯函数测试（node --test）
//
// 覆盖：persona 前缀读写、联网开关读写、会话事件 → 历史库格式的映射。
// 这些函数是设置页与自动归档的核心，改坏了会静默写坏用户的 cordis.patch.yml。

import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { zstdCompressSync } from 'node:zlib'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
  extractPrefix,
  replacePrefix,
  readWebEnabled,
  setWebEnabled,
  eventsToArchive,
  encodeGroup,
  resolveSessionsRoot,
  writeArchiveFiles,
  readEventsFromFile,
} from '../index.js'

import { MobileAuth } from '../mobile.js'

const FIXTURE = `# 补丁
- insert:
    - id: preset-x
      config:
        plugins:
          - id: persona
            name: '@deepseek-ai/dsh-persona'
            config:
              complete: true
              prefix: |
                第一行
                第二行

                第四行
          - id: time-context
            name: '@deepseek-ai/dsh-time-context'
          - id: tool-web
            name: '@deepseek-ai/dsh-tool-web'
            disabled: false
            config:
              fetch: true
`

test('extractPrefix 取出块标量并识别缩进', () => {
  const parsed = extractPrefix(FIXTURE)
  assert.ok(parsed, '应能解析出 prefix')
  assert.equal(parsed.prefix, '第一行\n第二行\n\n第四行')
  assert.equal(parsed.indent, 16)
})

test('replacePrefix 往返后内容不变（不破坏缩进与空行）', () => {
  const parsed = extractPrefix(FIXTURE)
  const roundTrip = replacePrefix(FIXTURE, parsed.prefix, parsed.indent)
  const again = extractPrefix(roundTrip)
  assert.equal(again.prefix, parsed.prefix)
})

test('replacePrefix 写入新内容并保留后续 key', () => {
  const parsed = extractPrefix(FIXTURE)
  const next = replacePrefix(FIXTURE, '新的第一行\n\n新的第三行', parsed.indent)
  assert.equal(extractPrefix(next).prefix, '新的第一行\n\n新的第三行')
  assert.ok(next.includes("id: time-context"), '后续插件行不能丢')
  assert.ok(next.includes('disabled: false'), '其它块不能被改动')
})

test('readWebEnabled 读到 disabled:false 即为开启', () => {
  assert.equal(readWebEnabled(FIXTURE), true)
})

test('setWebEnabled 开关往返', () => {
  const off = setWebEnabled(FIXTURE, false)
  assert.equal(readWebEnabled(off), false)
  assert.ok(/disabled: true/.test(off))
  const on = setWebEnabled(off, true)
  assert.equal(readWebEnabled(on), true)
  assert.equal(on, FIXTURE, '开关往返应回到原文')
})

test('setWebEnabled 找不到 tool-web 时抛错', () => {
  assert.throws(() => setWebEnabled('# empty\n', true), /tool-web/)
})

test('eventsToArchive 映射用户/助手消息与思考', () => {
  const events = [
    { type: 'session', time: 1000 },
    { type: 'user/message', time: 1100, data: { content: [{ type: 'text', text: '你好' }] } },
    {
      type: 'assistant/message',
      time: 1200,
      data: {
        message: {
          content: [
            { type: 'reasoning', text: '想一想' },
            { type: 'text', text: '你也好' },
          ],
        },
      },
    },
    { type: 'tool/call', time: 1300, data: { name: 'web_search' } },
    { type: 'tool/result', time: 1400, data: {} },
    { type: 'session/title', time: 1500, data: { title: '打招呼' } },
  ]

  const mapped = eventsToArchive(events)
  assert.equal(mapped.title, '打招呼')
  assert.equal(mapped.turns, 1)
  assert.equal(mapped.lines.length, 2)
  assert.equal(mapped.thinking, true)
  assert.equal(mapped.chars, '你好'.length + '想一想'.length + '你也好'.length)
  assert.equal(mapped.first, '你好')
  assert.equal(mapped.inserted, 1000)
  assert.equal(mapped.updated, 1500)

  const first = JSON.parse(mapped.lines[0])
  assert.deepEqual(first, { role: 'user', ts: 1100, text: '你好', files: [] })
  const second = JSON.parse(mapped.lines[1])
  assert.equal(second.role, 'assistant')
  assert.equal(second.thinking, '想一想')
  assert.equal(second.text, '你也好')
})

test('eventsToArchive 跳过空消息与纯工具事件', () => {
  const events = [
    { type: 'user/message', time: 10, data: { content: [{ type: 'text', text: '   ' }] } },
    { type: 'tool/result', time: 20, data: {} },
    { type: 'assistant/message', time: 30, data: { message: { content: [] } } },
  ]
  const mapped = eventsToArchive(events)
  assert.equal(mapped.lines.length, 0)
  assert.equal(mapped.turns, 0)
  assert.equal(mapped.thinking, false)
  assert.equal(mapped.title, '')
})

test('eventsToArchive 容忍空输入', () => {
  const mapped = eventsToArchive([])
  assert.deepEqual(mapped.lines, [])
  assert.equal(mapped.turns, 0)
})

test('encodeGroup 按分段编码工作区目录名', () => {
  assert.equal(encodeGroup('I:\\agent\\chat'), '--I-agent-chat--')
  assert.equal(encodeGroup('I:/agent/chat'), '--I-agent-chat--')
  assert.equal(encodeGroup('/home/u/chat'), '--home-u-chat--')
})
test('resolveSessionsRoot 兼容 DSH_HOME 是否已含 .dsh', () => {
  // 有 config.sessionsRoot 时直接采用
  assert.equal(resolveSessionsRoot({ sessionsRoot: 'X:/s' }, {}), 'X:/s')
  // 没有 DSH_HOME 时返回空串（由调用方退回服务路径）
  assert.equal(resolveSessionsRoot({}, {}), '')
})
test('writeArchiveFiles 端到端：写会话文件、索引、全文分块，且按 revision 幂等', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'chat-lite-test-'))
  const sessionDir = path.join(root, 'sessions', '--x--', 'session-abc')
  await mkdir(sessionDir, { recursive: true })

  const events = [
    { type: 'session', time: 1000, data: { cwd: root } },
    { type: 'user/message', time: 1100, data: { content: [{ type: 'text', text: '你好' }] } },
    {
      type: 'assistant/message',
      time: 1200,
      data: { message: { content: [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '你也好' }] } },
    },
    { type: 'session/title', time: 1300, data: { title: '打招呼' } },
  ]
  // 两个独立 zstd 帧拼接，模拟真实日志
  const frame1 = zstdCompressSync(Buffer.from(JSON.stringify(events[0]) + '\n' + JSON.stringify(events[1]) + '\n'))
  const frame2 = zstdCompressSync(Buffer.from(JSON.stringify(events[2]) + '\n' + JSON.stringify(events[3]) + '\n'))
  const logFile = path.join(sessionDir, 'session.v4.jsonl.zstd')
  await writeFile(logFile, Buffer.concat([frame1, frame2]))

  const libDir = path.join(root, '.chat-lite')
  const byId = new Map()
  const state = new Map()
  const targets = [{ id: 'session-abc', revision: 'r1', file: logFile }]

  const first = await writeArchiveFiles({
    libDir,
    targets,
    byId,
    state,
    readEvents: (target) => readEventsFromFile(target.file),
  })
  assert.equal(first.changed, 1)

  const rows = (await readFile(path.join(libDir, 'sessions', 'session-abc.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.equal(rows.length, 3)
  assert.equal(rows[0].kind, 'meta')
  assert.equal(rows[0].title, '打招呼')
  assert.equal(rows[1].role, 'user')
  assert.equal(rows[1].text, '你好')
  assert.equal(rows[2].role, 'assistant')
  assert.equal(rows[2].thinking, '思考')
  assert.equal(rows[2].text, '你也好')

  const index = (await readFile(path.join(libDir, 'index.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.equal(index.length, 1)
  assert.equal(index[0].id, 'session-abc')
  assert.equal(index[0].turns, 1)
  assert.equal(index[0].thinking, true)

  const live = (await readFile(path.join(libDir, 'search', 'live.jsonl'), 'utf8'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
  assert.ok(live.some((row) => row.id === 'session-abc' && row.t.includes('你也好')))

  const again = await writeArchiveFiles({
    libDir,
    targets,
    byId,
    state,
    readEvents: (target) => readEventsFromFile(target.file),
  })
  assert.equal(again.changed, 0, '同一 revision 不应重复写')
})
test('MobileAuth：令牌可换设备 Cookie，重启后仍有效，撤销后失效', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'chat-lite-auth-'))
  const chatDir = path.join(root, 'chat')

  const auth = new MobileAuth(chatDir)
  const token = await auth.token()
  assert.equal(typeof token, 'string')
  assert.ok(token.length >= 32, '令牌应当足够长')

  // 令牌错误 → 拒绝
  assert.equal(await auth.redeem('wrong-token', 'x'), null)

  const granted = await auth.redeem(token, '测试手机')
  assert.ok(granted && granted.cookie.includes('.'), '应返回设备 Cookie')
  assert.ok(await auth.verify(granted.cookie), 'Cookie 校验通过')
  assert.equal(await auth.verify('deadbeef.wrong'), null)

  // 模拟重启：新实例读同一个 auth.json，令牌与设备都应还在
  const restarted = new MobileAuth(chatDir)
  assert.equal(await restarted.token(), token, '重启后令牌不变')
  assert.ok(await restarted.verify(granted.cookie), '重启后设备 Cookie 仍有效')

  // 撤销：换新令牌，旧 Cookie 失效
  const fresh = await restarted.revokeAll()
  assert.notEqual(fresh, token)
  assert.equal(await restarted.verify(granted.cookie), null)
})
// ── PDF 文本提取：构造一个最小 PDF，验证能抽出文字 ──────────────────
test('extractPdfText 能从压缩流里抽出文字', async () => {
  const { extractPdfText } = await import('../mobile.js')
  const { deflateSync } = await import('node:zlib')

  const content = 'BT /F1 12 Tf 72 720 Td (Hello PDF 42) Tj ET'
  const compressed = deflateSync(Buffer.from(content, 'latin1'))

  const parts = []
  parts.push(Buffer.from('%PDF-1.4\n', 'latin1'))
  parts.push(Buffer.from('1 0 obj\n<< /Length ' + compressed.length + ' /Filter /FlateDecode >>\nstream\n', 'latin1'))
  parts.push(compressed)
  parts.push(Buffer.from('\nendstream\nendobj\n%%EOF\n', 'latin1'))
  const pdf = Buffer.concat(parts)

  const text = extractPdfText(pdf, 1000)
  assert.match(text, /Hello PDF 42/)
})

test('extractPdfText 对无文字内容返回空串', async () => {
  const { extractPdfText } = await import('../mobile.js')
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< >>\nstream\nendstream\nendobj\n%%EOF\n', 'latin1')
  assert.equal(extractPdfText(pdf, 1000).trim(), '')
})

// ── Office 文档提取：构造最小 zip 验证 ────────────────────────────
function buildZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name)
    const data = Buffer.from(content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 10) // stored
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, nameBuf]))
    offset += 30 + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

test('extractDocxText 能抽出 Word 正文', async () => {
  const { extractDocxText } = await import('../office.js')
  const xml = '<?xml version="1.0"?><w:document><w:body>' +
    '<w:p><w:r><w:t>实验课改到周三</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>截止周日 23:59</w:t></w:r></w:p>' +
    '</w:body></w:document>'
  const zip = buildZip({ 'word/document.xml': xml })
  const text = extractDocxText(zip, 1000)
  assert.match(text, /实验课改到周三/)
  assert.match(text, /截止周日 23:59/)
})

test('extractXlsxText 能抽出共享字符串', async () => {
  const { extractXlsxText } = await import('../office.js')
  const shared = '<sst><si><t>姓名</t></si><si><t>张三</t></si></sst>'
  const zip = buildZip({ 'xl/sharedStrings.xml': shared })
  const text = extractXlsxText(zip, 1000)
  assert.match(text, /姓名/)
  assert.match(text, /张三/)
})

test('extractOfficeText 对未知类型返回空串', async () => {
  const { extractOfficeText } = await import('../office.js')
  assert.equal(extractOfficeText('a.txt', Buffer.from('hi'), 100), '')
})
