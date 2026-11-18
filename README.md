# dsh-chat-lite · 闲聊区

给 DeepSeek Harness（DSH）加一个**日常聊天面板**：会话放在专属目录里，不进工作区；自带一套**自管历史库**，支持年月分组、全文搜索、附件与图片；再附一个**闲聊专用 agent preset**（中文思维链、零工具）。

> 面向手机：面板是一栏式布局、大触控目标、单屏导航，官方 Web 端在手机上直接可用。

## 功能

| 能力 | 说明 |
|---|---|
| 会话隔离 | 闲聊会话统一建在专属目录（默认 `I:\agent\chat`，可用 `sessionStorage['chat-lite:cwd']` 覆盖），面板只列该目录下的会话 |
| 新建会话 | `sessions.create({ workspaceId, agentPreset: 'chat-zh' })` 显式创建，保证绑定闲聊 preset |
| 版本切换 | 同一话题的 fork 家族（fork 点 + 它的直接子节点）一键横向切换 |
| 历史库 | 自管目录 `.chat-lite/`：`index.jsonl`（元数据）+ `sessions/<id>.jsonl`（正文）+ `files/<id>/`（附件）+ `search/`（全文分块） |
| 年月分组 | 列表按 `YYYY-MM` 分段（先分页再分组，页内不串月） |
| 搜索 | 即时搜索命中「标题 + 第一句用户提问」并显示命中原因；「全文搜索」按块顺序扫描，**最近优先**，带进度、可中断 |
| 附件与图片 | 图片走 `workspaceFiles.readBytes` → data URL 内联显示；其它附件显示为带大小的标签 |
| 继续对话 | 把一条历史的**完整上文**按权威角色结构注入到一个新会话（`<message role="user|assistant">`），再用 `session.prompt()` 发出 |
| 中文思维链 | preset `chat-zh` 把「内部推理必须用简体中文」写进 persona，并且**不注册任何工具** |

## 安装

```bash
# 在本机 profile 里安装（bundle 方式）
dsh plugin --profile desktop add link:<本目录绝对路径>
```

或在 DSH 里用 `plugin_manager` / 插件市场安装本包（`dsh.bundle.patch` 指向 `cordis.patch.yml`）。

安装后会插入两行：

- `chat-lite` —— 插件本体（`index.js` 宿主半边 + `client.js` 客户端半边）
- `preset-chat-zh` —— agent preset `chat-zh`

> preset 变更需要重启 DSH 才能生效（bundle 补丁在启动时加载）。

## 历史库格式

`.chat-lite/` 目录结构（由导入脚本生成，也可手写）：

```
.chat-lite/
  index.jsonl                 每行一条会话元数据：{id,title,updated,turns,chars,thinking,files,first}
  sessions/<id>.jsonl         第一行 meta，其余每行一条可见消息 {role,text,thinking,files}
  files/<id>/<file_id>_<name> 原始附件
  search/cNNNN.jsonl          全文分块，每行 {id, t}，t ≤ 2000 字符
  search/manifest.json        {"chunks": N}
```

读取全部走官方的 `workspaceFiles.read(sessionId, path, {offset,limit})` / `readBytes()`，因此需要一个 **cwd = 闲聊目录** 的会话作为读取句柄。

另外还有 `search/live.jsonl`：宿主每次归档时重建，只放**闲聊工作区里真实会话**的全文分块，全文搜索会优先扫它。

## 从 DeepSeek 导出包导入

```bash
node tools/build-history.mjs --zip <导出包.zip> --out <闲聊目录>/.chat-lite
```

| 参数 | 说明 |
|---|---|
| `--zip` | DeepSeek 导出的 `deepseek_data-*.zip`（含 `chat_sessions/*.json` 与附件） |
| `--out` | 目标目录，一般是闲聊目录下的 `.chat-lite/` |
| `--no-files` | 跳过附件（只用正文和搜索索引） |
| `--limit N` | 只导入前 N 条（调试用） |

脚本零依赖（`node:fs` / `path` / `zlib`）。

## 自动归档

聊过的新会话会自动进入同一个历史库，**不需要手动导入**：

- 宿主每 60 秒扫描一次，只挑 `cwd === chatDir` 的会话（`chatDir` 在 `cordis.patch.yml` 的插件 config 里）
- 写入 `<chatDir>/.chat-lite/` 下的 `sessions/`、`index.jsonl`、`search/live.jsonl`
- 按 session revision 去重，没变化的会话不重读
- 打开历史页时会立即触发一次，所以「聊完刷新就能看到」

> 边界：只读 `sessionPersistence` 里 cwd 等于闲聊目录的会话，只写该目录下的 `.chat-lite/`，不碰工作区其它内容。

## preset：`chat-zh`

见 `cordis.patch.yml`。要点：

1. **persona 强制中文推理**——思考语言由系统提示词主导，用户消息里的"请用中文思考"基本无效
2. **联网可开关**——`tool-web` 常驻，输入框左侧 🌐 按钮按会话即时禁用（`tools.restrict` + `tools.guard`）；设置页还有全局挂载开关
3. **带 compaction**——"带全部上文"的前提，长对话靠它兜住上下文

## 已知限制

- 官方侧栏仍会列出全部会话；隔离只作用于本面板
- 全文搜索要顺序读约 300 个 0.7MB 的分块，手机上偏慢（已按最近优先排序，常见词前几块就命中）
- 归档只保存文本与思考，暂不含附件原件（导入包里的附件仍会正常保存）

## 许可

MIT
