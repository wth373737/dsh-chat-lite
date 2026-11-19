import { readFileSync, writeFileSync } from 'node:fs'

// ── 宿主 ──────────────────────────────────────────────────────
const mobileFile = 'mobile.js'
let mobile = readFileSync(mobileFile, 'utf8')
const notes = []

// 1) 分页瘦身时保留文件附件引用
if (!mobile.includes("part.type === 'file'")) {
  mobile = mobile.replace(
    `        .filter((part) => part && (part.type === 'text' || (part.type === 'image' && part.attachment)))`,
    `        .filter((part) => part && (part.type === 'text' || ((part.type === 'image' || part.type === 'file') && part.attachment)))`,
  )
  mobile = mobile.replace(
    `          : {
            type: 'image',
            attachment: {
              attachmentId: part.attachment.attachmentId,
              mediaType: part.attachment.mediaType,
              width: part.attachment.width,
              height: part.attachment.height,
            },
          })`,
    `          : part.type === 'image'
            ? {
              type: 'image',
              attachment: {
                attachmentId: part.attachment.attachmentId,
                mediaType: part.attachment.mediaType,
                width: part.attachment.width,
                height: part.attachment.height,
              },
            }
            : {
              type: 'file',
              attachment: {
                attachmentId: part.attachment.attachmentId,
                name: part.attachment.name,
                bytes: part.attachment.bytes,
              },
            })`,
  )
  notes.push('host: keep file parts')
}

// 2) 文件上传接口
if (!mobile.includes("action === 'upload-file'")) {
  mobile = mobile.replace(
    "          // 读取已存图片（用于回显历史消息里的图片）",
    `          // 普通文件上传：走 attachments.admitEncodedFile
          if (action === 'upload-file') {
            const body = await readBody(req, 20 * 1024 * 1024)
            if (!body.data || !body.name) return sendJson(res, 400, { ok: false, error: '缺少文件数据' })
            const attachments = ctx.get ? ctx.get('attachments') : ctx.attachments
            if (!attachments || typeof attachments.admitEncodedFile !== 'function') {
              return sendJson(res, 400, { ok: false, error: '宿主不支持文件附件' })
            }
            const bytes = Buffer.from(String(body.data), 'base64')
            const ref = await attachments.admitEncodedFile({
              data: new Uint8Array(bytes),
              name: String(body.name),
            })
            return sendJson(res, 200, {
              ok: true,
              attachment: { attachmentId: ref.attachmentId, name: ref.name, bytes: ref.bytes },
            })
          }

          // 读取已存图片（用于回显历史消息里的图片）`,
  )
  notes.push('host: upload-file')
}

// 3) send 支持 files
if (!mobile.includes('body.files')) {
  mobile = mobile.replace(
    `            const images = Array.isArray(body.images) ? body.images.filter(Boolean) : []`,
    `            const files = Array.isArray(body.files) ? body.files.filter(Boolean) : []
            const images = Array.isArray(body.images) ? body.images.filter(Boolean) : []`,
  )
  mobile = mobile.replace(
    `              content.push({
                type: 'image',
                mediaType: String(image.mediaType),
                data: String(image.data),
                ...(image.name ? { name: String(image.name) } : {}),
              })`,
    `              content.push({
                type: 'image',
                mediaType: String(image.mediaType),
                data: String(image.data),
                ...(image.name ? { name: String(image.name) } : {}),
              })
            }
            for (const file of files) {
              if (!file || !file.attachmentId) continue
              content.push({
                type: 'file',
                attachment: {
                  attachmentId: String(file.attachmentId),
                  name: file.name ? String(file.name) : undefined,
                  bytes: Number(file.bytes || 0),
                },
              })`,
  )
  notes.push('host: send files')
}

writeFileSync(mobileFile, mobile)

// ── 前端 ──────────────────────────────────────────────────────
const htmlFile = 'ui/index.html'
let html = readFileSync(htmlFile, 'utf8')
if (!html.includes('file-doc')) {
  html = html.replace(
    '    <input id="file-album" type="file" accept="image/*" hidden />',
    '    <input id="file-album" type="file" accept="image/*" hidden />\n    <input id="file-doc" type="file" hidden />',
  )
  html = html.replace(
    '      <button class="sheet-item muted" type="button" disabled data-kind="file">',
    '      <button class="sheet-item" type="button" data-kind="file">',
  )
  writeFileSync(htmlFile, html)
  notes.push('html: file input')
}

