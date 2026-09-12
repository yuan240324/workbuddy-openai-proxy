# workbuddy-openai-proxy

把 **WorkBuddy / CodeBuddy 账号额度（国内版 + 国际版）** 包装成本机上的
**OpenAI 兼容 + Anthropic 兼容** 接口，供 **TraeWork / TRAE / TraeCode CLI / Cherry Studio / Cursor** 等
任意 OpenAI 兼容客户端当作「自定义模型」接入。

> Turn your WorkBuddy (Tencent CodeBuddy) account quota — **both the China and the international
> edition** — into a local, OpenAI- and Anthropic-compatible HTTP endpoint.
> Zero dependencies, pure Node.js, loopback-only.

- 依赖：仅需 **Node.js ≥ 18**，**零第三方依赖**，不用 npm install、不用 Docker。
- 隔离：配置 / 凭证 / 日志全部落在**项目目录内**；登录走官方**设备授权（OAuth）**，
  不读取 WorkBuddy 客户端的本地配置、浏览器数据或任何项目目录以外的文件。
- 监听：默认只绑 `127.0.0.1:8788`，不对局域网/公网暴露，带本地 API Key 鉴权。
- 多站点：国内版（`copilot.tencent.com`）与国际版（`codebuddy.ai` / `workbuddy.ai`）协议同构，
  一套服务同时代理、按模型自动路由；两边额度互不通用，各自登录。
- 能力：流式 / 非流式、完整工具调用（tool_calls 流式聚合、多轮回灌）、
  `developer` 角色与 `tool_choice` 归一、accessToken 临期自动刷新、剩余积分与**积分倍率**查询。

---

## 1. 目录结构

```
workbuddy-openai-proxy/
├── server.mjs            # 服务入口（路由 + 鉴权 + 路径后缀容错）
├── login.mjs             # 设备授权登录（--site 选站点），凭证写入 auth.<站点>.json
├── status.mjs            # 查看各站点登录状态 + 剩余积分
├── start.cmd             # 双击启动（前台，带日志）
├── start-hidden.cmd      # 双击启动（最小化窗口，后台常驻）
├── status.cmd            # 双击查看状态
├── login.cmd             # 双击发起登录（默认国内版）
├── config.example.json   # 配置样例（复制为 config.json 后按需修改）
├── LICENSE               # MIT
└── src/
    ├── config.mjs        # 配置加载 + 站点表（国内版 / 国际版）
    ├── auth.mjs          # 多站点凭证存取 + 自动刷新（单飞）+ 运行中热加载
    ├── headers.mjs       # 站点感知的上游请求头
    ├── upstream.mjs      # 上游聊天/模型/额度接口 + SSE 解析
    ├── router.mjs        # 模型 → 站点 路由（前缀 / 路由表 / 目录匹配）
    ├── openai.mjs        # /v1/models、/v1/chat/completions
    ├── anthropic.mjs     # /v1/messages、/v1/messages/count_tokens
    ├── util.mjs          # HTTP/SSE 小工具
    └── log.mjs           # 日志
```

运行时自动生成、**已被 .gitignore 忽略**的文件：`config.json`（含本地 API Key）、
`auth.<站点>.json`（各站点登录凭证，如 `auth.cn-cli.json`）、`.login-state.json`。

启动后会打印每个站点的登录状态：

```
站点 cn-cli    已登录 uid=xxxxxxxx…   https://copilot.tencent.com
站点 intl-cli  未登录                 https://www.codebuddy.ai
站点 intl-work 未登录                 https://www.workbuddy.ai
未登录的站点可用：node login.mjs --site <站点名>
```

---

## 2. 启动 / 停止服务

```powershell
node server.mjs          # 前台运行（日志直接打在终端，Ctrl+C 停止）
```

双击脚本更省事：

