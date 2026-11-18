// dsh-chat-lite — 宿主侧（Node）
//
// 骨架阶段：只做加载自检，不注册任何工具与服务。
// 权限设计：本插件**不注册工具**，因此闲聊区天然拿不到工作区的工具权限。
//
// 后续要做的事（S2/S3）：
//   - 通过 ctx 曝露同源 HTTP 路由，供 client.js 读写闲聊数据
//   - 闲聊数据落独立目录与独立存储域，不进工作区、不进 session 索引

export const name = 'chat-lite'

// 不注入任何服务：闲聊区不依赖工具子系统。
export const inject = []

/**
 * cordis 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ enabled?: boolean }} [config]
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) {
    return
  }

  // 各个版本的 logger 取法不一致，这里保持防御：拿不到就打 stderr。
  let log = null
  try {
    if (typeof ctx.logger === 'function') {
      log = ctx.logger('chat-lite')
    } else if (typeof ctx.logger === 'object' && ctx.logger !== null && typeof ctx.logger.info === 'function') {
      log = ctx.logger
    }
  } catch {
    log = null
  }

  const line = '[chat-lite] host half loaded (skeleton; no tools registered)'
  if (log && typeof log.info === 'function') {
    log.info(line)
  } else {
    process.stderr.write(`${line}\n`)
  }
}
