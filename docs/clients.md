# 客户端接入

所有客户端要填的都是同样三样东西，区别只在菜单在哪儿。

| 字段 | 值 |
|---|---|
| Base URL / 请求地址 / Endpoint | `http://127.0.0.1:8788/v1` |
| API Key / 令牌 / 密钥 | `config.json` 里的 `apiKey` |
| 模型 ID / Model | `default` |

> **`default` 是虚拟模型**：它指向控制台里选定的「默认模型」。
> 换模型时在控制台点一下即可，**客户端一个字都不用改**。
> 想固定用某个模型，也可以直接填模型 ID（如 `glm-5.3`、`claude-sonnet-4.6`），
> 或用站点前缀强制指定（如 `intl-cli/claude-sonnet-4.6`）。

---

## TraeWork（桌面版）

> 官方限制：**只有 TraeWork 桌面版支持添加自定义模型**，且自定义模型**只在本地环境可用**。

**设置 → 模型 → 添加模型 → 选择「自定义模型」**，按下表填：

| 参数 | 填写值 |
|---|---|
| API 格式 | **OpenAI Chat Completions 格式**（推荐） |
| 自定义请求地址 | 基础地址 `http://127.0.0.1:8788/v1`；或打开「完整 URL」开关填 `http://127.0.0.1:8788/v1/chat/completions` |
| 模型 ID | **`default`** |
| 模型展示名称 | 随便填，例如 `WorkBuddy` |
| API 密钥 | `config.json` 里的 `apiKey` |

**高级配置**（建议）：

| 参数 | 建议值 |
|---|---|
| 模型系列 | 用 `deepseek-v4-pro` 选 **DeepSeek-4 系列**（自动开思考模式 + 推荐超参）；用 GLM / Kimi 选「默认」 |
| 上下文窗口 | 输入 `1000000`、输出 `65536`（可留空用默认） |
| 工具调用轮数 | 留空 |
| 支持图片输入 | 仅当模型支持视觉（如 `glm-5v-turbo`）才勾选 |

**「完整 URL」开关的两种填法都对，但别混用：**

| API 格式 | 打开「完整 URL」 | 关闭「完整 URL」 |
|---|---|---|
| OpenAI Chat Completions | 填 `…/v1/chat/completions` | 填 `…/v1` |
| Anthropic Messages | 填 `…/v1/messages` | 填 `…/v1` |

---

## TRAE IDE / TraeCode CLI

走同样的 OpenAI 兼容配置。TraeCode CLI 的配置写在 `trae_cli.yaml` 里，
把 `base_url` 指向 `http://127.0.0.1:8788/v1`、`api_key` 填 `config.json` 里的 `apiKey`。

> 注意：TraeWork / TRAE 这类客户端**不一定会拉 `/v1/models`**，
> 所以「模型列表为空」是正常现象 —— 手动填模型 ID 即可。

---

## Claude Code（Anthropic 协议）

Claude Code 走 Anthropic Messages 协议，本项目原生支持：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8788
export ANTHROPIC_API_KEY=<config.json 里的 apiKey>
claude
```

> 注意 `ANTHROPIC_BASE_URL` **不带 `/v1`** —— Claude Code 会自己拼 `/v1/messages`。

---

## Codex CLI（Responses 协议）

Codex CLI 用 OpenAI 的 Responses API，本项目有兼容层（`/v1/responses`）：

```toml
# ~/.codex/config.toml
model_provider = "workbuddy"

[model_providers.workbuddy]
name = "WorkBuddy"
base_url = "http://127.0.0.1:8788/v1"
env_key = "WORKBUDDY_API_KEY"
wire_api = "responses"
```

```bash
export WORKBUDDY_API_KEY=<config.json 里的 apiKey>
```

---

## Cursor

**Settings → Models → OpenAI API**：

- Base URL：`http://127.0.0.1:8788/v1`
- API Key：`config.json` 里的 `apiKey`
- 然后在模型列表里加一个自定义模型，名字填 `default`

---

## Cherry Studio / NextChat / LobeChat 等

选「OpenAI」类型的提供商，填：

- API 地址：`http://127.0.0.1:8788`
- 密钥：`config.json` 里的 `apiKey`
- 模型：`default`

> 有些客户端会自己补 `/v1`，有些不会。**带不带 `/v1` 前缀都能访问** ——
> 服务端两种写法都认，所以不用纠结。

---

## 一次接多个客户端：给它们发不同的 Key

`config.json` 的 `apiKey` 可以写成**字符串数组**，数组里每个都有效：

```jsonc
{
  "apiKey": ["sk-wb-你的主密钥", "sk-demo-给演示环境的密钥"]
}
```

这样就不用为了给第二个客户端发密钥而改配置 + 重启（那会把第一个客户端踢下线）。

> 本项目自带的脚本（`ask.mjs` / `status.mjs` / `stop.mjs`）与启动横幅
> 一律用**数组里的第一个**当主密钥；控制台只展示它的掩码形式。

---

## 接完之后的验证顺序

1. `node status.mjs` —— 站点已登录、积分正常
2. 客户端里发一条最简单的消息
3. 打开控制台 <http://127.0.0.1:8788/console> 的「实时日志」分页 ——
   应该能看到对应的 `→ POST /v1/chat/completions` 和一行 `status=200` 的请求记录

**第 3 步是最有用的**：客户端报的错往往很含糊，而控制台日志会直接告诉你
请求到底有没有到、上游返回了什么。