| 脚本 | 作用 |
|---|---|
| `start.cmd` | 前台启动（带日志，关窗口即停） |
| `start-hidden.cmd` | 后台最小化启动 |
| `start-hidden.vbs` | 完全隐藏启动，日志写入 `server.log`（桌面快捷方式用的就是它） |
| `stop.cmd` | 停止服务（调 `/admin/shutdown`，不依赖 WMI/进程枚举） |
| `status.cmd` | 查看各站点登录态 + 剩余积分 |
| `ask.cmd` / `ask.mjs` | 命令行提问，用来验证代理是否正常 |
| `login.cmd` / `login-intl.cmd` | 登录国内版 / 选择国际版站点 |

**桌面快捷方式**：指向 `wscript.exe "…\start-hidden.vbs"`，双击即静默启动服务（不会弹黑窗）。

启动后终端会打印：

```
监听地址：http://127.0.0.1:8788   （仅本机可达）
API Key：<你的本地 API Key>（首次启动自动生成）
默认站点/模型：cn-cli / deepseek-v4-pro
站点 cn-cli    已登录 uid=xxxxxxxx…   https://copilot.tencent.com
站点 intl-cli  已登录 uid=xxxxxxxx…   https://www.codebuddy.ai
站点 intl-work 未登录                 https://www.workbuddy.ai
```

> **Key 与 URL 只需填一次**：它们保存在 `config.json` 里，重启服务/重启电脑都不变；
> 只有删掉 `config.json`（会重新随机生成 Key）或改 `port`（URL 会变）才需要重新填。

自检：

```powershell
status.cmd                              # 各站点登录态 + 剩余积分
node ask.mjs --list                     # 列出全部模型（含站点与积分倍率）
node ask.mjs claude-sonnet-4.6 "你好"    # 直接提问，会显示是哪个站点接的
```

---

## 3. TraeWork 接入（桌面版）

> 官方限制：**仅 TraeWork 桌面版支持添加自定义模型**，且自定义模型**只在本地环境可用**。

**设置 → 模型 → 添加模型 → 选择「自定义模型」**，按下表填写：

| 参数 | 填写值 |
|---|---|
| API 格式 | **OpenAI Chat Completions 格式**（推荐） |
| 自定义请求地址 | 打开 **完整 URL** 开关，填 `http://127.0.0.1:8788/v1/chat/completions` |
| 模型 ID | `deepseek-v4-pro`（或 `/v1/models` 里任意 ID，见第 5 节） |
| 模型展示名称 | 例如 `WorkBuddy-DeepSeek` |
| API 密钥 | `config.json` 里的 `apiKey` |

**高级配置**（建议）：

| 参数 | 建议值 |
|---|---|
| 模型系列 | 用 `deepseek-v4-pro` 选 **DeepSeek-4 系列**（自动开思考模式 + 推荐超参）；用 GLM/Kimi 选「默认」 |
| 上下文窗口 | 输入 `1000000`、输出 `65536`（可留空用默认） |
| 工具调用轮数 | 留空（用默认） |
| 支持图片输入 | 仅当模型支持视觉（如 `glm-5v-turbo`）才勾选 |
| 采样参数 | 留空即可 |

要改用 **Anthropic Messages 格式**（Claude 型）也可以：完整 URL 填 `http://127.0.0.1:8788/v1/messages`，其余字段同上。

**关于「完整 URL」开关**（两种填法都对，任选其一，别混用）：

| API 格式 | 打开「完整 URL」→ 填完整地址 | 关闭「完整 URL」→ 填基础地址（TraeWork 自己拼路径） |
|---|---|---|
| OpenAI Chat Completions | `http://127.0.0.1:8788/v1/chat/completions` | `http://127.0.0.1:8788/v1` |
| Anthropic Messages | `http://127.0.0.1:8788/v1/messages` | `http://127.0.0.1:8788/v1` |

