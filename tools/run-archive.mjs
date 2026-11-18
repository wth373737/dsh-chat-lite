// 手动归档：不经过 DSH 界面，直接把闲聊工作区里的会话写进历史库。
//
// 用法：
//   node tools/run-archive.mjs                                  # 用 DSH_HOME 与默认闲聊目录
//   node tools/run-archive.mjs --chat I:\agent\chat --sessions I:\agent\.dsh\sessions
//
// 与插件内定时归档走的是同一段代码（archiveChatSessions），所以它成功即代表 UI 那条路也能成功。

import path from 'node:path'
import process from 'node:process'

import { archiveChatSessions, resolveSessionsRoot } from '../index.js'

function arg(name, fallback) {
  const index = process.argv.indexOf('--' + name)
  return index >= 0 && process.argv[index + 1] !== undefined ? process.argv[index + 1] : fallback
}

const chatDir = arg('chat') || 'I:\\agent\\chat'
const sessionsRoot = arg('sessions') || resolveSessionsRoot({}, process.env)

console.log('chatDir      = ' + chatDir)
console.log('sessionsRoot = ' + (sessionsRoot || '(未找到)'))

if (!sessionsRoot) {
  console.error('找不到会话目录：请传入 --sessions 或设置 DSH_HOME')
  process.exit(1)
}

try {
  const result = await archiveChatSessions({}, chatDir, sessionsRoot)
  console.log('\n结果: ' + JSON.stringify(result))
  if (result.archived > 0) {
    console.log('已写入: ' + path.join(chatDir, '.chat-lite'))
  } else {
    console.log('没有需要归档的新内容（或全部已是最新）')
  }
} catch (error) {
  console.error('失败: ' + String((error && error.message) || error))
  process.exit(1)
}
