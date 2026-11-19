# dsh-chat-lite · 闲聊区

给 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）加一个**日常聊天区**，并附带一个**可安装到手机的独立网页 App**。

- **桌面半边**：DSH 侧栏里的闲聊面板，会话放在专属目录，不进工作区；自带自管历史库（分组、搜索、附件）。
- **移动半边**：`/chat-lite/m/` 下的独立页面，可以装成 PWA（独立窗口、无地址栏），也能通过 Tailscale 在**局域网之外**使用。
- **共用能力**：图片、文本、PDF、Word/Excel/PPT 都能发给模型；思考过程实时显示；消息可复制 / 修改重发 / 重新生成 / 分支 / 删除该段。

---

## 功能一览

### 移动端（本项目重点）

| 能力 | 说明 |
|---|---|
| 会话列表 | DSH 会话 + 自管历史库混排，按 今天 / 昨天 / 7 天 / 30 天 / 更早 分组；底部可继续加载历史 |
| 会话操作 | 行内 `⋯`：重命名、置顶、删除（归档）；置顶以服务端为准 |
| 消息流 | 流式输出、思考折叠、token 用量、工具调用可展开（参数 + 结果） |
| 消息操作 | 复制 / 修改（从上一段分叉重发）/ 朗读（灰置）/ 重新生成 / 分支 / 删除该段 |
| 发送 | 文本 + 最多 4 张图片（自动压到长边 1600、JPEG 0.85）+ 普通文件 |
| 文档阅读 | 文本类内联；**PDF 抽文本重建**；**docx/pptx/xlsx 解 zip+XML 抽文本** |
| 搜索 | `标题` / `全文` 双 tab；全文按分块从新到旧扫，命中够数即停 |
| 历史只读 | 点历史条目进入只读视图，底部「继续对话」基于它新建会话 |
| 离线 | Service Worker 缓存应用壳 + 最近 3 天的接口响应与图片 |
| 外观 | 字号 90%–130% 五档，记住选择；跟随系统深浅色 |
| 连接 | 一次性配对（令牌换设备 Cookie，一年有效）；设置面板可查看设备数、访问地址、清缓存、重新配对 |

### 桌面面板

会话隔离、新建会话（绑定 `chat-zh`）、fork 版本切换、历史库年月分组、全文搜索、附件内联、继续对话。

---

## 安装

```bash
dsh plugin --profile desktop add link:<本目录绝对路径>
```

或在 DSH 里用 `plugin_manager` / 插件市场安装（`dsh.bundle.patch` 指向 `cordis.patch.yml`）。

安装后插入两行：

- `chat-lite` —— 插件本体（`index.js` 桌面宿主 + `client.js` 桌面客户端 + `mobile.js` 移动端宿主 + `ui/` 移动端页面）
- `preset-chat-zh` —— agent preset `chat-zh`

> 宿主代码改动需要重启 DSH；`ui/` 下的前端文件是即时生效的（资源 URL 会带内容版本号）。

---

## 移动端接入

### 1. 打开页面

```
http://<本机局域网IP>:8787/chat-lite/m/
```

端口由 `mobilePort` 配置（默认 8787）。**这个端口是固定的**——DSH 自身每次启动端口都会变，所以移动页面单独监听。

### 2. 配对

首次访问需要配对一次：

- 桌面端 **设置 → 闲聊区 → 手机访问** 里复制配对链接
- 或者在浏览器打开 `<地址>/chat-lite/m/?t=<令牌>`，会自动换 Cookie 并跳转
- 已装成 PWA 时，App 内会显示「连接这台设备」输入框，粘贴链接即可

令牌保存在 `<chatDir>/.chat-lite/auth.json`，**重启不影响**；设备 Cookie 有效期一年。设备上限 20 台，可随时全部撤销换发新令牌。

### 3. 装成 App（PWA）

浏览器要求 **HTTPS 或 localhost** 才允许"安装"。局域网 http 只能加书签。推荐用 Tailscale：

```powershell
tailscale status                     # 确认已登录，拿到 <机器名>.<tailnet>.ts.net
tailscale serve --bg 8787            # 把本地 8787 挂到 https://<机器名>.ts.net/
```

然后在 tailnet 后台 DNS 页确认启用 **HTTPS Certificates**。之后：

1. 手机 Chrome 打开 `https://<机器名>.ts.net/chat-lite/m/`
2. 菜单 → **安装应用**
3. 得到独立窗口、无地址栏的 App

把对外域名填进插件配置的 `publicBaseUrl`，配对链接里就会直接给出这个地址。

> `tailscale serve` 会加 `X-Forwarded-For`；本项目把带该头的请求**一律当外部**处理，令牌接口只对本机回环开放。

### 备用挂载点

`/chat-lite/app/` 与 `/chat-lite/m/` 是同一套代码、不同路径。用途：Service Worker 的作用域是**按路径**绑定的，若某个作用域卡在旧缓存里，换另一个路径即可拿到全新作用域（Cookie 也是按路径存的，需要重新配对一次）。

---

## 配置

`cordis.patch.yml` 里 `chat-lite` 行的 `config`：

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `true` | 是否启用 |
| `chatDir` | `I:\agent\chat` | 闲聊会话目录，也是历史库所在目录 |
| `mobilePort` | `8787` | 移动端固定端口；被占用时自动 +1 顺延 |
| `publicBaseUrl` | `''` | 对外域名（如 `https://xxx.ts.net`）；填了配对链接就用它 |

