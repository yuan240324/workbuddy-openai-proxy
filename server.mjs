// 本地反代服务入口：把 WorkBuddy（CodeBuddy）账号能力暴露为
//   - OpenAI 兼容：/v1/models、/v1/chat/completions
//   - Anthropic 兼容：/v1/messages、/v1/messages/count_tokens
//   - 控制台：/console（本机网页控制台）
// 仅供本机（默认 127.0.0.1）使用，不读写本项目目录以外的任何文件。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, getLastConfigIssues, paths, siteKeys, ROOT } from './src/config.mjs';
import { getAuth, isLoggedIn } from './src/auth.mjs';
import { handleChatCompletions, handleModels } from './src/openai.mjs';
import { handleResponses } from './src/responses.mjs';
import { handleMessages, handleCountTokens } from './src/anthropic.mjs';
import { queryCredit, supportsCreditQuery } from './src/upstream.mjs';
import { handleConsoleApi } from './src/console-api.mjs';
import { flushUsage } from './src/usage.mjs';
import { flushPool } from './src/pool.mjs';
import { createRateLimiter } from './src/ratelimit.mjs';
import { readJsonBody, sendJson, sendError } from './src/util.mjs';
import { log, warn, error } from './src/log.mjs';

// 配置读不出来时要给出可读提示，而不是抛一串裸栈。
// 尤其是 JSON 语法错误——用户手改 config.json 很容易漏个逗号。
let cfg;
let configIssues = [];
try {
  cfg = loadConfig();
  // loadConfig 内部已完成校验与降级，并记录了发现的问题（getLastConfigIssues）
  configIssues = getLastConfigIssues();
} catch (e) {
  error('读取 config.json 失败，服务无法启动：');
  error(`  ${e.message}`);
  if (e.code === 'INVALID_CONFIG_JSON') {
    error(`  文件位置：${paths.config}`);
    error('  常见原因：手改时漏了逗号、多了逗号，或用了单引号（JSON 只认双引号）。');
    error('  可以用 node -e "JSON.parse(require(\'fs\').readFileSync(\'config.json\',\'utf8\'))" 检查语法。');
    error('  修好后重新启动；若想回到默认配置，可先备份再删除该文件。');
  }
  process.exit(1);
}

// 控制台会话 token：每次启动随机生成，注入到控制台页面里；避免把 apiKey 暴露在浏览器中
const CONSOLE_TOKEN = crypto.randomBytes(16).toString('hex');
const CONSOLE_DIR = path.join(ROOT, 'console');

// ---- 限流 ----
// 服务只绑 127.0.0.1，所以要挡的不是远程攻击，而是：
//   - 客户端 bug 造成的失控重试循环
//   - 重端点被反复触发（/console/api/probe 一次最多 60 次上游调用 + 至少 15 秒）
// 放在**鉴权与路由之前**：这样未授权的请求也能被廉价拒掉，
// 而不是先做完鉴权才发现对方在刷。
// 默认值刻意放宽，正常单用户使用（含编码 agent 的工具调用突发）远达不到。
const 限流配置 = cfg.rateLimit || {};
const 限流开启 = 限流配置.enabled !== false;
const 全局限流 = 限流开启
  ? createRateLimiter({ windowMs: 限流配置.windowMs, max: 限流配置.max })
  : null;
// /probe 单独一档，阈值更严
const 探测限流 = 限流开启 ? createRateLimiter({ windowMs: 限流配置.windowMs, max: 限流配置.probeMax }) : null;

/** 请求来源标识：本机服务下基本恒为回环地址，但仍按 IP 记，绑 0.0.0.0 时才有区分度。 */
function 来源标识(req) {
  return req.socket?.remoteAddress || 'unknown';
}

function consoleAuthorized(req) {
  if ((req.headers['x-console-token'] || '') === CONSOLE_TOKEN) return true;
  return authorized(req); // 也允许直接用 apiKey 调控制台接口（方便脚本）
}

