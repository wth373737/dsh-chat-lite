import { readFileSync, writeFileSync } from 'node:fs'

const file = 'ui/app.js'
let source = readFileSync(file, 'utf8')

const start = source.indexOf('async function sendMessage() {')
const end = source.indexOf('async function stopMessage()')
if (start < 0 || end < 0 || end < start) {
  console.log('未找到发送函数区间')
  process.exit(1)
}

const replacement = `async function sendMessage() {
  if (state.readOnly) {
    toast('这是历史记录，点「继续对话」后可以继续聊')
    return
  }
  const text = el.input.value.trim()
  if (!text) return
  if (state.running) return
  el.input.value = ''
  autoGrow()

  try {
    // 编辑重发：从上一段分叉并带上新内容
    if (state.editing) {
      const editing = state.editing
      state.editing = null
      const result = await api('fork', {
        method: 'POST',
        body: { sessionId: state.current.id, atSeq: editing.atSeq, text },
      })
      await loadList()
      await openSession(result.sessionId)
      state.running = true
      renderSend()
      return
    }

    const id = await ensureSession()

    // 1) 先处理文件：文本类内联进正文（模型能读到），其余按会话上传拿收据
    const fileReceipts = []
    let inlineText = ''
    for (const item of state.pendingFiles) {
      const content = decodeTextFile(item.data, item.name)
      if (content !== null) {
        inlineText += '\\n\\n[附件 ' + item.name + ']\\n\`\`\`\\n' + content + '\\n\`\`\`'
        continue
      }
      const uploaded = await api('upload-file', {
        method: 'POST',
        body: { sessionId: id, name: item.name, data: item.data },
      })
      fileReceipts.push({ receiptId: uploaded.receiptId })
    }
    const outgoing = text + inlineText

    // 2) 图片按上传形态提交
    const images = state.pendingImages.map((item) => ({
      mediaType: item.mediaType,
      data: item.data,
      ...(item.name ? { name: item.name } : {}),
    }))

    const baseline = state.messages.filter((item) => item.role === 'assistant').length

    // 3) 乐观显示：不等服务端回显
    state.messages = state.messages.concat([{
      role: 'user',
      text: outgoing,
      images: state.pendingImages.map((item) => ({ localUrl: item.dataUrl })),
      files: state.pendingFiles.map((item) => ({ name: item.name })),
      local: true,
    }])
    state.pendingImages = []
    state.pendingFiles = []
    renderPending()
    state.running = true
    state.liveText = ''
    state.liveThinking = ''
    renderMessages()
    renderSend()

    // 4) 提交并开始轮询兜底
    await api('send', {
      method: 'POST',
      body: { sessionId: id, text: outgoing, images, files: fileReceipts },
    })
    pollForReply(id, baseline)
  } catch (error) {
    state.running = false
    renderSend()
    toast('发送失败：' + (error.message || error))
  }
}

`

source = source.slice(0, start) + replacement + source.slice(end)
writeFileSync(file, source)
console.log('sendMessage 已重写')