---

## 文档读取

移动端上传的文件由**宿主直接抽取文字**，拼进消息正文，模型不需要任何工具：

| 类型 | 手段 | 状态 |
|---|---|---|
| `.txt .md .json .csv .log` 及常见代码后缀 | 直接解码内联（<200KB） | ✅ |
| `.pdf` | zlib 解压 FlateDecode 流，按定位操作符重建行 | ✅ 文字版可靠 |
| `.docx` | zip + `word/document.xml` | ✅ |
| `.pptx` | zip + `ppt/slides/slideN.xml` | ✅ |
| `.xlsx` | zip + `sharedStrings.xml` + 工作表 | ✅ |
| 扫描版 PDF | 抽不到文字（<200 字）时判定为扫描件，提示用户发截图 | ⚠️ 本机无 OCR/PDF 渲染 |

图片走官方附件通道，模型可直接看图（已验证）。其它二进制文件仍会作为附件上传并保留记录。

---

## 自管历史库

```
<chatDir>/.chat-lite/
  index.jsonl                 每行一条元数据：{id,title,inserted,updated,messages,turns,chars,first,source}
  sessions/<id>.jsonl         第一行 meta，其后每行 {role,ts,text,thinking,files}
  files/<id>/<name>           导入包里的原始附件
  search/cNNNN.jsonl          全文分块，每行 {id,t}，t ≤ 2000 字符
  search/live.jsonl           宿主归档时重建，只放闲聊目录里真实会话的分块
  search/manifest.json        {"chunks": N}
```

导入 DeepSeek 导出包：

```bash
node tools/build-history.mjs --zip <导出包.zip> --out <chatDir>/.chat-lite
```

| 参数 | 说明 |
|---|---|
| `--zip` | `deepseek_data-*.zip`（含 `chat_sessions/*.json` 与附件） |
| `--out` | 目标目录，一般是 `<chatDir>/.chat-lite` |
| `--no-files` | 跳过附件 |
| `--limit N` | 只导入前 N 条 |

自动归档：宿主每 60 秒扫描 `cwd === chatDir` 的会话，写入历史库与 `search/live.jsonl`；按 revision 去重。

---

## preset：`chat-zh`

- **persona 强制中文推理**：思考语言由系统提示词主导
- **人设禁止乱试工具**：附件内容已在对话里，不要为读附件调用工具
- **联网可开关**：`tool-web` 常驻，输入框左侧 🌐 按钮按会话即时禁用（`tools.restrict` + `tools.guard`）
- **带 compaction**：长对话靠它兜住上下文

> 实测：给闲聊预设挂 `dsh-univer-office` 会让模型在附件上反复空转（`win_bash` → `terminal_open` → `univer_*` → `windows_desktop`），因此**不挂**该插件，文档一律由宿主抽取。

---

## 开发与测试

```bash
npm run check   # 语法检查（含 UI 冒烟：用最小 DOM 桩执行 ui/app.js）
npm test        # 宿主与提取器的单元测试（node:test，零依赖）
```

`npm run check` 里的 `tools/check-ui.mjs` 会用最小 DOM 桩把 `ui/app.js` 真跑一遍，能抓到「函数被删」「元素引用不存在」「顶层抛错」这类会导致白屏的问题——这类 bug 在本项目里发生过不止一次。

`test/host.test.mjs` 覆盖：

- persona 前缀读写往返、联网开关读写、事件流 → 历史库映射
- 目录编码与注册表读取、归档写入（真实 zstd 帧、幂等）
- 设备认证（含模拟重启后的令牌/Cookie 有效性、撤销）
- PDF 文本提取（构造最小 PDF）、docx / xlsx 提取（构造最小 zip）

端到端脚本（需要运行中的 DSH）：

```bash
node tools/e2e-pdf.mjs  <file.pdf>     # 上传 → 抽文本 → 提问 → 打印模型回答
node tools/e2e-docx.mjs <file.docx>
```

GitHub Actions（`.github/workflows/ci.yml`）在每次 push 上跑 `check` 与 `test`。

---

## 已知限制

- **官方侧栏仍会列出全部会话**：隔离只作用于本插件的面板与移动页面
- **扫描版 PDF 不能直读**：本机没有 OCR，也没有 PDF→图片渲染器；会提示用户发截图（图片模型能看）
- **闲聊会话仍带着宿主全局工具**（`win_bash`、`terminal_open` 等），但沙箱会拒绝执行；已通过人设禁止为读附件调用工具
- **PWA 的 Cookie 与浏览器分开**：装成 App 后需要在 App 内再配对一次；Cookie 按 origin 存，换域名/路径都要重配
- **全文搜索是顺序扫分块**：常见词前几块就命中，生僻词会慢一些
- **桌面面板与移动页面是两套前端**：功能不保证完全对齐（移动端支持历史只读 + 继续对话，桌面面板走 fork 版本切换）

## 安全说明

- 配对令牌存在 `<chatDir>/.chat-lite/auth.json`，用 sha256 存设备密钥
- 设备 Cookie：`HttpOnly`、`SameSite=Lax`、`Path=<挂载点>`、一年有效
- `/api/token`、`/api/revoke` 仅接受**本机回环**且**不带 `X-Forwarded-For`** 的请求
- 令牌可通过设置页「撤销全部设备并换令牌」一键失效
- 移动端口监听 `0.0.0.0`：局域网内其它设备可访问，但没有 Cookie 会被拒绝

## 许可

MIT
