// 观测 SSE 增量帧的真实到达节奏（排查"延迟+整段输出"）
// 用法: node tools/e2e-stream.mjs <sessionId> [提问文本]
import http from 'node:http'

const sessionId = process.argv[2]
const prompt = process.argv[3] || '用三句话解释一下什么是死锁'
if (!sessionId) {
  console.error('用法: node tools/e2e-stream.mjs <sessionId> [prompt]')
  process.exit(1)
}

const started = Date.now()
const marks = []
let snapshotBytes = 0
let streamFrames = 0
let streamBytes = 0
let events = 0
let firstStreamAt = 0
let lastStreamAt = 0

const req = http.get(
  {
    host: '127.0.0.1',
    port: 8787,
    path: '/chat-lite/m/api/follow?sessionId=' + encodeURIComponent(sessionId) + '&max=30',
    headers: { 'x-chat-lite': '1', accept: 'text/event-stream' },
  },
  (res) => {
    console.log('HTTP', res.statusCode, res.headers['content-type'], ' TTFB=' + (Date.now() - started) + 'ms')
    let buffer = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => {
      buffer += chunk
      let index
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const line = frame.split('\n').find((item) => item.startsWith('data:'))
        if (!line) continue
        const json = line.slice(5).trim()
        const type = (() => {
          try {
            return JSON.parse(json).type
          } catch {
            return 'bad'
          }
        })()
        if (type === 'snapshot') {
          snapshotBytes = json.length
          console.log('  snapshot 到达  ' + (Date.now() - started) + 'ms  体积 ' + Math.round(json.length / 1024) + 'KB')
        } else if (type === 'assistant-stream') {
          streamFrames += 1
          streamBytes += json.length
          if (!firstStreamAt) firstStreamAt = Date.now() - started
          lastStreamAt = Date.now() - started
        } else if (type === 'event') {
          events += 1
        }
      }
    })
  },
)

// 1.2 秒后发送提问
setTimeout(async () => {
  const response = await fetch('http://127.0.0.1:8787/chat-lite/m/api/send', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-chat-lite': '1' },
    body: JSON.stringify({ sessionId, text: prompt }),
  })
  console.log('发送结果:', response.status, (await response.text()).slice(0, 80))
}, 1200)

setTimeout(() => {
  console.log('--- 统计 ---')
  console.log('snapshot 体积:', Math.round(snapshotBytes / 1024) + 'KB')
  console.log('assistant-stream 帧数:', streamFrames, ' 合计', Math.round(streamBytes / 1024) + 'KB')
  console.log('首个增量:', firstStreamAt + 'ms  最后一个增量:', lastStreamAt + 'ms')
  if (streamFrames > 1) {
    console.log('增量跨度:', lastStreamAt - firstStreamAt + 'ms（越大说明确实是逐字流）')
  }
  console.log('普通事件数:', events)
  req.destroy()
  process.exit(0)
}, 45000)
