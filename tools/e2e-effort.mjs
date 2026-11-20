// 验证：手机上改思考强度，不应该改变全局默认模型档位
// 用法: node tools/e2e-effort.mjs
const BASE = 'http://127.0.0.1:8787/chat-lite/m/api'
const headers = { 'content-type': 'application/json', 'x-chat-lite': '1' }

const call = async (path, body) => {
  const response = await fetch(BASE + path, {
    method: body ? 'POST' : 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await response.json()
  if (!json.ok) throw new Error(path + ' → ' + JSON.stringify(json).slice(0, 200))
  return json
}

const before = await call('/status')
console.log('改之前的全局默认:', JSON.stringify(before.defaultSelection))

const created = await call('/new', { effort: 'high' })
console.log('新建会话:', created.sessionId, '（已按 high 应用）')

// 模拟手机端改成与默认不同的档位（默认 high 时改成 low）
const target = before.defaultSelection && before.defaultSelection.reasoningEffort === 'low' ? 'high' : 'low'
await call('/effort', { sessionId: created.sessionId, effort: target })
console.log('已把该会话档位改为 ' + target)

await new Promise((resolve) => setTimeout(resolve, 300))

const after = await call('/status')
console.log('改之后的全局默认:', JSON.stringify(after.defaultSelection))

const same = JSON.stringify(before.defaultSelection) === JSON.stringify(after.defaultSelection)
if (!same) {
  console.error('✗ 全局默认被改动了')
  process.exit(1)
}
console.log('✓ 全局默认未变；档位只作用在该会话')