/**
 * 本机来源校验（用于 /console 页面与控制台接口）。
 *
 * 为什么需要：服务虽只监听 127.0.0.1，但本机服务对「用户浏览器里打开的任意网页」同样可达。
 * 跨站页面发起 fetch('http://127.0.0.1:8788/console') 时，源是恶意页面、目标是本机，
 * 若响应带 ACAO:* 且页面无需鉴权，对方就能读走内联在 HTML 里的会话 token，
 * 进而调用控制台接口（切模型 / 删凭证 / 停服）。因此这里必须校验来源。
 *
 * 判定规则：
 *   - 无 Origin（curl / ask.mjs / stop.mjs 等本机工具，以及同源导航）→ 放行
 *   - Origin 的 host 属于本机回环地址（localhost / 127.x / [::1]）→ 放行
 *   - 其他一律拒绝
 * 同时校验 Host 头，抵御 DNS rebinding（恶意域名重绑定到 127.0.0.1 时 Host 仍是外部域名）。
 */
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

function isLoopbackHostname(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (LOOPBACK_HOSTNAMES.has(h)) return true;
  // 127.0.0.0/8 整个网段都视作本机
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/** 请求的 Host 是否指向本机（挡 DNS rebinding）。 */
function hostIsLocal(req) {
  const host = req.headers.host || '';
  if (!host) return true; // HTTP/1.0 等无 Host 的场景，交由 Origin 判定
  try {
    const { hostname } = new URL(`http://${host}`);
    return isLoopbackHostname(hostname);
  } catch {
    return false;
  }
}

/** 控制台来源是否可信。 */
function consoleOriginAllowed(req) {
  if (!hostIsLocal(req)) return false;
  const origin = req.headers.origin;
  if (!origin) return true; // 同源导航 / 本机工具：不带 Origin
  try {
    const { hostname } = new URL(origin);
    return isLoopbackHostname(hostname);
  } catch {
    return false;
  }
}

/** 汇总各站点登录状态。 */
function siteState(cfgIn) {
  return siteKeys(cfgIn).map((site) => {
    const a = getAuth(site);
    return {
      site,
      label: cfgIn.sites[site].label,
      apiBase: cfgIn.sites[site].apiBase,
      logged_in: isLoggedIn(site),
      uid: a.uid ? String(a.uid).slice(0, 8) + '…' : null,
      nickname: a.nickname || null,
      token_expires_at: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
    };
  });
}

function clientKey(req) {
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  return (req.headers['x-api-key'] || '').toString().trim() || auth.trim();
}

function authorized(req) {
  // 注意：apiKey 为空串时也必须视为「未配置密钥」而不是「放行」。
  // 原本的 !cfg.apiKey 会让被误清空的配置变成完全无鉴权，这里显式判定。
  const key = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim() : '';
  if (!key) return true; // 未配置密钥则不校验（仅建议本机场景）
  return clientKey(req) === key;
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  const isConsolePath = pathname === '/console' || pathname === '/console/' || pathname.startsWith('/console/api/');

  // 控制台相关路径：绝不设置 ACAO:*，否则任意网页都能跨域读走页面内的会话 token
  // （页面无需鉴权即可访问，token 明文中内联在 HTML 里）。同时禁止被 iframe 嵌入。
  if (isConsolePath) {
    res.setHeader('Vary', 'Origin');
    if (consoleOriginAllowed(req)) {
      const origin = req.headers.origin;
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Console-Token, Authorization, X-Api-Key');
        res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
      }
    } else {
      warn(`拒绝来自非本机来源的控制台请求：${req.method} ${pathname} origin=${req.headers.origin || '-'} host=${req.headers.host || '-'}`);
      return sendError(res, 403, '控制台仅允许本机访问', 'console_forbidden');
    }
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  } else {
    // 对话接口需要跨域（浏览器内的客户端），保持原有宽松策略
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // ---- 限流 ----
  // 位置：OPTIONS 之后（预检不计入）、鉴权与路由之前（未授权洪泛也能被廉价拒掉）。
  // 两级：全局一档；/console/api/probe 另有一档更严的阈值。
  if (全局限流) {
    const ip = 来源标识(req);
    const 全局结果 = 全局限流.hit(ip);
    const 是重端点 = pathname.startsWith('/console/api/probe');
    const 重端点结果 = 是重端点 && 探测限流 ? 探测限流.hit(ip) : null;
    if (全局结果.limited || 重端点结果?.limited) {
      const 等待毫秒 = Math.max(全局结果.retryAfterMs || 0, 重端点结果?.retryAfterMs || 0);
      res.setHeader('Retry-After', String(Math.max(1, Math.ceil(等待毫秒 / 1000))));
      warn(
        `请求过于频繁已限流：${req.method} ${pathname} ip=${ip}`
        + `${重端点结果?.limited ? '（重端点额度用尽）' : ''}`,
      );
      return sendError(res, 429, '请求过于频繁，请稍后再试', 'rate_limited');
    }
  }

  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) ac.abort(new Error('client closed'));
  });

  try {
    // 无需鉴权：健康检查
    if (pathname === '/health' || pathname === '/healthz') {
      const sites = siteState(cfg);
      return sendJson(res, 200, {
        status: sites.some((s) => s.logged_in) ? 'ok' : 'not_logged_in',
        service: 'workbuddy-proxy',
        sites,
        logged_in: sites.some((s) => s.logged_in),
      });
    }

    // 控制台页面（本机可达；页面内注入会话 token，不含 apiKey）
    if ((pathname === '/console' || pathname === '/console/') && req.method === 'GET') {
      const file = path.join(CONSOLE_DIR, 'index.html');
      if (!fs.existsSync(file)) return sendError(res, 500, '控制台文件缺失：console/index.html');
      let html = fs.readFileSync(file, 'utf8');
      html = html.replace('<head>', `<head>\n<script>window.__WB_TOKEN__=${JSON.stringify(CONSOLE_TOKEN)};</script>`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(html);
    }

    // 控制台 API（用会话 token 或 apiKey 鉴权）
    if (pathname.startsWith('/console/api/')) {
      if (!consoleAuthorized(req)) {
        warn(`控制台接口鉴权失败：${req.method} ${pathname}`);
        return sendError(res, 401, '控制台会话失效：请刷新页面重开 /console', 'invalid_console_token');
      }
      const body = req.method === 'POST' ? await readJsonBody(req) : null;
      return await handleConsoleApi({ cfg, req, res, url, body });
    }

    // 只读「发现类」接口：放行免鉴权。
    // 原因：不少客户端（如 CCSM / Codex 配置向导）会裸探基础地址与模型目录来做「同步模型」，
    // 不带 Authorization。这里只返回模型名与服务信息，不含任何密钥 / token，
    // 且服务只监听本机，因此免鉴权是安全的。
    if (req.method === 'GET' && pathname.endsWith('/models')) {
      res.setHeader('X-Service', 'workbuddy-proxy');
      return await handleModels({ cfg, req, res });
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/v1' || pathname === '/v1/')) {
      res.setHeader('X-Service', 'workbuddy-proxy');
      if (pathname !== '/') {
        // 基础地址被当成模型目录请求时，直接给一份 OpenAI 风格的模型列表
        return await handleModels({ cfg, req, res });
      }
      return sendJson(res, 200, {
        service: 'workbuddy-proxy',
        console: `http://${cfg.host}:${cfg.port}/console`,
        endpoints: ['/v1/models', '/v1/chat/completions', '/v1/responses', '/v1/messages', '/v1/messages/count_tokens', '/status', '/health', '/console'],
        sites: siteKeys(cfg),
        default_site: cfg.defaultSite,
        default_model: cfg.defaultModel,
        config: paths.config,
      });
    }

    if (!authorized(req)) {
      warn(`未授权的请求被拒绝：${req.method} ${pathname} key=${clientKey(req).slice(0, 6)}…`);
      return sendError(res, 401, 'API Key 不正确：请在请求头携带 Authorization: Bearer <config.json 里的 apiKey>', 'invalid_api_key');
    }

    // 各站点登录态 + 剩余积分（国际版计费口径不同，查询失败只返回错误信息）
    if (pathname === '/status') {
      const only = url.searchParams.get('site');
      const keys = siteKeys(cfg).filter((s) => !only || s === only);
      const out = [];
      for (const site of keys) {
        const a = getAuth(site);
        let credit = null;
        // 没有配置 billingBase 的站点不走计费接口，
        // 这里直接跳过，避免把「不适用」误报成查询失败。
        const creditSupported = supportsCreditQuery(cfg, site);
        if (isLoggedIn(site) && creditSupported) {
          try {
            credit = await queryCredit(cfg, site);
          } catch (e) {
            credit = { error: e.message };
          }
        }
        out.push({
          site,
          label: cfg.sites[site].label,
          apiBase: cfg.sites[site].apiBase,
          logged_in: isLoggedIn(site),
          uid: a.uid ? String(a.uid).slice(0, 8) + '…' : null,
          nickname: a.nickname || null,
          domain: a.domain || null,
          token_expires_at: a.expiresAt ? new Date(a.expiresAt).toISOString() : null,
          credit,
          credit_supported: creditSupported,
        });
      }
      return sendJson(res, 200, { sites: out, default_site: cfg.defaultSite });
    }

    // 优雅停止（供 stop.cmd / stop.mjs 调用；需要本地 API Key，避免被误触）
    if (pathname === '/admin/shutdown' && req.method === 'POST') {
      log('收到停止指令，服务即将退出');
      sendJson(res, 200, { ok: true, message: 'shutting down' });
      setTimeout(() => process.exit(0), 150);
      return;
    }

    // 路径容错：不同客户端拼接方式不同（如 TraeWork 会拼成 /v1/messages/chat/completions），
    // 这里按「路径中是否包含某段完整路径段」来判断，只要语义明确就命中对应处理器。
    //
    // 注意：用路径段（按 '/' 切分）匹配而不是裸 includes 子串，避免
    //   - 任意含 "messages" 子串的路径（如 /v1/mymessagesfoo）被误判
    //   - 仅后缀相似的路径（如 /v1/models2）被误判
    // 同时必须保留 TraeWork 那种「/v1/messages/chat/completions」的拼接容错，
    // 因此判定顺序为：responses → count_tokens → chat → messages（后者最宽，放最后）。
    //
    // 注：GET /v1/models 已在上面「免鉴权发现类接口」处提前处理，此处不再重复判断。
    const segs = pathname.split('/').filter(Boolean);
    const hasSeg = (...want) => {
      // 在 segments 里找连续匹配 want 的位置
      for (let i = 0; i + want.length <= segs.length; i++) {
        let ok = true;
        for (let j = 0; j < want.length; j++) {
          if (segs[i + j] !== want[j]) { ok = false; break; }
        }
        if (ok) return true;
      }
      return false;
    };
    const isCountTokens =
      req.method === 'POST' && (hasSeg('count_tokens') || hasSeg('count-tokens'));
    const isChat = req.method === 'POST' && hasSeg('chat', 'completions');
    const isMessages = req.method === 'POST' && hasSeg('messages');
    // Responses 协议（Codex 专用）：新增分支，不影响上面几条既有判断
    const isResponses = req.method === 'POST' && hasSeg('responses');

    if (isChat || isMessages) log(`→ ${req.method} ${pathname}${clientKey(req) ? '' : '（无 Key）'}`);

    if (isResponses) {
      const body = await readJsonBody(req);
      return await handleResponses({ cfg, req, res, body, signal: ac.signal, pathname });
    }

    if (isCountTokens) {
      const body = await readJsonBody(req);
      return handleCountTokens({ cfg, req, res, body });
    }

    if (isChat) {
      const body = await readJsonBody(req);
      return await handleChatCompletions({ cfg, req, res, body, signal: ac.signal, pathname });
    }

    if (isMessages) {
      const body = await readJsonBody(req);
      return await handleMessages({ cfg, req, res, body, signal: ac.signal, pathname });
    }

    warn(`收到未知路径请求：${req.method} ${pathname}（可选路径见 GET /）`);
    return sendError(
      res,
      404,
      `未知路径 ${req.method} ${pathname}。可用：/v1/chat/completions（OpenAI 格式）、/v1/responses（Codex 格式）、/v1/messages（Anthropic 格式）、/v1/models`,
      'not_found',
    );
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) error(`${req.method} ${pathname} 处理失败：`, e.stack || e.message);
    if (!res.headersSent) sendError(res, status, e.message || 'internal error');
    else if (!res.writableEnded) res.end();
  } finally {
    if (pathname !== '/health') {
      // 记录非健康检查请求的耗时（流式请求由各自 handler 记录明细）
      void started;
    }
  }
});

