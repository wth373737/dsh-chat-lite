// 归档自检：不启动 DSH，直接检查「磁盘枚举 + 日志解析 + 归档映射」是否正常。
//
// 用法：
//   node tools/archive-check.mjs --sessions <DSH_HOME>/.dsh/sessions --chat <闲聊目录>
//   node tools/archive-check.mjs                      # 用 DSH_HOME 与默认闲聊目录
//
// 输出每个会话会归档成多少条消息、标题、是否含思考，用来判断自动归档到底卡在哪一步。

import path from 'node:path'
import process from 'node:process'

import { encodeGroup, listDiskSessions, readEventsFromFile, readRegisteredSessions, eventsToArchive } from '../index.js'

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const sessionsRoot =
  arg('sessions') ||
  (process.env.DSH_HOME ? path.join(process.env.DSH_HOME, '.dsh', 'sessions') : '')
const chatDir = arg('chat') || 'I:\\agent\\chat'

if (!sessionsRoot) {
  console.error('缺少 --sessions（或设置 DSH_HOME）')
  process.exit(1)
}

console.log('sessionsRoot = ' + sessionsRoot)
console.log('chatDir      = ' + chatDir)
console.log('group 目录   = ' + encodeGroup(chatDir))

const listed = await listDiskSessions(sessionsRoot, chatDir)
const registered = await readRegisteredSessions(sessionsRoot, chatDir)
const sessions = registered ? listed.sessions.filter((item) => registered.has(item.id)) : listed.sessions
console.log(
  '磁盘上有 ' + listed.sessions.length + ' 个会话目录' +
  (registered ? '，工作区登记 ' + registered.size + ' 个' : '（读不到 workspace.json，不过滤）') +
  ' → 实际归档 ' + sessions.length + ' 个\n',
)

let total = 0
for (const session of sessions) {
  try {
    const events = await readEventsFromFile(session.file)
    const mapped = eventsToArchive(events)
    total += mapped.lines.length
    console.log(
      '- ' + session.id +
      '\n  事件 ' + events.length + ' · 消息 ' + mapped.lines.length + ' · 轮 ' + mapped.turns +
      ' · 思考 ' + (mapped.thinking ? '有' : '无') +
      '\n  标题 ' + JSON.stringify(mapped.title || '(空)') +
      '\n  updated ' + new Date(mapped.updated || 0).toISOString(),
    )
  } catch (error) {
    console.log('- ' + session.id + '\n  ✗ ' + String((error && error.message) || error))
  }
}

console.log('\n合计可归档消息: ' + total)
