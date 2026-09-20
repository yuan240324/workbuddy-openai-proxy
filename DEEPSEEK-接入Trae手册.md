# DeepSeek 官方站点接入 Trae —— 操作手册

> 把 DeepSeek 手机版/网页版（chat.deepseek.com）的账号额度，
> 通过本项目反代成 OpenAI / Anthropic 兼容接口，供 Trae 使用。

---

## 一、准备：拿到 token

DeepSeek 官方没有设备授权（OAuth）流程，也没有可用的 API Key，
只能从浏览器里取登录态 token。

1. 浏览器打开 https://chat.deepseek.com 并**确认已登录**
2. 按 `F12` 打开开发者工具
3. 切到 **Console（控制台）** 标签
4. 首次粘贴代码时浏览器会拦截，提示：
   > 不要粘贴你不理解的代码……请输入「**允许粘贴**」

   在输入框里输入中文 **`允许粘贴`** 然后回车
5. 粘贴这一行并回车：

```js
JSON.parse(localStorage.getItem('userToken')).value
```

6. 控制台会打印出一串字符（形如 `M2u+yb/RW19+...`），**复制它**

> **更省事的替代方案**：执行下面这行，token 会直接进剪贴板：
> ```js
> copy(JSON.parse(localStorage.getItem('userToken')).value)
> ```

> **不想碰 Console？** 也可以手动取：
> `F12` → **应用（Application）** → 左侧 **本地存储（Local Storage）**
> → 点 `https://chat.deepseek.com` → 在键列找 **`userToken`**
> → 复制值里 `"value"` 后面的那一串（不要带 `{"value":"` 和 `"}`）

---

## 二、配置 token

```powershell
cd "G:\trea\反代"
node login-deepseek.mjs
```

按提示粘贴 token，回车。脚本会：

1. 自动剥离 `{"value":"..."}` 包装（如果你连外壳一起复制了）
2. 联网校验 token 是否有效
3. 以 **0600 权限**写入 `auth.deepseek.json`（已在 `.gitignore` 中忽略）

校验成功会看到：

```
✔ token 有效
  账号：your@email.com
✔ 已写入 auth.deepseek.json（权限 0600，已在 .gitignore 中忽略）
```

随时查看状态：

```powershell
node login-deepseek.mjs --status
```

> **也可以用控制台**：打开 http://127.0.0.1:8788/console → 「账号登录」→
> 选 DeepSeek 站点 → 粘贴 token。

---

## 三、启用 DeepSeek 站点

DeepSeek 站点默认是**关闭**的（`enabled: false`），配置好 token 后打开它。

编辑 `config.json`，把 `sites.deepseek.enabled` 改成 `true`：

```json
"deepseek": {
  "label": "DeepSeek 官方（chat.deepseek.com）",
  "enabled": true,
  ...
}
```

然后重启服务：

```powershell
stop.cmd
start-hidden.cmd
```

验证：

```powershell
node status.mjs
```

应该能看到 `deepseek` 站点处于已登录状态。

---

## 四、接入 Trae 桌面版

**设置 → 模型 → 添加模型 → 选择「自定义模型」**：

| 参数 | 填写值 |
|---|---|
| API 格式 | **OpenAI Chat Completions 格式**（推荐） |
| 自定义请求地址 | 打开「完整 URL」开关，填 `http://127.0.0.1:8788/v1/chat/completions` |
| 模型 ID | `deepseek/deepseek-chat`（见下表） |
| 模型展示名称 | 例如 `DeepSeek 官方` |
| API 密钥 | `config.json` 里的 `apiKey` |

### 可用模型 ID

| 模型 ID | 对应官方行为 |
|---|---|
| `deepseek/deepseek-chat` | 默认对话 |
| `deepseek/deepseek-reasoner` | **深度思考**（返回 `reasoning_content`） |
| `deepseek/deepseek-search` | **联网搜索** |

> 官方 Web 端其实没有模型选择器，只有「深度思考」「联网搜索」两个开关。
> 这里用模型别名承载这些组合，所以填不同的 ID 就等于切换开关。

