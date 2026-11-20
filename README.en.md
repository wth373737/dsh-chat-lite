# dsh-chat-lite

**English** | [简体中文](README.md)

A day-to-day chat area for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH): a sidebar panel on the desktop, plus a phone-installable web app over the same conversations.

- **Desktop half** — a chat panel in the DSH sidebar. Conversations live in a dedicated directory, not in your coding workspace, with a self-managed history library (month/day grouping, full-text search, attachments).
- **Phone half** — a standalone page at `/chat-lite/m/` that installs as a PWA (own window, no address bar) and also works outside the LAN through Tailscale or a tunnel.
- **Shared** — send images, text, PDF, Word/Excel/PowerPoint; thinking is streamed live; a message can be copied, edited and re-sent, regenerated, branched or deleted.

## Install

**From GitHub (recommended)** — open **Plugins → + Add plugin** in DSH and enter:

```text
github:wth373737/dsh-chat-lite
```

then **restart DSH once**.

**From a local checkout (development):**

```bash
dsh plugin --profile desktop add link:<absolute path to this directory>
```

Installing inserts two rows: `chat-lite` (the plugin — `index.js` host half, `client.js` desktop half, `mobile.js` mobile host, `ui/` mobile page) and `preset-chat-zh` (the `chat-zh` agent preset). Host code changes need a DSH restart; files under `ui/` take effect immediately.

## Configuration

The `config` of the `chat-lite` row in `cordis.patch.yml`:

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch |
| `chatDir` | `''` | The dedicated chat directory and the home of the history library. **Empty means no auto-archiving and no directory-bound history**, so set it (for example `D:\chat`) right after installing |
| `mobilePort` | `8787` | Fixed port for the mobile page; if it is taken, the next free port is used |
| `publicBaseUrl` | `''` | Public origin (for example `https://xxx.ts.net`) used in the pairing link; empty means the LAN address is used |

`chatDir` should be an empty directory: chat sessions use it as their working directory, and `<chatDir>/.chat-lite/` holds the history library. The plugin writes only that subdirectory.

## Phone access

1. Open `http://<LAN IP>:8787/chat-lite/m/`.
2. Pair once — copy the pairing link from **Settings → chat area → phone access** on the desktop, or open `<address>/chat-lite/m/?t=<token>`.
3. Installing as an app needs HTTPS or localhost; over plain http on a LAN you can only bookmark it. Tailscale is the easy path: `tailscale serve --bg 8787`, then open `https://<machine>.<tailnet>.ts.net/chat-lite/m/` and use **Install app**.

The pairing token lives in `<chatDir>/.chat-lite/auth.json` and survives restarts; device cookies last a year, up to 20 devices, and the settings page can revoke them all.

## Document reading

Uploaded files are extracted on the host and pasted into the message; the model needs no tool:

| Type | How | Status |
|---|---|---|
| text, markdown, JSON, CSV, common code | decoded inline (<200 KB) | works |
| PDF | FlateDecode streams rebuilt by positioning operators | works for text PDFs |
| DOCX / PPTX / XLSX | zip + XML | works |
| scanned PDF | there is no OCR and no PDF renderer, so it says so instead of inventing text | not supported |

## History library

`<chatDir>/.chat-lite/` keeps `index.jsonl` (one metadata row per conversation), `sessions/<id>.jsonl`, `files/<id>/<name>` and chunked search indexes. Import a DeepSeek export with:

```bash
node tools/build-history.mjs --zip <export.zip> --out <chatDir>/.chat-lite
```

The host scans once a minute for sessions whose `cwd` equals `chatDir` and archives them, de-duplicated by revision.

## Known limits

- The official sidebar still lists every session; the isolation only covers this plugin's panel and the mobile page.
- Scanned PDFs cannot be read directly (no OCR, no PDF renderer).
- Chat sessions still carry the host's global tools, but the sandbox refuses them; the persona tells the model not to call tools to read attachments.
- The PWA keeps its own cookie jar: after installing you pair once inside the app.
- Full-text search scans chunks sequentially, so rare words are slower.
- The desktop panel and the mobile page are two front ends; features are not guaranteed to match one for one.

## Security

- The pairing token lives in `<chatDir>/.chat-lite/auth.json`; device keys are stored as sha256.
- Device cookies are `HttpOnly`, `SameSite=Lax`, `Path=<mount point>`, valid for one year.
- `/api/token` and `/api/revoke` only accept loopback requests without `X-Forwarded-For`.
- The mobile port listens on `0.0.0.0`: other devices on the LAN can reach it, but are refused without a cookie.

## Development

```bash
npm run check   # syntax checks, including a UI smoke run under a minimal DOM shim
npm test        # host and extractor unit tests (node:test, no dependencies)
```

## License

MIT