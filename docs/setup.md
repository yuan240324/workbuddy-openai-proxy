# 本地部署

前置条件只有一个：**Node.js ≥ 18**。不需要 `npm install`、不需要 Docker、不需要 Python。

```bash
node -v        # 确认版本 ≥ 18
```

---

## 一、拿到代码并启动

```bash
git clone https://github.com/yuan240324/workbuddy-openai-proxy.git
cd workbuddy-openai-proxy
node server.mjs
```

启动后终端会打印监听地址、控制台地址、以及 API Key 的**掩码**形式。

> 不用 git 也可以：直接下载 ZIP 解压。没有构建步骤，解压即可运行。

---

## 二、登录账号

**方式 A：网页控制台（推荐）**

打开 <http://127.0.0.1:8788/console> →「账号登录」分页 → 点登录 →
按提示在浏览器里完成授权 → 回到控制台确认状态变成「已登录」。

**方式 B：命令行**

```bash
node login.mjs --list                     # 先看有哪些站点、当前登录状态
node login.mjs                            # 登录默认站点（国内版）
node login.mjs --site intl-cli            # 登录国际版 CLI
node login.mjs --site intl-work           # 登录国际版 WorkBuddy
node login.mjs --site cn-cli --label 小号  # 给账号起名，方便在号池里分辨
```

**国内版和国际版的额度是分开的**，各自登录、各算各的。想两边都用就登录两次。

---

## 三、验证它真的通了

```bash
node status.mjs        # 看各站点登录态 + 剩余积分
node ask.mjs           # 用默认模型问一句 —— 最快的一次端到端验证
node ask.mjs --list    # 列出当前可用的全部模型
```

`ask.mjs` 能正常拿到回复，就说明代理链路是通的，可以去接客户端了。

---

## 四、三平台差异

| | Windows | macOS | Linux |
|---|---|---|---|
| **前台运行** | `node server.mjs`<br>或双击 `start.cmd` | `node server.mjs` | `node server.mjs` |
| **后台常驻** | 双击 `start-hidden.vbs`（完全隐藏窗口） | `nohup node server.mjs >server.log 2>&1 &` | 同 macOS |
| **停止** | `stop.cmd`，或直接关掉窗口 | `node stop.mjs` | `node stop.mjs` |
| **打开控制台** | 桌面快捷方式 / `console-open.vbs` | 浏览器手动开 | 同 macOS |
| **登录授权** | 自动弹默认浏览器 | 自动弹默认浏览器 | 自动弹；无桌面环境加 `--no-open` |

> `console-open.vbs` / `console-open.mjs` 的好处：服务没在跑时会**自动把它拉起来**，
> 不用先手动开服务再开控制台。

---

## 五、开机自启

### Windows

1. 按 `Win + R`，输入 `shell:startup` 回车，打开「启动」文件夹
2. 在里面新建一个指向 `start-hidden.vbs` 的**快捷方式**

### macOS（launchd）

新建 `~/Library/LaunchAgents/com.local.workbuddy-proxy.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.local.workbuddy-proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/绝对路径/workbuddy-openai-proxy/server.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>/绝对路径/workbuddy-openai-proxy</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.local.workbuddy-proxy.plist
```

> `node` 的路径要用 `which node` 查到的**绝对路径** —— launchd 不读你的 shell 配置。

### Linux（systemd --user）

新建 `~/.config/systemd/user/workbuddy-proxy.service`：

```ini
[Unit]
Description=WorkBuddy OpenAI Proxy

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
```

---

## 六、配置文件在哪

所有状态都在**项目目录内**，不上传到任何地方：

| 文件 | 内容 |
|---|---|
| `config.json` | 端口、API Key、默认站点/模型、限流、压缩等 |
| `auth.<站点>.json` | 各站点的登录凭证（权限 0600） |
| `auth.<站点>.pool.json` | 账号池状态（配了多账号时才有） |
| `usage.json` | 用量统计与余额采样 |

> `config.json` 和 `auth.*.json` 都已被 `.gitignore` 忽略，**不会被提交**。
> 但如果你把整个项目目录拷给别人，记得先排除它们。

改完 `config.json` **需要重启服务**才生效 —— 配置只在启动时读一次。
