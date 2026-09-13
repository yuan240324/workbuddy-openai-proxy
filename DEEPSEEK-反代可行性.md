# DeepSeek 官方站点接入 —— 实施进度

> ## ✅ Round 11 重大突破：PoW 算法已彻底破解
>
> 此前（R8-R10）"未打通"的结论**已被推翻**——问题不在算法，而在**哈希函数**。
> 真实算法是**原像搜索**：`challenge = dsHash(prefix + secret_n)`，
> 客户端枚举 n 找原像。`dsHash` 是官方自定义哈希（非标准 SHA3），由
> `wasm_deepseek_hash_v1` 实现。
>
> **验证**：真实样本精确复现 27720（92ms）；**随机自造 5 个挑战 5/5 求解成功**。
> 详见 `DEEPSEEK-PoW结论修正.md`。
>
> 剩余：用真实 token 跑一次线上端到端（理论上应成功）。

> **全项目 210 项测试通过**（含真机 HTTP 端到端，上游为 mock）。

## 交付物清单

| 文件 | 作用 |
|---|---|
| **`DEEPSEEK-接入Trae手册.md`** | **用户操作手册（含 Trae 填写参数、常见问题、风险提示）** |
| `login-deepseek.mjs` | token 配置工具（粘贴式，自动校验+剥离包装） |
| `src/deepseek-pow.mjs` | DeepSeekHashV1 求解器（调用官方 wasm） |
| `src/deepseek.mjs` | 站点客户端（挑战/会话/补全/SSE/压平） |
| `src/deepseek-adapter.mjs` | 帧翻译（DeepSeek → OpenAI chunk） |
| `src/dispatch.mjs` | 上游分发层（按协议路由） |
| `_ds-pow/sha3_wasm_bg.wasm` | 官方 PoW wasm |
| 9 个 `ds-*.mjs` 测试 | 181 项自动化测试 |

## 一、交付物

| 文件 | 作用 | 测试 |
|---|---|---|
| `src/deepseek-pow.mjs` | DeepSeekHashV1 求解器（调用官方 wasm） | ✅ 逐字节验证 |
| `src/deepseek.mjs` | 站点客户端（挑战/会话/补全/SSE/压平） | ✅ 23 项 |
| `src/deepseek-adapter.mjs` | 帧翻译（DeepSeek → OpenAI chunk） | ✅ 19 项 |
| `src/dispatch.mjs` | **上游分发层（按协议路由，统一入口）** | ✅ 22 项 |
| `login-deepseek.mjs` | token 配置工具 | ✅ 各分支 |
| `src/config.mjs` | 新增 `deepseek` 站点预设 + `isDeepSeekSite` | ✅ 23 项 |
| `src/router.mjs` | DeepSeek 走 seed 目录，不拉取 | ✅ 11 项 |
| `src/openai.mjs` | 接入分发 | ✅ 22 项 |
| `src/anthropic.mjs` | 接入分发 | ✅ 22 项 |
| `src/console-api.mjs` | 模型探测走分发 | ✅ 22 项 |
| `_ds-pow/sha3_wasm_bg.wasm` | 官方 PoW wasm（26612B） | — |
| `_ds-pow/pow-worker.js` | 官方 worker 源码（算法参考） | — |

**测试合计：193 项全通过，0 失败。**

| 测试文件 | 项数 | 覆盖 |
|---|---|---|
| `ds-selftest.mjs` | 23 | 模块导入、请求头、SSE 解析、PoW |
| `ds-unit.mjs` | 23 | resolveOptions / flattenMessages |
| `ds-adapter-test.mjs` | 19 | 帧翻译、OpenAI 兼容 |
| `ds-dispatch-test.mjs` | 22 | 分发层（mock 网络） |
| `ds-delta-test.mjs` | 28 | extractDelta 全形态 |
| `ds-sse-test.mjs` | 13 | SSE 读取器 + 真实事件序列 |
| `ds-routing-test.mjs` | 11 | 路由分发、目录合并 |
| `ds-http-e2e.mjs` | 28 | 真机 HTTP 端到端（Trae 视角） |
| `ds-console-test.mjs` | 14 | 控制台「粘贴 token 登录」端点 |
| `ds-event-guard-test.mjs` | 12 | 事件白名单（防正文污染） |

所有测试运行后 `config.json` 的 MD5 保持不变，无凭证残留。

### `ds-http-e2e.mjs` —— 最有价值的测试