> 服务端已做**路径后缀容错**：只要路径里含有 `/chat/completions`（按 OpenAI 处理）或 `/messages`（按 Anthropic 处理）就能命中，
> 所以即使客户端拼出 `/v1/messages/chat/completions`、`/v1/v1/chat/completions` 这类组合也不会再报 404。

> 提示：TraeWork 点「添加模型」时会**调用一次接口做密钥校验**，会真实消耗极少量额度——只要代理已启动且已登录就会通过。

### 3.1 TraeCode CLI（`trae_cli.yaml`）

```yaml
models:
  - name: "WorkBuddy-DeepSeek"
    open_ai:
      base_url: http://127.0.0.1:8788/v1
      api_key: "<你的本地 API Key>"
      model: deepseek-v4-pro
  - name: "WorkBuddy-GLM"
    open_ai:
      base_url: http://127.0.0.1:8788
      api_key: "<你的本地 API Key>"
      model: glm-5.3
```

### 3.2 TRAE IDE

**设置 → 模型 → 添加自定义模型**，Base URL 填 `http://127.0.0.1:8788/v1`（或 `http://127.0.0.1:8788`，两种都兼容），
API Key 与模型 ID 同上。

---

## 4. 多站点（国内版 + 国际版）

国内版与国际版**协议同构**（同一套 `/v2/plugin/auth/*` 设备授权、`/v2/chat/completions`、`/v2/billing/meter/*`），
只有域名与身份头不同，因此本项目用一张站点表统一管理：

| 站点键 | 说明 | 上游域名 |
|---|---|---|
| `cn-cli` | 国内版 CLI / IDE | `copilot.tencent.com` |
| `intl-cli` | 国际版 CLI / IDE | `www.codebuddy.ai` |
| `intl-work` | 国际版 WorkBuddy | `www.workbuddy.ai` |

> ⚠️ **额度不通用**：国内版与国际版是两套独立账号与余额（上游明确「每个账号保留自己的模型目录与余额」），
> credit 单价也不同。国际版需要单独注册、单独登录，额度不会互通。

### 4.1 分别登录

```powershell
node login.mjs                      # 默认站点 cn-cli（国内版）
node login.mjs --site intl-cli      # 国际版 CLI（codebuddy.ai）
node login.mjs --site intl-work     # 国际版 WorkBuddy（workbuddy.ai）
```

每个站点的凭证单独存在 `auth.<site>.json`，互不影响；国际版页面若无账号可直接注册。

> 登录页面可能存在两道步骤：**账号登录** → **CLI 授权确认**。只完成前者时上游会持续返回
> `11217: login ing...`，需要在授权页点一次「授权 / 允许」才会下发 token。

### 4.1.1 国际版实测可用模型（`intl-cli`）

国际版的「控制台模型目录」接口在网关侧受限（`403 access_denied` / 偶发 500），
因此项目为它内置了一份**实测可用清单**（`sites.intl-cli.seedModels`，可自行增删）：

| 模型 ID | 说明 |
|---|---|
| `claude-sonnet-4.6` · `claude-opus-4.6` | **Claude 系（国内版没有）**，实测为真 Claude |
| `gpt-5.4` | **GPT-5.4（国内版没有）** |
| `gemini-3.1-pro` | **Gemini 3.1 Pro（国内版没有）** |
| `deepseek-v4.1-flash` · `minimax-m3` · `kimi-k2.7` · `glm-5.3` · `glm-5.2` | 与国际版目录一致 |
| `auto` | 上游自动路由 |

判断某个 ID 是否可用：直接发一次请求，不存在时上游返回 `400 model [X] service info not found`（不消耗额度）。

### 4.1.2 国际版的两个坑（本项目已自动处理）

1. **首条消息必须是 `system`**：国际版硬性要求 `messages[0].role === "system"`，否则 400
   `first message is not system prompt`。本项目在出站前会自动补一条 system（内容可在
   `config.json` 的 `defaultSystemPrompt` 里改），客户端无感。
