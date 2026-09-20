# workbuddy-openai-proxy

**Turn your WorkBuddy / CodeBuddy (Tencent) account quota into a local OpenAI- and
Anthropic-compatible API** — for Cursor, Claude Code, Codex CLI, Cherry Studio, or any
OpenAI-compatible client.

Covers **both editions**: China (`copilot.tencent.com`) and International
(`codebuddy.ai` / `workbuddy.ai`).

[中文文档](README.md) · [Features](#features) · [Quick start](#quick-start) · [FAQ](#faq)

![Node](https://img.shields.io/badge/Node.js-%E2%89%A5%2018-3c873a?logo=node.js&logoColor=white)
![Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![Tests](https://img.shields.io/badge/tests-363%20passing-brightgreen)
![Platform](https://img.shields.io/badge/tested%20on-Windows%20%C2%B7%20Node%2024-blue)
![License](https://img.shields.io/badge/license-MIT-blue)

<!-- Demo GIF goes here: docs/demo.gif (< 2MB) -->

---

## Why this one

There are several proxies for this service. This one is built around three constraints:

**1. Zero dependencies — literally.**

`dependencies` and `devDependencies` in `package.json` are both **empty**. All ~4,200 lines
run on Node built-ins alone. No `npm install`, no `node_modules`, no Docker, no supply-chain
surface. You can read the whole thing before running it.

Most tools in this space ask you to pull hundreds of transitive packages first. That's the
difference.

**2. It doesn't touch anything outside its own folder.**

Credentials, config, and logs all live inside the project directory. Login uses the official
OAuth device flow — the same one the official CLI uses. It does **not** read your WorkBuddy
client's local config, your browser profile, or any file outside its own directory.

**3. It stays on loopback.**

Binds `127.0.0.1:8788` only, with API-key auth, plus origin/Host validation on the console to
block cross-site token theft and DNS rebinding. See [Security](#security).

---

## Quick start

**Requires Node.js ≥ 18. Nothing else.**

```bash
git clone https://github.com/yuan240324/workbuddy-openai-proxy.git
cd workbuddy-openai-proxy
node server.mjs
```

Then open <http://127.0.0.1:8788/console>, click **Login**, authorize in the browser, done.

Point your client at:

| | |
|---|---|
| Base URL | `http://127.0.0.1:8788/v1` |
| API Key | the `apiKey` value in `config.json` (printed at startup, masked) |
| Model | any ID from `GET /v1/models`, or `default` |

### Platform notes

The core is pure Node built-ins with no native modules, so it should run anywhere Node does.
**It has only been tested on Windows + Node 24** — macOS/Linux reports welcome.

| | Windows | macOS | Linux |
|---|---|---|---|
| **Run** | `node server.mjs` or double-click `start.cmd` | `node server.mjs` | `node server.mjs` |
| **Run in background** | `start-hidden.vbs` (fully hidden) | `nohup node server.mjs >server.log 2>&1 &` | same as macOS |
| **Stop** | `stop.cmd` | `node stop.mjs` | `node stop.mjs` |
| **Console** | desktop shortcut / `console-open.vbs` | open <http://127.0.0.1:8788/console> | same as macOS |
| **Autostart** | shortcut to `start-hidden.vbs` in Startup folder | see launchd below | see systemd below |
| **Login** | opens default browser | opens default browser | opens default browser; use `--no-open` on headless |

<details>
<summary>macOS autostart (launchd)</summary>

Save as `~/Library/LaunchAgents/com.local.workbuddy-proxy.plist` (adjust paths):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.local.workbuddy-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/Users/you/workbuddy-openai-proxy/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>/Users/you/workbuddy-openai-proxy</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.local.workbuddy-proxy.plist
```

</details>

<details>
<summary>Linux autostart (systemd --user)</summary>

Save as `~/.config/systemd/user/workbuddy-proxy.service`:

```ini
[Unit]
Description=WorkBuddy OpenAI Proxy
After=network.target

[Service]
WorkingDirectory=%h/workbuddy-openai-proxy
ExecStart=/usr/bin/node %h/workbuddy-openai-proxy/server.mjs
Restart=on-failure

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now workbuddy-proxy
loginctl enable-linger $USER      # keep running when logged out
```

</details>

<details>
<summary>Logging in on a headless machine (SSH / server)</summary>

Login is a browser-based device-code flow. On a box with no GUI:

```bash
node login.mjs --site cn-cli --no-open
# prints an authorization URL — open it in a browser on your own machine,
# authorize, and the script will pick up the result automatically.
```

</details>

---

## Features

- **Zero dependencies** — Node.js ≥ 18 only. No `npm install`, no Docker.
- **Two editions, one service** — China and International are protocol-compatible; the proxy
  routes by model across both. *Quota is not shared between them* — each needs its own login.
- **Account pool** — put multiple accounts under one site; automatically rotates when an
  account runs out of quota or starts failing. See below.
- **Context compression** — long conversations are trimmed to fit the model window instead of
  bouncing a raw upstream `400 prompt is too long`.
- **Both protocols** — `/v1/chat/completions` (OpenAI) and `/v1/messages` (Anthropic), plus
  `/v1/responses` for Codex CLI and other Responses-API clients.
- **Full tool calling** — streaming `tool_calls` aggregation and multi-turn tool result
  replay. Works with agent-style clients.
- **Web console** — model list, quota, per-account management, live logs, light/dark themes.
- **Resilience** — automatic token refresh, connection-level retry with backoff, automatic
  fallback to another site on gateway errors or missing models.

### Account pool

Add a second account by logging in again — same `uid` updates in place, a new `uid` is added:

```bash
node login.mjs --site intl-cli --label backup-1
node login.mjs --list                      # show all pools
```

Selection order: not-exhausted → fewest consecutive failures → least-recently-used (so load
spreads across accounts).

Rotation triggers:

| Condition | Behavior |
|---|---|
| Quota exhausted (429 / `insufficient credits`) | Marked exhausted, rotate; retried after 6h |
| `401` / `403` | Refresh that account's token in place first, rotate only if it still fails |
| `5xx` / gateway errors | Backoff cooldown (30s → 2m → 10m → 30m), then rotate |
| All accounts on a site exhausted | Falls back to another site if it also serves that model |

**No migration needed.** If no pool file exists, the existing single-account credential is
used as-is — behavior is identical to before. The pool file is only written once you add a
second account.

### Context compression

Upstream enforces an input limit and returns `400 prompt is too long` when exceeded. This
proxy trims the history to fit, then retries if the upstream still rejects it.

Rules: the `system` prompt is never dropped; oldest messages go first; the last 4 messages are
always kept; an `assistant` message with `tool_calls` is never separated from its `tool`
results (splitting them makes the upstream reject the request); a single oversized message has
its own content truncated.

Tunable in `config.json`:

```jsonc
"context": {
  "enabled": true,
  "reserveForOutput": 4096,   // tokens reserved for the reply
  "minKeepMessages": 4,       // always keep the N most recent
  "safetyRatio": 0.95         // headroom for estimation error
}
```

Set `"enabled": false` to restore pass-through behavior.

---

## Client setup

<details>
<summary>Cursor</summary>

Settings → Models → OpenAI API:
- Base URL: `http://127.0.0.1:8788/v1`
- API Key: from `config.json`

</details>

<details>
<summary>Claude Code (Anthropic protocol)</summary>

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8788
export ANTHROPIC_API_KEY=<your apiKey>
```

</details>

<details>
<summary>Codex CLI (`/v1/responses`)</summary>

Point it at `http://127.0.0.1:8788/v1` with `wire_api = "responses"`.

</details>

<details>
<summary>Any OpenAI-compatible client</summary>

Base URL `http://127.0.0.1:8788/v1`, Bearer auth with your `apiKey`.

</details>

---

## Which models can I use?

It depends on your plan — **the authoritative list is whatever `GET /v1/models` returns**.
A typical China-edition account sees:

| Model ID | Context / max output |
|---|---|
| `deepseek-v4-pro` | 1M / 50k |
| `deepseek-v4.1-flash` | 1M / 128k |
| `glm-5.3` / `glm-5.3-flash` | 1M / 48k |
| `kimi-k2.7` / `kimi-k3-1` | 256k / 32k · 1M / 32k |
| `minimax-m3` | 512k / 128k |
| `hy4-preview` / `hy3` | 1M / 64k |
| `glm-5v-turbo` (vision) | 200k / 64k |
| `auto` | 168k / 32k |

The **International** edition additionally exposes Claude, GPT and Gemini models
(`claude-sonnet-4.6`, `claude-opus-4.6`, `gpt-5.5`, `gemini-3.1-pro`, …). On the China edition
those return `400 only available for authorized users` unless your plan includes them.

**Routing:** write a bare model ID and the proxy picks the cheapest site serving it; or force
one with `site/model` (e.g. `intl-cli/claude-sonnet-4.6`).

---

## API

| Path | Method | Description |
|---|---|---|
| `/v1/models` | GET | Merged model list from all logged-in sites, with `site` and `credits` multiplier |
| `/v1/chat/completions` | POST | OpenAI-compatible (streaming / non-streaming, tool calling) |
| `/v1/responses` | POST | OpenAI Responses API compatibility layer |
| `/v1/messages` | POST | Anthropic Messages (full streaming event sequence) |
| `/v1/messages/count_tokens` | POST | Token estimation |
| `/status` | GET | Per-site login state and remaining quota |
| `/health` | GET | Health check (no auth) |

The `/v1` prefix is optional. Auth via `Authorization: Bearer <apiKey>` or `x-api-key: <apiKey>`.

---

## FAQ

| Symptom | Fix |
|---|---|
| `404 unknown path POST /v1/messages/chat/completions` | Client duplicated the path segment. Use the base URL `http://127.0.0.1:8788/v1` |
| `401 not logged in` | Run `node login.mjs --site <site>` |
| `401 session expired` | Refresh token expired — log in again |
| `402 insufficient quota` | That site's quota is used up (quota is per-site, not shared) |
| `429 rate limited` | Back off, reduce concurrency |
| International returns 401/500 but China works | Separate account systems — log in with `--site intl-cli` |
| Response gets truncated | Upstream counts reasoning tokens as output; raise the output window in your client |
| Empty model list in client | Some clients don't call `/v1/models` — type the model ID manually |
| `port already in use` | Another instance is running: `node stop.mjs` |
| Long conversations fail | Should be handled automatically now — please open an issue with the error text |

---

## Testing

Zero dependencies, Node's built-in test runner, no `npm install`:

```bash
npm test        # or: node --test --test-reporter=spec --experimental-test-isolation=none "test/**/*.test.mjs"
```

**363 tests passing**, covering config validation, credential refresh, account-pool rotation,
context compression, protocol translation (OpenAI ↔ Anthropic ↔ Responses), SSE aggregation,
timeouts, and an end-to-end security suite (console origin checks, DNS rebinding, auth).

---

## Security

- Listens on `127.0.0.1` only. Credential files are mode `0600` and gitignored — **never share
  or commit them**.
- Uses the **same non-public endpoints as the official CodeBuddy CLI**. They are undocumented
  and may change without notice. This project only relays traffic for local personal use.
- **Use it with your own account only**, and comply with the Tencent CodeBuddy / WorkBuddy
  terms of service. Quota rules and abuse detection are controlled by the upstream.
- Not affiliated with, authorized by, or endorsed by Tencent. Evaluate the risk yourself.

**Loopback is not automatically safe.** Any web page you visit can also reach a local server,
so the console enforces:

- Console page and API accept only loopback `Origin`, validate `Host` (DNS-rebinding defense),
  and send `X-Frame-Options: DENY`.
- Console responses never send `Access-Control-Allow-Origin: *`, so a cross-site page can't
  read the session token injected into the page.
- `/v1/*` keeps permissive CORS (in-browser clients need it) but is always behind `apiKey`.

If `apiKey` is empty the server prints a startup warning. Keep a random key.

---

## Credits

Protocol details were informed by these open-source projects (this codebase is an independent
rewrite; only interface shapes and field conventions were referenced):

- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) (Go, MIT) — OAuth
  device flow, upstream endpoints and header conventions, SSE frame normalization
- [rocky99261/workbuddy-proxy](https://github.com/rocky99261/workbuddy-proxy) (Python) —
  account headers (uid / enterpriseId / domain) and IDE-side call shapes
- [maiphucgiang/codebuddy2api](https://github.com/maiphucgiang/codebuddy2api) (Python) —
  China/International domain split, credit multiplier and non-shared quota semantics

Trae / TraeWork / CodeBuddy / WorkBuddy are trademarks of their respective owners. This
project is not affiliated with those companies.

---

## License

[MIT](LICENSE)