起一个**真实的 HTTP 服务器**（走 `server.mjs` 全部路由），只 mock DeepSeek 上游网络，
然后像 Trae 一样发真实请求。覆盖：

- API Key 鉴权（无 Key → 401）
- `GET /v1/models` 列出 deepseek 模型
- OpenAI 非流式 / 流式（SSE `[DONE]` 结尾、chunk 形状、首帧 role）
- Anthropic 非流式 / 流式（`message_start` → `content_block_delta` → `message_stop`）
- 路径容错（`/v1/messages/chat/completions` 这类重复拼接）
- 服务器日志中**无未处理异常**

## 一之三、Round 5 修复的运行时错误

### `ERR_INVALID_STATE: ReadableStream is locked`（每个请求都抛）
真机测试暴露：`src/deepseek.mjs` 的 `close()` 直接调用 `res.body.cancel()`，
但 SSE 读取器已锁住该流 → `cancel()` 抛错。

**关键点：`cancel()` 返回 rejected promise，是异步 rejection，`try/catch` 拦不住**，
因此表现为每个请求都产生一条「未处理的 Promise 异常」。

→ 改为读取器与 `close()` **共用同一个 reader**，并且显式 `.catch(() => {})` 吞掉 rejection。

> 这个 bug 只在真实 HTTP 服务器下才暴露——之前的 mock 测试全都测不出来。

## 一之五、Round 7 修复的正文污染 Bug

### 非正文事件的文本被混进回答里
`extractDelta()` 原本对**所有非终止帧**都递归扫描字符串，导致
`toast`（限流提示）、`hint`（提示语）、`ready`、`title` 等事件的文本
**被当成回答正文输出**。

实际影响：一旦上游发一条「操作过于频繁」的 toast，你的回复里就会凭空多出这句话。

→ 引入**事件白名单**：
- `NON_CONTENT_EVENTS`（ready/toast/title/hint/updateSession/updateParentMessage/updateFile）
  整帧忽略，即便带 `content`/`text` 字段也不收
- `CONTENT_EVENTS`（delta/text/message/think/thinking/reasoning）才提取正文
- 无名帧（裸载荷）仍按正文处理，兼容上游简化帧

新增 `ds-event-guard-test.mjs`（12 项）专门守住这条边界。

## 一之四、Round 6 补齐的功能

### 控制台支持 DeepSeek token 登录
控制台原本只有「设备授权登录」（OAuth），对 DeepSeek 会返回空链接。
→ 新增 `POST /console/api/login/token` 端点 + 前端 `promptTokenLogin()`
（弹出输入框粘贴 token，自动校验与保存）。

### 用户手册
新增 `DEEPSEEK-接入Trae手册.md`，包含：
- token 取法（含「允许粘贴」提示、手动取法、剪贴板快捷方式）
- 配置与启用步骤
- **Trae 填写参数表 + 三个模型别名说明**
- 常见问题排查表
- **限制与风险**（重点：不支持工具调用，Trae Agent 模式不可用）

## 一之二、本轮（Round 4）修复的两个真实 Bug

### Bug 1：Anthropic 路径完全绕过 DeepSeek 适配器
`anthropic.mjs` 有 2 处、`console-api.mjs` 有 1 处**直接调用 `openChat`**，
导致用 Anthropic 格式接入时 DeepSeek 完全不可用（会拿 CodeBuddy 协议打 DeepSeek 接口）。
→ 抽出 `src/dispatch.mjs` 作为唯一分发入口，3 处调用点全部收敛。

### Bug 2：`event: close` 无 data 行导致流挂起
官方有时只发 `event: close` 而不带 `data:` 行。原实现把 event 名存进
`pendingEvent` 后一直等 data 行，但永远等不到 → **流会挂到超时**。
→ 终止类事件（close/finish）改为立即上报，不等 data 行。

### 附带改进
- `extractDelta()` 重写为**格式无关**的递归扫描：
  - 修复原实现会把 `p` 路径字符串（如 `"response/content"`）**当作正文混入输出**的严重 bug
  - 元数据字段（id/status/role/type…）不再混入正文
  - 思考内容按路径关键词（thinking/reasoning）归入 `reasoning_content`
- SSE 读取器改为 **event 感知**：把 `event:` 名注入载荷（载荷缺 `type` 字段时尤其重要）

### 事件枚举（从官方 bundle 提取，确认无误）
```
ready / delta / toast / title / finish / close / hint
updateSession / updateParentMessage / updateFile
```
正文由 **`delta`** 事件承载（此前我按 HAR 的 `event: message` 推测，不够完整）。

