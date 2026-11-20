import { readFileSync, writeFileSync } from 'node:fs'

const file = 'mobile.js'
let source = readFileSync(file, 'utf8')
const notes = []

// 1) 注入一个「只改会话、不动全局默认」的帮助函数
if (!source.includes('applySessionEffort')) {
  const block = `
/**
 * 把思考强度/模型应用到单个会话，并把被 selectModel 顺带改掉的
 * 全局默认模型档位恢复原状——否则手机上调一次会影响桌面新开的会话。
 */
async function applySessionEffort(ctx, sessionId, effort) {
  const defaults = ctx.get ? ctx.get('agentDefaultModel') : ctx.agentDefaultModel
  const previous = defaults && typeof defaults.currentSelection === 'function'
    ? defaults.currentSelection()
    : null

  const catalog = await ctx.sessionController.modelCatalog()
  const model = String((catalog && catalog.default && catalog.default.model) || '')
  const provider = String((catalog && catalog.default && catalog.default.provider) || '')
  if (!provider || !model) throw new Error('模型目录为空')

  const value = await ctx.sessionController.selectModel({
    sessionId,
    provider,
    model,
    ...(effort ? { reasoningEffort: String(effort) } : {}),
  })

  // selectModel 内部是 void saveSelection(...)，等它落地再改回去
  if (defaults && previous) {
    await new Promise((resolve) => setTimeout(resolve, 60))
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const now = defaults.currentSelection()
      if (now.reasoningEffort === previous.reasoningEffort && now.model === previous.model && now.provider === previous.provider) break
      try {
        await defaults.saveSelection(previous)
      } catch {
        // 忽略：恢复失败不影响会话本身的档位
      }
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }

  return value
}

`
  source = source.replace('async function sendFile(res, file) {', block + 'async function sendFile(res, file) {')
  notes.push('helper applySessionEffort')
}

// 2) /api/effort 改用它
source = source.replace(
  /          if \(action === 'effort'\) \{[\s\S]*?\n          \}\n\n          if \(action === 'web'\) \{/,
  `          if (action === 'effort') {
            const body = await readBody(req)
            if (!body.sessionId) return sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
            try {
              const value = await applySessionEffort(ctx, body.sessionId, body.effort)
              return sendJson(res, 200, { ok: true, ...value })
            } catch (error) {
              return sendJson(res, 400, { ok: false, error: String((error && error.message) || error) })
            }
          }

          if (action === 'web') {`,
)
notes.push('/api/effort')

// 3) /api/new：创建后按请求的档位应用（仅该会话）
source = source.replace(
  `            const created = await ctx.sessionController.create({`,
  `            const newBody = await readBody(req)
            const created = await ctx.sessionController.create({`,
)
source = source.replace(
  `            return sendJson(res, 200, { ok: true, sessionId: created.sessionId })`,
  `            if (newBody && newBody.effort) {
              try {
                await applySessionEffort(ctx, created.sessionId, newBody.effort)
              } catch {
                // 档位应用失败不影响建会话
              }
            }
            return sendJson(res, 200, { ok: true, sessionId: created.sessionId })`,
)
notes.push('/api/new effort')

// 4) /api/fork：同样应用档位
source = source.replace(
  `            if (body.text) {
              await ctx.sessionController.prompt({`,
  `            if (body.effort) {
              try {
                await applySessionEffort(ctx, value.sessionId, body.effort)
              } catch {
                // 忽略
              }
            }
            if (body.text) {
              await ctx.sessionController.prompt({`,
)
notes.push('/api/fork effort')

// 5) /api/status 暴露当前全局默认，便于排查"串味"
source = source.replace(
  `              chatDir,
              mobilePort: portRef.value,`,
  `              chatDir,
              mobilePort: portRef.value,
              defaultSelection: (() => {
                const service = ctx.get ? ctx.get('agentDefaultModel') : ctx.agentDefaultModel
                try {
                  return service && typeof service.currentSelection === 'function' ? service.currentSelection() : null
                } catch {
                  return null
                }
              })(),`,
)
notes.push('/api/status default')

writeFileSync(file, source)
console.log(notes.join('\n'))
