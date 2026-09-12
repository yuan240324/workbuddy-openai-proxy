// 本地反代服务入口：把 WorkBuddy（CodeBuddy）账号能力暴露为
//   - OpenAI 兼容：/v1/models、/v1/chat/completions
//   - Anthropic 兼容：/v1/messages、/v1/messages/count_tokens
//   - 控制台：/console（本机网页控制台）
// 仅供本机（默认 127.0.0.1）使用，不读写本项目目录以外的任何文件。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig, paths, siteKeys, ROOT } from './src/config.mjs';
import { getAuth, isLoggedIn } from './src/auth.mjs';
import { handleChatCompletions, handleModels } from './src/openai.mjs';
import { handleMessages, handleCountTokens } from './src/anthropic.mjs';
import { queryCredit } from './src/upstream.mjs';
import { handleConsoleApi } from './src/console-api.mjs';
import { flushUsage } from './src/usage.mjs';
import { readJsonBody, sendJson, sendError } from './src/util.mjs';
import { log, warn, error } from './src/log.mjs';

const cfg = loadConfig();

// 控制台会话 token：每次启动随机生成，注入到控制台页面里；避免把 apiKey 暴露在浏览器中
const CONSOLE_TOKEN = crypto.randomBytes(16).toString('hex');
const CONSOLE_DIR = path.join(ROOT, 'console');

function consoleAuthorized(req) {
  if ((req.headers['x-console-token'] || '') === CONSOLE_TOKEN) return true;
  return authorized(req); // 也允许直接用 apiKey 调控制台接口（方便脚本）
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
  if (!cfg.apiKey) return true; // 未配置密钥则不校验（仅建议本机场景）
  return clientKey(req) === cfg.apiKey;
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
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

    if (!authorized(req)) {
      warn(`未授权的请求被拒绝：${req.method} ${pathname} key=${clientKey(req).slice(0, 6)}…`);
      return sendError(res, 401, 'API Key 不正确：请在请求头携带 Authorization: Bearer <config.json 里的 apiKey>', 'invalid_api_key');
    }

    if (pathname === '/') {
      return sendJson(res, 200, {
        service: 'workbuddy-proxy',
        console: `http://${cfg.host}:${cfg.port}/console`,
        endpoints: ['/v1/models', '/v1/chat/completions', '/v1/messages', '/v1/messages/count_tokens', '/status', '/health', '/console'],
        sites: siteKeys(cfg),
        default_site: cfg.defaultSite,
        default_model: cfg.defaultModel,
        config: paths.config,
      });
    }

    // 各站点登录态 + 剩余积分（国际版计费口径不同，查询失败只返回错误信息）
    if (pathname === '/status') {
      const only = url.searchParams.get('site');
      const keys = siteKeys(cfg).filter((s) => !only || s === only);
      const out = [];
      for (const site of keys) {
        const a = getAuth(site);
        let credit = null;
        if (isLoggedIn(site)) {
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
    // 这里按“路径里是否包含某段”来判断，只要语义明确就命中对应处理器。
    const seg = (s) => pathname.includes(s);
    const isCountTokens = req.method === 'POST' && (seg('/count_tokens') || seg('/count-tokens'));
    const isChat = req.method === 'POST' && seg('/chat/completions');
    const isMessages = req.method === 'POST' && seg('/messages');
    const isModels = req.method === 'GET' && pathname.endsWith('/models');

    if (isChat || isMessages) log(`→ ${req.method} ${pathname}${clientKey(req) ? '' : '（无 Key）'}`);

    if (isModels) {
      return await handleModels({ cfg, req, res });
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
      `未知路径 ${req.method} ${pathname}。可用：/v1/chat/completions（OpenAI 格式）、/v1/messages（Anthropic 格式）、/v1/models`,
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

server.listen(cfg.port, cfg.host, () => {
  log('WorkBuddy 反代已启动（国内版 + 国际版多站点）');
  log(`  控制台：http://${cfg.host}:${cfg.port}/console   ← 建议用桌面快捷方式打开`);
  log(`  监听地址：http://${cfg.host}:${cfg.port}   （仅本机可达）`);
  log(`  API Key：${cfg.apiKey}`);
  log(`  默认站点/模型：${cfg.defaultSite} / ${cfg.defaultModel}    配置文件：${paths.config}`);
  for (const s of siteState(cfg)) {
    log(`  站点 ${s.site.padEnd(9)} ${s.logged_in ? `已登录 uid=${s.uid}` : '未登录'}   ${s.apiBase}`);
  }
  log('  未登录的站点可在控制台「账号登录」里点一下，或运行：node login.mjs --site <站点名>');
  log(`  OpenAI 客户端：Base URL = http://${cfg.host}:${cfg.port}/v1`);
});

process.on('SIGINT', () => {
  log('收到退出信号，正在保存用量统计并关闭服务');
  flushUsage();
  server.close(() => process.exit(0));
});
process.on('unhandledRejection', (e) => error('未处理的 Promise 异常：', e));