## 二、关键验证证据

> ⚠️ **本节早期结论已被 Round 8 修正。** 下面这条「逐字节一致」只证明
> 「同一函数对同样输入返回同样输出」，**不能证明算法通用**。
> 保留在此仅作记录，请以 `DEEPSEEK-PoW结论修正.md` 为准。

用抓包样本做**密码学级别**验证：

```
输入：salt=ccd2d20978f6b8697919, expire_at=1789247493602, difficulty=144000
输出：answer = 27720                    ← 与官方 worker 一致
      base64 头 364 字节                ← 与抓包 X-DS-PoW-Response 严格相等
耗时：82ms
```

## 三、技术要点

### PoW 算法
```js
prefix = `${salt}_${expire_at}_`
answer = wasm_solve(challenge, prefix, difficulty)   // f64
```
wasm 签名（反汇编确认）：`wasm_solve (i32,i32,i32,i32,i32,f64) -> ()`
sret 布局：`[0..4)` i32 状态码（0=无解），`[8..16)` f64 答案。

### 踩过的四个坑
| 错误 | 正确 |
|---|---|
| difficulty 当 i32 | 必须 **f64** |
| answer 当字符串 | 必须 JSON **数字** |
| 用时间戳反推 expire_at | 必须取 challenge 响应的**真实值** |
| 用 Node crypto 复刻哈希 | 必须调**官方 wasm**（自定义算法） |

### 协议差异（与 CodeBuddy）
| 维度 | CodeBuddy | DeepSeek 官方 |
|---|---|---|
| 端点 | `/v2/chat/completions` | `/api/v0/chat/completion` |
| 入参 | messages 数组 | **单个 prompt 字符串** |
| 模型 | model ID | **无 model 概念**，用开关 |
| 鉴权 | OAuth 设备授权 + 自动刷新 | 粘贴 token，**无刷新** |
| 反爬 | 无 | **PoW 工作量证明** |

因此 DeepSeek 站点：多轮对话经 `flattenMessages()` 压平；模型名经 `resolveOptions()` 映射成 `thinking/search` 开关。

### 模型别名设计
| ID | 实际参数 |
|---|---|
| `deepseek-chat` | 默认 |
| `deepseek-reasoner` | `thinking_enabled=true` |
| `deepseek-search` | `search_enabled=true` |

## 四、剩余工作

- [ ] **用真实 token 验证**（阻塞中）
- [ ] 用真实 SSE 帧校准 `extractDelta()`（目前按推测实现，已测试 5 种帧形态）
- [ ] 在 `config.json` 启用 `deepseek` 站点
- [ ] 更新 README 的 Trae 接入章节

### 已完成（本轮补齐）
- [x] 抽出 `src/dispatch.mjs` 统一分发层
- [x] `anthropic.mjs` / `console-api.mjs` 的 3 处直连 `openChat` 改为走分发
      （原本会绕过 DeepSeek 适配器，导致 Anthropic 路径不可用）
- [x] 401 重试对 DeepSeek 跳过（其无刷新端点，避免无意义重试）
- [x] mock 网络跑通全链路测试（22 项）

## 五、启用步骤（拿到 token 后）

```powershell
cd "G:\trea\反代"

# 1) 配置 token（交互式粘贴）
node login-deepseek.mjs

# 2) 端到端验证
node ds-e2e.mjs

# 3) 在 config.json 里把 deepseek 站点 enabled 改为 true
#    （或告诉我，我来改）

# 4) 重启服务
stop.cmd
start-hidden.cmd
```

**Trae 接入参数**（重启后）：
- API 格式：OpenAI Chat Completions
- 完整 URL：`http://127.0.0.1:8788/v1/chat/completions`
- 模型 ID：`deepseek/deepseek-chat`（或 `deepseek-reasoner`）
- API 密钥：见 `config.json` 的 `apiKey`

## 六、风险提示

- 逆向官方接口违反 DeepSeek 用户协议；PoW 即反自动化措施
- 存在封号风险（错误码含 `40012 USER_IS_BANNED`）
- **token 过期需手动重贴**（未发现可用刷新端点）
- 官方接口无官方文档，随时可能变更
- 建议仅本人账号自用，勿外传、勿商用

## 七、安全措施

- `.gitignore` 已加入 `.ds-token` 与 `auth.deepseek.json`（原本**未覆盖**，已修复）
- token 文件以 0600 权限写入
- 测试过程中创建的临时凭证已全部清理，仓库无凭证残留
- 不保存账号密码（仅 token）