### 表单填法（两种都对，任选其一，别混用）

| API 格式 | 打开「完整 URL」→ 填 | 关闭「完整 URL」→ 填 |
|---|---|---|
| OpenAI Chat Completions | `http://127.0.0.1:8788/v1/chat/completions` | `http://127.0.0.1:8788/v1` |
| Anthropic Messages | `http://127.0.0.1:8788/v1/messages` | `http://127.0.0.1:8788/v1` |

> 想用 **Anthropic 格式**（Claude 型）也可以，本项目两条协议都支持。

### 高级配置建议

| 参数 | 建议值 |
|---|---|
| 上下文窗口 | 输入 `128000`、输出 `8192`（官方实际上限以账号为准） |
| 支持图片输入 | **不勾选**（官方该接口不支持图片） |
| 工具调用 | **不支持**（官方该接口无工具调用能力） |

> ⚠️ **重要限制**：官方 `/api/v0/chat/completion` 接口**不支持工具调用（function calling）**。
> Trae 的 Agent 模式依赖工具调用，用这个站点时请使用**普通对话模式**。
> 需要 Agent 能力请用项目里的 CodeBuddy 站点（`cn-cli` / `intl-cli`）。

---

## 五、验证是否可用

```powershell
node ask.mjs deepseek/deepseek-chat "你好"
```

或直接在 Trae 里发一条消息。

---

## 六、常见问题

| 现象 | 处理 |
|---|---|
| `401 未配置 token` | 跑 `node login-deepseek.mjs` |
| `token 无效或已过期` | token 失效了，重新从浏览器取一次（见第一节） |
| `PoW 无解` | 挑战过期。重试即可；若持续出现请提 issue |
| `40301 PoW 答案无效` | 同上，通常是时钟偏差或挑战过期 |
| `40012 账号已被封禁` | 账号被风控了。**停止使用** |
| 模型列表里没有 deepseek | 检查 `config.json` 里 `enabled` 是否为 `true`，并重启服务 |
| Trae 里回复为空 | 检查是否是 `deepseek-reasoner`（思考内容不计入正文） |
| 多轮对话上下文丢失 | 官方接口是无状态的，每轮都会把历史压平成文本重发，属正常 |

---

## 七、重要限制与风险

### 功能限制
- ❌ **不支持工具调用**（function calling）—— 官方接口没有这个能力
- ❌ **不支持图片输入**
- ⚠️ **无自动刷新**：token 过期需**手动重新粘贴**（未发现可用刷新端点）
- ⚠️ 每次请求都要**求解一次 PoW**（约 20~80ms 开销）

### 合规风险（请务必阅读）
- 本方案是**逆向官方 App/网页接口**，**违反 DeepSeek 用户协议**
- 官方的 PoW（工作量证明）**就是专门用来阻止自动化调用的**，绕过它可能触发风控
- 错误码表里存在 `40012 USER_IS_BANNED`，**有封号风险**
- 官方接口无公开文档，**随时可能变更导致失效**
- **建议仅本人账号自用**，勿外传、勿商用

### 替代方案
如果需要稳定、合规、支持工具调用的能力，建议：
- 用本项目已有的 **CodeBuddy 站点**（`cn-cli` / `intl-cli`，走官方 OAuth）
- 或使用 **DeepSeek 官方开放平台**（`api.deepseek.com`，标准 OpenAI 兼容，需充值）

---

## 八、技术实现（供排查参考）

```
POST /api/v0/chat/create_pow_challenge   → 拿挑战
  ↓ 用官方 wasm 求解（DeepSeekHashV1）
POST /api/v0/chat_session/create         → 拿会话 UUID
POST /api/v0/chat/completion             → SSE 流式返回
  ↓ 转成 OpenAI chunk / Anthropic 事件
```

- PoW 求解器：`src/deepseek-pow.mjs`（调用 `_ds-pow/sha3_wasm_bg.wasm`）
- 站点客户端：`src/deepseek.mjs`
- 协议转换：`src/deepseek-adapter.mjs`
- 分发层：`src/dispatch.mjs`

详见 `DEEPSEEK-反代可行性.md`。
