# 详细文档

**[README](../README.md)** 是主文档 —— 特性、设计取舍、和同类项目的区别都在那里。

这里放 README 塞不下的**操作细节**：逐平台部署、逐客户端接入、逐错误排障。

| 文档 | 你会用到它的场景 |
|---|---|
| [本地部署](setup.md) | 第一次装起来；后台常驻；开机自启（含可直接复制的 launchd / systemd 配置） |
| [客户端接入](clients.md) | 把 TraeWork / Cursor / Claude Code / Codex CLI / Cherry Studio 接上去 |
| [排障手册](troubleshooting.md) | 报错了不知道怎么办；按「鉴权 / 额度 / 路径 / 上下文 / 启动 / 号池」分类 |
| [模型与额度](models-and-quota.md) | 站点之间什么关系、额度怎么算、请求怎么路由、号池怎么选号 |

---

## 30 秒版本

```bash
git clone https://github.com/yuan240324/workbuddy-openai-proxy.git
cd workbuddy-openai-proxy
node server.mjs
```

1. 浏览器打开 <http://127.0.0.1:8788/console>
2. 在「账号登录」分页点登录，按提示授权
3. 在客户端里填三样东西：

| 字段 | 值 |
|---|---|
| Base URL / 请求地址 | `http://127.0.0.1:8788/v1` |
| API Key / 令牌 | `config.json` 里的 `apiKey` |
| 模型 ID | `default` |

**模型填 `default` 是有意的** —— 它是个虚拟模型，指向控制台里选定的「默认模型」。
以后想换 Claude / GLM / DeepSeek，在控制台点一下就行，客户端一个字都不用改。

---

## 这个项目和同类项目的区别

同品类里已经有不少项目（多叫 `workbuddy2api` / `codebuddy2api`），
它们绝大多数是**自托管网关** —— 给一台常开的机器、或一群共享额度的用户用。

这个项目的取向不一样：**它是给你自己这台电脑用的。**

| | 本项目 | 典型的 `*2api` 网关 |
|---|---|---|
| 运行时依赖 | **0 个**（只用 Node 内置模块） | 2 ~ 10 个，常见 Redis、FastAPI |
| 安装 | `git clone` + `node server.mjs` | Docker Compose，或 `pip install` + venv |
| 网页控制台 | ✅ 内置 | 多数没有，或拆成另一个项目 |
| Anthropic Messages | ✅ `/v1/messages` | 多数提供 |
| OpenAI Responses（Codex CLI） | ✅ `/v1/responses` | 部分提供 |
| 监听范围 | 只绑 `127.0.0.1` | 通常要对外提供服务 |
| 面向场景 | **本机个人自用** | 服务器 / 多人共享 |

完整对比与调研说明见 [README 的「和同类项目的区别」](../README.md#和同类项目的区别)。

**什么情况下不该用这个项目？** 如果你要的是「一台服务器挂多个人的账号、共享额度」，
那本项目的定位（只监听 `127.0.0.1`、单机自用）就不合适，去用那些网关项目更好。