server.keepAliveTimeout = 120000;
server.requestTimeout = 0; // 流式长连接不设总时长上限

/** 把配置校验问题打出来（启动成功与否都要能看到）。 */
function reportConfigIssues() {
  if (!configIssues.length) return;
  warn(`config.json 有 ${configIssues.length} 处问题已自动回退（原值可能被忽略）：`);
  for (const msg of configIssues) warn(`  · ${msg}`);
}

// 端口被占用等情况要给出可操作的提示，而不是抛一串裸栈
server.on('error', (e) => {
  error(`服务启动失败：${e.code || e.message}`);
  if (e.code === 'EADDRINUSE') {
    error(`  端口 ${cfg.port} 已被占用。可能已经有一个实例在运行：`);
    error('    · 查看状态：node status.mjs');
    error('    · 停止旧实例：node stop.mjs   或双击 stop.cmd');
    error(`    · 或改 config.json 里的 port 换一个端口`);
  } else if (e.code === 'EACCES') {
    error(`  没有权限监听 ${cfg.host}:${cfg.port}（1024 以下端口通常需要管理员权限）`);
  }
  reportConfigIssues();
  process.exit(1);
});

server.listen(cfg.port, cfg.host, () => {
  log('WorkBuddy 反代已启动（国内版 + 国际版多站点）');
  log(`  控制台：http://${cfg.host}:${cfg.port}/console   ← 建议用桌面快捷方式打开`);
  log(`  监听地址：http://${cfg.host}:${cfg.port}   （仅本机可达）`);
  const keyLen = typeof cfg.apiKey === 'string' ? cfg.apiKey.trim().length : 0;
  if (!keyLen) {
    warn('  config.json 未配置 apiKey，服务当前不做鉴权（任何本机程序均可调用）。建议补一个随机密钥。');
  } else {
    // 不打印完整密钥，避免被日志文件/控制台历史泄露
    log(`  API Key：${cfg.apiKey.slice(0, 6)}…${cfg.apiKey.slice(-4)}（完整值见 config.json）`);
  }
  log(`  默认站点/模型：${cfg.defaultSite} / ${cfg.defaultModel}    配置文件：${paths.config}`);
  reportConfigIssues();
  for (const s of siteState(cfg)) {
    log(`  站点 ${s.site.padEnd(9)} ${s.logged_in ? `已登录 uid=${s.uid}` : '未登录'}   ${s.apiBase}`);
  }
  log('  未登录的站点可在控制台「账号登录」里点一下，或运行：node login.mjs --site <站点名>');
  log(`  OpenAI 客户端：Base URL = http://${cfg.host}:${cfg.port}/v1`);
});

process.on('SIGINT', () => {
  log('收到退出信号，正在保存用量统计并关闭服务');
  flushUsage();
  flushPool();
  server.close(() => process.exit(0));
});
process.on('unhandledRejection', (e) => error('未处理的 Promise 异常：', e));
