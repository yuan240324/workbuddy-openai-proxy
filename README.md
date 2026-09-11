# workbuddy-openai-proxy

把 **WorkBuddy / CodeBuddy（copilot.tencent.com）账号额度** 包装成本机上的
**OpenAI 兼容 + Anthropic 兼容** 接口，供 **TraeWork / TRAE / TraeCode CLI / Cherry Studio / Cursor** 等
任意 OpenAI 兼容客户端当作「自定义模型」接入。

> Turn your WorkBuddy (Tencent CodeBuddy) account quota into a local, OpenAI- and Anthropic-compatible
> HTTP endpoint — zero dependencies, pure Node.js, loopback-only.

- 依赖：仅需 **Node.js ≥ 18**，**零第三方依赖**，不用 npm install、不用 Docker。
- 隔离：配置 / 凭证 / 日志全部落在**项目目录内**；登录走官方**设备授权（OAuth）**，
  不读取 WorkBuddy 客户端的本地配置、浏览器数据或任何项目目录以外的文件。
- 监听：默认只绑 `127.0.0.1:8788`，不对局域网/公网暴露，带本地 API Key 鉴权。
- 能力：流式 / 非流式、完整工具调用（tool_calls 流式聚合、多轮回灌）、
  `developer` 角色与 `tool_choice` 归一、accessToken 临期自动刷新、剩余积分查询。

---

## 1. 目录结构

```
workbuddy-openai-proxy/
├── server.mjs            # 服务入口（路由 + 鉴权 + 路径后缀容错）
├── login.mjs             # 设备授权登录，token 写入 auth.json
├── status.mjs            # 查看登录状态 + 剩余积分（命令行）
├── start.cmd             # 双击启动（前台，带日志）
├── start-hidden.cmd      # 双击启动（最小化窗口，后台常驻）
├── status.cmd            # 双击查看状态
├── login.cmd             # 双击发起登录
├── config.example.json   # 配置样例（复制为 config.json 后按需修改）
├── LICENSE               # MIT
└── src/
    ├── config.mjs        # 配置加载（缺失自动生成，含随机本地 API Key）
    ├── auth.mjs          # token 存取 + 自动刷新（单飞）+ 运行中热加载
    ├── headers.mjs       # 上游请求头
    ├── upstream.mjs      # 上游聊天/模型/额度接口 + SSE 解析
    ├── openai.mjs        # /v1/models、/v1/chat/completions
    ├── anthropic.mjs     # /v1/messages、/v1/messages/count_tokens
    ├── util.mjs          # HTTP/SSE 小工具
    └── log.mjs           # 日志
```

运行时自动生成、**已被 .gitignore 忽略**的文件：`config.json`（含本地 API Key）、`auth.json`（登录凭证）、`.login-state.json`。

---

## 2. 启动服务

```powershell
node server.mjs          # 或双击 start.cmd（前台）
                         # 或双击 start-hidden.cmd（后台最小化）
```

启动后终端会打印：

```
监听地址：http://127.0.0.1:8788   （仅本机可达）
API Key：<你的本地 API Key>（首次启动自动生成）
默认模型：deepseek-v4-pro
```

自检 / 查额度：

```powershell
node -e "fetch('http://127.0.0.1:8788/health').then(r=>r.text()).then(console.log)"
status.cmd              # 登录态 + 剩余积分（等价于访问 /status）
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

## 4. 常见问题

| 现象 | 处理 |
|---|---|
| `未知路径 POST /v1/messages/chat/completions (404)` | 客户端把路径拼重复了。服务端现已容错（按 `/chat/completions` / `/messages` 后缀识别），若仍报错请把地址改为基础地址 `http://127.0.0.1:8788/v1`（或完整 URL `…/v1/chat/completions`） |
| 401「尚未登录」 | 运行 `node login.mjs`（或双击 `login.cmd`） |
| 401「登录态失效」 | refreshToken 已过期，重新 `node login.mjs` |
| 402 额度不足 | 剩余积分用完，等额度刷新或换账号 |
| 429 限流 | 稍后重试，降低并发 |
| `model xxx is only available for authorized users` | 该模型你的账号无权限，换第 5 节清单里的模型 |
| 模型回答被截断 | 上游「思考」也计入输出 token；在 TraeWork 高级配置里调大输出上下文窗口 |
| TraeWork 里模型列表为空 | TraeWork 不拉 `/v1/models`，模型 ID 手填即可 |
| 想换端口 / 换 Key | 改 `config.json` 后重启服务 |
| 想关掉鉴权 | 把 `config.json` 的 `apiKey` 设为 `""`（仅本机使用时才可以） |

---

## 5. 示例模型清单

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

> 未订阅相应权限时，Claude 系列（`claude-sonnet-4.6` 等）会返回 400 `only available for authorized users`。

想用别名调用固定模型，可在 `config.json` 的 `modelAliases` 里加映射：

```json
"modelAliases": { "gpt-4.1": "deepseek-v4-pro" }
```

---

## 6. 接口一览

| 路径 | 方法 | 说明 |
|---|---|---|
| `/v1/models` | GET | 模型清单（实时拉上游，5 分钟缓存，失败回落配置） |
| `/v1/chat/completions` | POST | OpenAI 兼容补全（流式/非流式、工具调用、developer 角色归一） |
| `/v1/messages` | POST | Anthropic Messages（流式事件完整：message_start → content_block_* → message_delta → message_stop） |
| `/v1/messages/count_tokens` | POST | token 估算 |
| `/status` | GET | 登录状态 + 剩余积分 |
| `/health` | GET | 健康检查（无需鉴权） |

带不带 `/v1` 前缀都能访问。鉴权：`Authorization: Bearer <apiKey>` 或 `x-api-key: <apiKey>`。

---

## 7. 已验证项（Windows + Node 24 实测）

- ✅ 设备授权登录、`refresh_token` 自动续期（accessToken 临期 5 分钟内自动刷新，遇 401 强刷重试一次）
- ✅ OpenAI 非流式 / 流式；Anthropic 流式事件序列
- ✅ 工具调用：流式聚合 `tool_calls`、`tool_choice` 对象→字符串归一、`developer` 角色→`system`
- ✅ 多轮工具回灌（agent 形态：assistant.tool_calls → tool 结果 → 最终回答）
- ✅ 剩余积分查询、动态模型清单

---

## 8. 安全与合规

- 仅监听 `127.0.0.1`；`auth.json` 权限 0600，**不要外传**、不要提交仓库（`.gitignore` 已忽略）。
- 走的是 **CodeBuddy 官方 CLI 所用的非公开接口**，无官方文档、可能随时变更；本项目只做本机自用转发。
- 请仅用于**本人账号**，遵守腾讯 CodeBuddy / WorkBuddy 用户协议；额度规则与风控由上游决定。
- 本项目与腾讯无任何关联，未获官方授权或认可，请自行评估使用风险。

---

## 9. 致谢

上游协议细节参考了以下开源项目的公开实现（本项目代码为独立重写，仅借鉴接口形态与字段约定）：

- [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api)（Go，MIT）— OAuth 设备授权流程、
  上游端点与请求头约定、SSE 帧规范化思路
- [rocky99261/workbuddy-proxy](https://github.com/rocky99261/workbuddy-proxy)（Python）— 账号头（uid / enterpriseId / domain）
  与 IDE 侧调用形态

Trae / TraeWork / CodeBuddy / WorkBuddy 均为其各自所有者的商标，本项目与上述公司无隶属关系。

---

## 10. 许可证

[MIT](LICENSE)

