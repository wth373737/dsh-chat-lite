// 宿主半边纯函数测试（node --test）
//
// 覆盖：persona 前缀读写、联网开关读写、会话事件 → 历史库格式的映射。
// 这些函数是设置页与自动归档的核心，改坏了会静默写坏用户的 cordis.patch.yml。

import test from 'node:test'
import assert from 'node:assert/strict'

import {
  extractPrefix,
  replacePrefix,
  readWebEnabled,
  setWebEnabled,
  eventsToArchive,
  encodeGroup,
} from '../index.js'

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