import { readFileSync, writeFileSync } from 'node:fs'

// ── 宿主 ──────────────────────────────────────────────────────
const mobileFile = 'mobile.js'
let mobile = readFileSync(mobileFile, 'utf8')
const notes = []

// upload-file 改为按 sessionId 走 uploadStream，返回 receiptId
mobile = mobile.replace(
  /          \/\/ 普通文件上传：走 attachments\.admitEncodedFile[\s\S]*?          \/\/ 读取已存图片（用于回显历史消息里的图片）/,
  `          // 普通文件上传：按会话走 fileUploads.uploadStream，返回与本次 prompt 绑定的收据
          if (action === 'upload-file') {
            const body = await readBody(req, 20 * 1024 * 1024)
            if (!body.data || !body.name) return sendJson(res, 400, { ok: false, error: '缺少文件数据' })
            if (!body.sessionId) return sendJson(res, 400, { ok: false, error: '缺少 sessionId' })
            const uploads = ctx.get ? ctx.get('fileUploads') : ctx.fileUploads
            if (!uploads || typeof uploads.uploadStream !== 'function') {
              return sendJson(res, 400, { ok: false, error: '宿主不支持文件上传' })
            }
            const bytes = Buffer.from(String(body.data), 'base64')
            const value = await uploads.uploadStream({
              sessionId: body.sessionId,
              name: String(body.name),
              data: (async function* chunks() {
                yield bytes
              })(),
            })
            return sendJson(res, 200, { ok: true, receiptId: value.receiptId, file: value.file })
          }

          // 读取已存图片（用于回显历史消息里的图片）`,
)
notes.push('host: uploadStream')

// send 的 files 改为 receiptId
mobile = mobile.replace(
  `            for (const file of files) {
              if (!file || !file.attachmentId) continue
              content.push({
                type: 'file',
                attachment: {
                  attachmentId: String(file.attachmentId),
                  name: file.name ? String(file.name) : undefined,
                  bytes: Number(file.bytes || 0),
                },
              })
            }`,
  `            for (const file of files) {
              if (!file || !file.receiptId) continue
              content.push({ type: 'file', receiptId: String(file.receiptId) })
            }`,
)
notes.push('host: send receipts')

writeFileSync(mobileFile, mobile)

// ── 前端 ──────────────────────────────────────────────────────
const file = 'ui/app.js'
let source = readFileSync(file, 'utf8')

// pickFiles 只暂存，不上传
source = source.replace(
  /\/\*\* 选择普通文件 → 上传宿主 → 记入待发送列表 \*\/[\s\S]*?\n}\n\nfunction renderPending\(\) \{/,
  `/** 选择普通文件：先暂存内容，发送时再按会话上传并取收据。 */
async function pickFiles(input) {
  const files = Array.from(input.files || [])
  input.value = ''
  for (const file of files) {
    if (file.size > 10 * 1024 * 1024) {
      toast('文件超过 10MB，已跳过')
      continue
    }
    try {
      const dataUrl = await readAsDataUrl(file)
      state.pendingFiles.push({
        name: file.name,
        data: dataUrl.slice(dataUrl.indexOf(',') + 1),
      })
      renderPending()
    } catch (error) {
      toast('读取文件失败：' + error.message)
    }
  }
}

function renderPending() {`,
)
notes.push('client: pickFiles local')

// 发送时上传文件并换成收据
source = source.replace(
  `    const files = state.pendingFiles.map((item) => ({
      attachmentId: item.attachmentId,
      name: item.name,
      bytes: item.bytes,
    }))`,
  `    const fileReceipts = []
    for (const item of state.pendingFiles) {
      const uploaded = await api('upload-file', {
        method: 'POST',
        body: { sessionId: id, name: item.name, data: item.data },
      })
      fileReceipts.push({ receiptId: uploaded.receiptId })
    }
    const files = fileReceipts`,
)
notes.push('client: upload at send')

writeFileSync(file, source)
console.log(notes.join('\n'))