2. **目录接口不可用**：见上，用内置清单兜底；`GET /v1/models` 仍会展示这些模型。

### 4.2 请求怎么路由到站点

优先级从高到低：

1. **显式前缀**：`站点/模型`，例如 `intl-cli/claude-4.5`、`cn-cli/hy3`
2. **`config.json` 的 `modelRoutes`**：固定把某模型钉到某站点，例如 `{ "claude-4.5": "intl-cli" }`
3. **模型目录匹配**：裸 ID 时自动查各站点实时目录，**优先选择积分倍率最低的站点**
4. **`defaultSite`**：都没命中时用的兜底站点

所以日常直接写模型 ID 就行；需要跨站点区分同名模型时用前缀或 `modelRoutes`。

### 4.3 查看站点状态与倍率

```powershell
status.cmd                       # 各站点登录态 + 剩余积分
node status.mjs --site intl-cli  # 只看某个站点
```

`GET /v1/models` 会合并所有已登录站点的目录，并带出**积分倍率**（`credits` 字段，`x0.00` 表示不扣积分）：

```json
{ "id": "hy3", "site": "cn-cli", "credits": "x0.00 credits", "credits_multiplier": 0 }
```

---

## 5. 常见问题

| 现象 | 处理 |
|---|---|
| `未知路径 POST /v1/messages/chat/completions (404)` | 客户端把路径拼重复了。服务端现已容错（按 `/chat/completions` / `/messages` 后缀识别），若仍报错请把地址改为基础地址 `http://127.0.0.1:8788/v1`（或完整 URL `…/v1/chat/completions`） |
| 401「尚未登录」 | 该站点未登录：`node login.mjs --site <站点名>`（国内版可省 `--site`） |
| 401「登录态失效」 | 该站点 refreshToken 已过期，重新登录该站点 |
| 402 额度不足 | 该站点剩余积分用完（两边额度不通用，可切到另一站点） |
| 429 限流 | 稍后重试，降低并发 |
| `model xxx is only available for authorized users` | 该模型你的账号无权限，换第 6 节清单里的模型 |
| 国际版报 401/500 但国内版正常 | 国际版是独立账号体系，需要单独 `--site intl-cli` / `--site intl-work` 登录 |
| 模型回答被截断 | 上游「思考」也计入输出 token；在 TraeWork 高级配置里调大输出上下文窗口 |
| TraeWork 里模型列表为空 | TraeWork 不拉 `/v1/models`，模型 ID 手填即可 |
| 想换端口 / 换 Key | 改 `config.json` 后重启服务 |
| 想关掉鉴权 | 把 `config.json` 的 `apiKey` 设为 `""`（仅本机使用时才可以） |

---

## 6. 示例模型清单

> 各账号可用模型不同（取决于套餐/权限），**实际清单以 `GET /v1/models` 实时返回为准**。下表仅为一个普通账号的示例：

| 模型 ID | 名称 | 上下文 / 最大输出 |
|---|---|---|
| `deepseek-v4-pro` | DeepSeek-V4-Pro | 1M / 50k |
| `deepseek-v4.1-flash` | DeepSeek-V4.1-Flash | 1M / 128k |
| `glm-5.3` / `glm-5.3-flash` | GLM-5.3 / Flash | 1M / 48k |
| `glm-5.2` / `glm-5.1` | GLM-5.2 / 5.1 | 1M / 48k |
| `kimi-k2.7` | Kimi-K2.7-Code | 256k / 32k |
| `kimi-k3-1` | Kimi-K3 | 1M / 32k |
| `minimax-m3` | MiniMax-M3 | 512k / 128k |
| `hy4-preview` / `hy3` / `hy3-x` | Hy4 preview / Hy3 | 1M / 64k |
| `glm-5v-turbo` | GLM-5v-Turbo（视觉） | 200k / 64k |
| `auto` | 上游自动路由 | 168k / 32k |

