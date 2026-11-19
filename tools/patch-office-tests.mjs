// 追加 Office 文档提取的回归测试（构造最小 zip，不依赖外部文件）
import { readFileSync, writeFileSync } from 'node:fs'

const testFile = 'test/host.test.mjs'
let source = readFileSync(testFile, 'utf8')

if (!source.includes('extractDocxText')) {
  const block = `

// ── Office 文档提取：构造最小 zip 验证 ────────────────────────────
function buildZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, content] of Object.entries(files)) {
    const nameBuf = Buffer.from(name)
    const data = Buffer.from(content)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 8) // stored
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    locals.push(local, nameBuf, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 10) // stored
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(Buffer.concat([central, nameBuf]))
    offset += 30 + nameBuf.length + data.length
  }
  const centralBuf = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(Object.keys(files).length, 8)
  eocd.writeUInt16LE(Object.keys(files).length, 10)
  eocd.writeUInt32LE(centralBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuf, eocd])
}

test('extractDocxText 能抽出 Word 正文', async () => {
  const { extractDocxText } = await import('../office.js')
  const xml = '<?xml version="1.0"?><w:document><w:body>' +
    '<w:p><w:r><w:t>实验课改到周三</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>截止周日 23:59</w:t></w:r></w:p>' +
    '</w:body></w:document>'
  const zip = buildZip({ 'word/document.xml': xml })
  const text = extractDocxText(zip, 1000)
  assert.match(text, /实验课改到周三/)
  assert.match(text, /截止周日 23:59/)
})

test('extractXlsxText 能抽出共享字符串', async () => {
  const { extractXlsxText } = await import('../office.js')
  const shared = '<sst><si><t>姓名</t></si><si><t>张三</t></si></sst>'
  const zip = buildZip({ 'xl/sharedStrings.xml': shared })
  const text = extractXlsxText(zip, 1000)
  assert.match(text, /姓名/)
  assert.match(text, /张三/)
})

test('extractOfficeText 对未知类型返回空串', async () => {
  const { extractOfficeText } = await import('../office.js')
  assert.equal(extractOfficeText('a.txt', Buffer.from('hi'), 100), '')
})
`
  source = source + block
  writeFileSync(testFile, source)
  console.log('tests appended')
} else {
  console.log('tests already present')
}