const file = 'ui/app.js'
let source = readFileSync(file, 'utf8')

if (!source.includes('fileDoc')) {
  source = source.replace(
    "  fileAlbum: $('file-album'),",
    "  fileAlbum: $('file-album'),\n  fileDoc: $('file-doc'),",
  )
  notes.push('el.fileDoc')
}

if (!source.includes('pendingFiles')) {
  source = source.replace('  pendingImages: [],', '  pendingImages: [],\n  pendingFiles: [],')
  notes.push('state.pendingFiles')
}

// 文件选择 → 上传
if (!source.includes('pickFiles(')) {
  source = source.replace(
    "el.fileCamera.addEventListener('change', () => pickImages(el.fileCamera))",
    `el.fileCamera.addEventListener('change', () => pickImages(el.fileCamera))
el.fileDoc.addEventListener('change', () => pickFiles(el.fileDoc))`,
  )
  source = source.replace(
    'function renderPending() {',
    `/** 选择普通文件 → 上传宿主 → 记入待发送列表 */
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
      const result = await api('upload-file', {
        method: 'POST',
        body: { name: file.name, data: dataUrl.slice(dataUrl.indexOf(',') + 1) },
      })
      state.pendingFiles.push(result.attachment)
      renderPending()
    } catch (error) {
      toast('文件上传失败：' + error.message)
    }
  }
}

function renderPending() {`,
  )
  notes.push('pickFiles')
}

// 预览里同时显示文件
source = source.replace(
  `function renderPending() {
  const list = state.pendingImages
  el.pending.hidden = list.length === 0
  el.pending.innerHTML = list.map((item, index) =>
    '<div class="pending-item"><img src="' + item.dataUrl + '" alt="待发送图片" />' +
    '<button type="button" data-remove="' + index + '" aria-label="移除">×</button></div>',
  ).join('')
}`,
  `function renderPending() {
  const images = state.pendingImages
  const files = state.pendingFiles
  el.pending.hidden = images.length === 0 && files.length === 0
  const imageHtml = images.map((item, index) =>
    '<div class="pending-item"><img src="' + item.dataUrl + '" alt="待发送图片" />' +
    '<button type="button" data-remove="' + index + '" aria-label="移除">×</button></div>',
  ).join('')
  const fileHtml = files.map((item, index) =>
    '<div class="pending-file">📄 ' + escapeHtml(String(item.name || '文件')) +
    '<button type="button" data-remove-file="' + index + '" aria-label="移除">×</button></div>',
  ).join('')
  el.pending.innerHTML = imageHtml + fileHtml
}`,
)

// 移除文件
source = source.replace(
  `el.pending.addEventListener('click', (event) => {
  const button = event.target.closest('[data-remove]')
  if (!button) return
  state.pendingImages.splice(Number(button.dataset.remove), 1)
  renderPending()
})`,
  `el.pending.addEventListener('click', (event) => {
  const imageButton = event.target.closest('[data-remove]')
  if (imageButton) {
    state.pendingImages.splice(Number(imageButton.dataset.remove), 1)
    renderPending()
    return
  }
  const fileButton = event.target.closest('[data-remove-file]')
  if (fileButton) {
    state.pendingFiles.splice(Number(fileButton.dataset.removeFile), 1)
    renderPending()
  }
})`,
)

// 发送时带上文件
source = source.replace(
  "    await api('send', { method: 'POST', body: { sessionId: id, text, images } })",
  `    const files = state.pendingFiles.map((item) => ({
      attachmentId: item.attachmentId,
      name: item.name,
      bytes: item.bytes,
    }))
    await api('send', { method: 'POST', body: { sessionId: id, text, images, files } })
    state.pendingFiles = []`,
)

// 附件面板：文件按钮可用
source = source.replace(
  "  if (button.dataset.kind === 'camera') el.fileCamera.click()",
  "  if (button.dataset.kind === 'camera') el.fileCamera.click()\n  if (button.dataset.kind === 'file') el.fileDoc.click()",
)

writeFileSync(file, source)
console.log(notes.join('\n') || '(no changes)')
