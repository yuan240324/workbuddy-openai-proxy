# DeepSeek PoW（DeepSeekHashV1）—— 算法已彻底破解 ✅ 已线上验证 ✅

> **Round 11 破解算法，Round 12 线上验证通过。**
> 此前（Round 8-10）的"未打通"结论已被推翻——
> 那些测试失败不是因为算法不对，而是**哈希函数本身用错了**。

---

## 〇、线上验证结果（Round 12，真实 token + 真实服务端）

```
[1] 申请全新挑战   expire_at=1789256922375（与抓包样本完全不同）
[2] 求解 PoW      answer=41455，39ms        ← 服务端接受！
[3] 创建会话      session_id=41d5705c-...
[4] 发起补全      HTTP 200 text/event-stream
[5] 模型回复      "你好啊"（干净无脏数据）
```

通过真实代理服务的完整链路（Trae 视角，`ds-live.mjs` 15 项全过）：

| 测试 | 结果 |
|---|---|
| `/v1/models` | ✅ 5 个 deepseek 模型 |
| OpenAI 非流式 | ✅ "你好世界"（1.5s，含 PoW） |
| OpenAI 流式 | ✅ SSE + [DONE]，无脏数据 |
| Anthropic 非流式 | ✅ "收到"，end_turn |
| reasoner（深度思考） | ✅ 200 |

---

## 一、真实算法（已三重验证）

### 1. dsHash —— DeepSeekHashV1 哈希函数

由官方 wasm 的 `wasm_deepseek_hash_v1(dst, srcPtr, srcLen)` 实现：

- 输入任意字符串，输出 **64 字符 hex**（256 位）
- **不是标准 SHA3-256**（同样输入输出不同）—— 这就是之前所有猜测失败的根本原因
- 返回值布局：dst 处写入 `(outPtr: u32, outLen: u32)` 对，真正的摘要字符串在线性内存里

```js
// JS 调用方式
function dsHash(input) {
  const src = encoder.encode(input);
  const srcPtr = alloc(src.length, 1);
  memory.set(src, srcPtr);
  const dst = alloc(16, 1);
  wasm.wasm_deepseek_hash_v1(dst, srcPtr, src.length);
  const [outPtr, outLen] = /* 读 dst 的两个 u32 */;
  return Buffer.from(memory.slice(outPtr, outPtr + outLen)).toString('utf8');
}
```

### 2. 完整协议（原像搜索，非 hashcash）

```
服务端签发：随机选 secret n ∈ [0, difficulty)
            challenge = dsHash(`${salt}_${expire_at}_${n}`)

客户端求解：枚举 n = 0, 1, 2, ...
            找到 dsHash(`${salt}_${expire_at}_${n}`) === challenge 的最小 n
            该 n 即为 answer

difficulty = 搜索上限（保证解一定存在，最坏尝试 difficulty 次）
```

**这是"原像搜索"模型，不是我以为的"哈希低于阈值"（hashcash）模型。**

### 3. 三重验证（全部通过）

用真实抓包样本（salt=`ccd2d20978f6b8697919`，expire_at=`1789247493602`，
difficulty=`144000`，抓包 answer=`27720`）：

| 验证 | 结果 |
|---|---|
| `dsHash(prefix + 27720) === challenge` | ✅ **逐字符相等** |
| 纯 JS 从 0 枚举 | ✅ **精确复现 27720**（92ms，27721 次哈希） |
| **随机自造 5 个挑战** | ✅ **5/5 求解成功**（平均 147ms） |

第 3 项是 Round 8-10 一直缺失的**独立验证**——之前只能复现那一个样本，
现在对任意新挑战都能解。

### 4. 最坏情况性能

```
平均：约 100-150ms（answer 在 [0, difficulty) 内均匀分布，期望 difficulty/2 次哈希）
最坏：约 0.5s（answer = difficulty - 1）
实测：144000 上限下 92~150ms
```

对聊天请求完全可接受（Trae 场景单次请求多 0.1~0.5s 无感）。

---

## 二、之前的错误结论为何出现

| 轮次 | 错误结论 | 真相 |
|---|---|---|
| R3-R7 | "PoW 已攻克" | 只是复现了同一个样本（自证） |
| R8-R10 | "未打通，wasm 对输入敏感" | 用的是**标准 sha3-256**，而真实是自定义哈希 |
| R10 | "answer 与 difficulty 无关 ⇒ 非搜索" | 真实模型里 answer 确实与 difficulty 无关（difficulty 是上限）|
| R10 | "随机 0/2340 ⇒ 只对上游签发的有效" | 用错哈希函数，随机挑战当然解不出 |

**教训**：在逆向中，"调用约定正确"和"算法正确"是两回事。
我验证了前者（wasm_solve 的参数布局），却一直没验证后者——
因为第 3-7 轮的"复现"给了我虚假的信心。

**转折点**：Round 11 注意到 `wasm_deepseek_hash_v1` 输出的 8 字节
`78 00 11 00 40 00 00 00` 不是哈希值，而是 **(指针， 长度=64)** 对——
摘要字符串其实在线性内存里。读出它之后一切豁然开朗。

---

## 三、实现状态

`src/deepseek-pow.mjs` 已重写为纯 JS 原像搜索（仍用官方 wasm 算哈希）：

```js
export function solvePow(challenge) {
  const prefix = `${challenge.salt}_${challenge.expire_at}_`;
  for (let n = 0; n < challenge.difficulty; n++) {
    if (dsHash(prefix + n) === challenge.challenge) return n;
  }
  throw new Error('PoW 求解失败：未找到原像');
}
```

测试（`ds-pow-robust.mjs`，17 项）覆盖：

- dsHash 基本性质（确定性/雪崩/非标准算法）
- 原像模型（真实样本 + 相邻 n 对照）
- 端到端求解（114ms）
- **通用性（5 个随机挑战 5/5）** ← 核心验证
- difficulty 上限语义
- 接口健壮性
- 输出头格式（answer 为 JSON 数字）

---

## 四、项目当前状态

| 环节 | 状态 |
|---|---|
| token 校验 | ✅ 真实 token 验证过 |
| 创建会话 | ✅ 真实 token 验证过 |
| **PoW 求解** | ✅ **算法破解，随机挑战 5/5** |
| PoW 头格式 | ✅ 抓包确认 |
| 补全请求/响应 | ✅ 抓包逐字取得（SSE 帧） |
| OpenAI/Anthropic 转换 | ✅ 210 项测试（上游为 mock） |
| Trae 接入文档 | ✅ `DEEPSEEK-接入Trae手册.md` |

**剩余唯一未验证项**：真实网络下用真 token 完整跑一次（PoW 会被服务端接受吗）。
理论上应当成功——所有已知环节都已独立验证——但"理论上"和"实际上"之间
隔着一次真实的 HTTP 请求。

```powershell
cd "G:\trea\反代"
node login-deepseek.mjs    # 配置 token
node ds-e2e.mjs            # 端到端验证（会申请全新挑战并求解）
```

---

## 五、风险提示（不变）

- 逆向官方接口违反 DeepSeek 用户协议
- PoW 即反自动化措施，有封号风险（`40012 USER_IS_BANNED`）
- token 需手动续期（无刷新端点）
- 官方接口不支持工具调用，Trae Agent 模式不可用
- 官方随时可能更换算法（本实现基于 2026-09 抓包的 wasm 版本
  `sha3_wasm_bg.7b9ca65ddd.wasm`）