> 未订阅相应权限时，Claude 系列（`claude-sonnet-4.6` 等）会返回 400 `only available for authorized users` ——
> 想用 Claude / GPT / Gemini，请走**国际版站点**（见 4.1.1）。

想用别名调用固定模型，可在 `config.json` 的 `modelAliases` 里加映射：

```json
"modelAliases": { "gpt-4.1": "deepseek-v4-pro", "claude": "intl-cli/claude-sonnet-4.6" }
```

---

## 7. 接口一览

| 路径 | 方法 | 说明 |
|---|---|---|
| `/v1/models` | GET | 合并所有已登录站点的模型清单，含 `site` 与 `credits` 倍率（5 分钟缓存，失败回落配置） |
| `/v1/chat/completions` | POST | OpenAI 兼容补全（流式/非流式、工具调用、developer 角色归一） |
| `/v1/messages` | POST | Anthropic Messages（流式事件完整：message_start → content_block_* → message_delta → message_stop） |
| `/v1/messages/count_tokens` | POST | token 估算 |
| `/status` | GET | 各站点登录状态 + 剩余积分（`?site=intl-cli` 可只看一个站点） |
| `/health` | GET | 健康检查（无需鉴权），含各站点登录态 |

带不带 `/v1` 前缀都能访问。鉴权：`Authorization: Bearer <apiKey>` 或 `x-api-key: <apiKey>`。

---

## 8. 已验证项（Windows + Node 24 实测）

- ✅ 设备授权登录、`refresh_token` 自动续期（accessToken 临期 5 分钟内自动刷新，遇 401 强刷重试一次）
- ✅ 国内版 / 国际版多站点：站点表、独立凭证、`站点/模型` 前缀路由、目录匹配自动选站点
- ✅ 国际版：`claude-sonnet-4.6` / `claude-opus-4.6` / `gpt-5.4` / `gemini-3.1-pro` 裸模型名自动路由并实测可用
- ✅ 国际版自动补 system 首条消息（上游硬性要求），工具调用实测返回正确 `tool_calls`
- ✅ OpenAI 非流式 / 流式；Anthropic 流式事件序列
- ✅ 工具调用：流式聚合 `tool_calls`、`tool_choice` 对象→字符串归一、`developer` 角色→`system`
- ✅ 多轮工具回灌（agent 形态：assistant.tool_calls → tool 结果 → 最终回答）
- ✅ 剩余积分查询、动态模型清单、积分倍率展示

---

## 9. 安全与合规

- 仅监听 `127.0.0.1`；`auth.<站点>.json` 权限 0600，**不要外传**、不要提交仓库（`.gitignore` 已忽略）。
- 走的是 **CodeBuddy 官方 CLI 所用的非公开接口**，无官方文档、可能随时变更；本项目只做本机自用转发。
- 请仅用于**本人账号**，遵守腾讯 CodeBuddy / WorkBuddy 用户协议；额度规则与风控由上游决定。
- 本项目与腾讯无任何关联，未获官方授权或认可，请自行评估使用风险。

---

## 10. 致谢

上游协议细节参考了以下开源项目的公开实现（本项目代码为独立重写，仅借鉴接口形态与字段约定）：

- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（Go，MIT）— OAuth 设备授权流程、
  上游端点与请求头约定、SSE 帧规范化思路
- [rocky99261/workbuddy-proxy](https://github.com/rocky99261/workbuddy-proxy)（Python）— 账号头（uid / enterpriseId / domain）
  与 IDE 侧调用形态
- [maiphucgiang/codebuddy2api](https://github.com/maiphucgiang/codebuddy2api)（Python）— 国内版 / 国际版站点域名划分、
  积分倍率与额度互不通用等口径说明

Trae / TraeWork / CodeBuddy / WorkBuddy 均为其各自所有者的商标，本项目与上述公司无隶属关系。

---

## 11. 许可证

[MIT](LICENSE)

