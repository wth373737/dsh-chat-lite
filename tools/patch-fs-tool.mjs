import { readFileSync, writeFileSync } from 'node:fs'

// ── 1) 宿主：上传时同时落盘，返回路径 ───────────────────────
const mobileFile = 'mobile.js'
let mobile = readFileSync(mobileFile, 'utf8')
const notes = []

if (!mobile.includes('uploads')) {
  mobile = mobile.replace(
    `            const bytes = Buffer.from(String(body.data), 'base64')
            const value = await uploads.uploadStream({`,
    `            const bytes = Buffer.from(String(body.data), 'base64')
            // 同时落一份到工作区内，让 fs 工具（read）能直接读到
            let savedPath = ''
            try {
              const dir = path.join(chatDir, 'uploads')
              await mkdir(dir, { recursive: true })
              const safeName = String(body.name).replace(/[^\\w.\\u4e00-\\u9fa5-]/g, '_').slice(0, 80)
              const target = path.join(dir, Date.now() + '-' + safeName)
              await writeFile(target, bytes)
              savedPath = target
            } catch {
              savedPath = ''
            }
            const value = await uploads.uploadStream({`,
  )
  mobile = mobile.replace(
    "            return sendJson(res, 200, { ok: true, receiptId: value.receiptId, file: value.file })",
    "            return sendJson(res, 200, { ok: true, receiptId: value.receiptId, file: value.file, savedPath })",
  )
  notes.push('host: save uploads')
}

writeFileSync(mobileFile, mobile)

// ── 2) 前端：二进制文件在正文里给出本地路径 ──────────────────
const file = 'ui/app.js'
let source = readFileSync(file, 'utf8')
source = source.replace(
  `      fileReceipts.push({ receiptId: uploaded.receiptId })
    }
    const outgoing = text + inlineText`,
  `      fileReceipts.push({ receiptId: uploaded.receiptId })
      if (uploaded.savedPath) {
        inlineText += '\\n\\n[附件 ' + item.name + ' 已保存到 ' + uploaded.savedPath +
          '，可以用读取文件的工具查看内容]'
      }
    }
    const outgoing = text + inlineText`,
)
writeFileSync(file, source)
console.log(notes.join('\n') + '\nclient: path hint')

// ── 3) 预设：给 chat-zh 加 fs 工具 ──────────────────────────
const patchFile = 'cordis.patch.yml'
let patch = readFileSync(patchFile, 'utf8')
if (!patch.includes('dsh-tool-fs')) {
  patch = patch.replace(
    '        - id: tool-web',
    `        - id: tool-fs
          name: '@deepseek-ai/dsh-tool-fs'
        - id: tool-fs-search
          name: '@deepseek-ai/dsh-tool-fs-search'
        - id: tool-web`,
  )
  writeFileSync(patchFile, patch)
  console.log('preset: fs tools added')
}
