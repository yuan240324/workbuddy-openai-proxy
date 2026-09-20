// 上游分发层：按站点协议把请求送到对应实现。
//
// 背景：本项目有两套完全不同的上游协议——
//   - CodeBuddy / WorkBuddy（国内版 + 国际版）：/v2/chat/completions，messages 数组，OAuth
//   - DeepSeek 官方（chat.deepseek.com）：/api/v0/chat/completion，单 prompt，PoW
//
// openai.mjs 与 anthropic.mjs 都通过这里发起请求，从而只维护一份分发逻辑。
import { openChat, openChatRotating } from './upstream.mjs';
import { openDeepSeekChat } from './deepseek-adapter.mjs';
import { isDeepSeekSite } from './config.mjs';

/**
 * 打开一次上游聊天（自动按站点协议分发）。
 * 返回结构与 openChat 一致：{ok:true, frames, close()} 或 {ok:false, status, text}。
 */
export function openUpstream(cfg, site, body, { signal } = {}) {
  if (isDeepSeekSite(cfg.sites?.[site])) {
    return openDeepSeekChat(cfg, site, body, { signal });
  }
  return openChat(cfg, site, body, { signal });
}

/**
 * 带「账号轮换」的上游调用，三个协议入口共用。
 *
 * 标准协议走 openChatRotating（额度耗尽/失败自动换号 + 超长自动压缩）；
 * DeepSeek 官方站点是单账号模型（没有 OAuth 多账号体系），直接透传给它自己的实现。
 */
export async function openUpstreamRotating(cfg, site, body, opts = {}) {
  if (isDeepSeekSite(cfg.sites?.[site])) {
    const up = await openDeepSeekChat(cfg, site, body, { signal: opts.signal });
    return { up, tried: [] };
  }
  return openChatRotating(cfg, site, body, opts);
}

