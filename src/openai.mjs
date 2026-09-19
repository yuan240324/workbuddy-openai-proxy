// OpenAI 兼容路由：/v1/models、/v1/chat/completions（流式 + 非流式，支持工具调用）
// 多站点：请求里的 model 可写裸 ID（自动选站点），也可写 `站点/模型` 显式指定。
import { openChat, aggregateFrames, classifyFrame, upstreamErrorMessage, newId } from './upstream.mjs';
import { ensureToken } from './auth.mjs';
import { resolveTarget, mergedModels, parseMultiplier, isExcluded } from './router.mjs';
import { recordUsage } from './usage.mjs';
import { startSSE, writeSSE, sendJson, sendError, estimateTokens } from './util.mjs';
import { requestLog, warn } from './log.mjs';

/** 帧白名单重建：剥掉上游噪声（空 content、空 tool_calls、未知字段），保证标准客户端可解析。 */
export function normalizeChunk(obj, publicModel) {
  const out = {};
  for (const k of ['id', 'object', 'created', 'model', 'system_fingerprint', 'service_tier']) {
    if (obj[k] !== undefined && obj[k] !== null) out[k] = obj[k];
  }
  if (!out.object) out.object = 'chat.completion.chunk';
  if (!out.id) out.id = newId();
  if (publicModel) out.model = publicModel;

  if (Array.isArray(obj.choices)) {
    out.choices = obj.choices.map((c) => {
      const delta = {};
      const d = c.delta || {};
      if (typeof d.role === 'string' && d.role) delta.role = d.role;
      if (typeof d.content === 'string' && d.content) delta.content = d.content;
      if (typeof d.reasoning_content === 'string' && d.reasoning_content) delta.reasoning_content = d.reasoning_content;
      if (typeof d.refusal === 'string' && d.refusal) delta.refusal = d.refusal;
      if (Array.isArray(d.tool_calls) && d.tool_calls.length) delta.tool_calls = d.tool_calls;
      return { index: c.index ?? 0, delta, finish_reason: c.finish_reason || null };
    });
  }
  out.usage = obj.usage !== undefined ? obj.usage : null;
  return out;
}

/** 发起上游请求，遇 401 自动强刷该站点 token 重试一次。 */
async function openWithRetry(cfg, site, body, signal) {
  let up = await openChat(cfg, site, body, { signal });
  if (!up.ok && up.status === 401) {
    warn(`[${site}] 上游 401，强制刷新 token 后重试一次`);
    try {
      await ensureToken(cfg, site, { force: true });
    } catch (e) {
      warn(`[${site}] 刷新 token 失败：`, e.message);
    }
    up = await openChat(cfg, site, body, { signal });
  }
  return up;
}

/** 判断上游错误是否为「该站点没有这个模型」，据此触发站点降级。 */
export function isModelNotFound(status, text) {
  return status === 400 && /service info not found|model \[[^\]]+\] .*not found|no such model/i.test(String(text || ''));
}

/** 判断是否为「连接级失败」（网络抖动、连接被重置），同样触发站点降级。 */
export function isTransportFailure(e) {
  return e?.transport === true || e?.status === 504 || /ECONNRESET|UND_ERR_SOCKET|fetch failed|连接失败/i.test(String(e?.message || ''));
}

/**
 * 判断是否为「上游网关故障」：openresty / APISIX 在回源失败时直接返回的 HTTP 502/503/504。
 * 这类错误是「响应级」的——openChat 正常返回 { ok:false, status }，不抛异常，
 * 因此走不到上面 isTransportFailure 的异常分支；但同样属于站点级故障，必须触发降级。
 */
export function isGatewayError(status) {
  return status === 502 || status === 503 || status === 504;
}

/** 换个站点重试同一请求（用于降级）。 */
async function openWithFallback(cfg, target, upstreamBody, signal, 原因) {
  warn(`[${target.site}] ${原因}，自动降级到备用站点 ${target.fallback.site} 重试`);
  upstreamBody.model = target.fallback.model;
  return { up: await openWithRetry(cfg, target.fallback.site, upstreamBody, signal), site: target.fallback.site, model: target.fallback.model };
}

export async function handleChatCompletions(ctx) {
  const { cfg, res, body, signal } = ctx;
  const target = await resolveTarget(cfg, body.model);
  let { site, model } = target;
  const publicModel = target.requested;
  const wantsStream = body.stream === true;
  const started = Date.now();
  let ttfb = null;
  let tools = 0;
  let contentChars = 0;

  const upstreamBody = { ...body, model };
  if (upstreamBody.max_tokens === undefined && upstreamBody.max_completion_tokens === undefined) {
    upstreamBody.max_tokens = cfg.defaultMaxTokens;
  }

  let up;
  try {
    up = await openWithRetry(cfg, site, upstreamBody, signal);
  } catch (e) {
    // 连接级失败（国际版网络抖动）→ 换站点重试一次
    if (target.fallback && isTransportFailure(e) && !signal?.aborted) {
      const r = await openWithFallback(cfg, target, upstreamBody, signal, `连接失败（${e?.cause?.code || e?.message}）`);
      up = r.up;
      site = r.site;
      model = r.model;
    } else {
      throw e;
    }
  }

  // 站点降级：路由表把模型钉到了某站点，但那个站点其实没有这个模型时，
  // 自动换到真正拥有该模型的站点重试一次（配置里想强制走国际版，这里兜住例外情况）
  if (!up.ok && target.fallback && isModelNotFound(up.status, up.text)) {
    const r = await openWithFallback(cfg, target, upstreamBody, signal, `没有模型 ${model}`);
    up = r.up;
    site = r.site;
    model = r.model;
  }
  // 站点降级：上游网关故障（openresty/APISIX 回源失败返回 502/503/504）→ 换备用站点重试一次。
  // 加 site !== fallback 的判断，避免上一段降级后再次对同一站点重试。
  if (!up.ok && target.fallback && site !== target.fallback.site && isGatewayError(up.status)) {
    const r = await openWithFallback(cfg, target, upstreamBody, signal, `上游网关 ${up.status}`);
    up = r.up;
    site = r.site;
    model = r.model;
  }
  if (!up.ok) {
    requestLog({ site, model, mode: wantsStream ? 'stream' : 'json', status: up.status, ms: Date.now() - started, note: 'upstream_reject' });
    return sendError(res, up.status, upstreamErrorMessage(up.status, up.text, site));
  }

  if (wantsStream) {
    startSSE(res, { 'X-Service': 'workbuddy-proxy', 'X-Upstream-Site': site });
    let valid = 0;
    let finished = false;
    let upstreamUsage = null;
    try {
      for await (const payload of up.frames) {
        const parsed = classifyFrame(payload);
        if (parsed.kind === 'error') {
          await writeSSE(res, JSON.stringify({ error: { message: parsed.message, type: 'upstream_error' } }));
          break;
        }
        if (parsed.kind !== 'chunk') continue;
        if (parsed.obj.usage) upstreamUsage = parsed.obj.usage;
        if (parsed.obj.choices?.[0]?.delta?.tool_calls) tools++;
        if (ttfb === null) ttfb = Date.now() - started;
        valid++;
        if (parsed.obj.choices?.[0]?.delta?.content) contentChars += parsed.obj.choices[0].delta.content.length;
        await writeSSE(res, JSON.stringify(normalizeChunk(parsed.obj, publicModel)));
      }
      if (valid === 0) {
        await writeSSE(res, JSON.stringify({ error: { message: '上游返回空流', type: 'upstream_error' } }));
      }
      finished = true;
      await writeSSE(res, '[DONE]');
    } finally {
      up.close();
      if (!res.writableEnded) res.end();
      requestLog({
        site,
        model,
        mode: 'stream',
        status: finished ? 200 : 499,
        ttfb_ms: ttfb ?? '-',
        ms: Date.now() - started,
        frames: valid,
      });
      recordUsage({
        site,
        model,
        mode: 'stream',
        status: finished ? 200 : 499,
        promptTokens: upstreamUsage?.prompt_tokens ?? estimateTokens(JSON.stringify(body.messages || [])),
        completionTokens: upstreamUsage?.completion_tokens ?? estimateTokens('x'.repeat(contentChars)),
        credit: upstreamUsage?.credit ?? 0,
        ms: Date.now() - started,
        tools,
      });
    }
    return;
  }

  // 非流式：聚合上游 SSE 后一次性返回
  let agg;
  try {
    agg = await aggregateFrames(up.frames);
  } catch (e) {
    requestLog({ site, model, mode: 'json', status: e.status || 502, ms: Date.now() - started, note: 'aggregate_failed' });
    return sendError(res, e.status || 502, e.message);
  } finally {
    up.close();
  }

  // 兜底：客户端 max_tokens 太小（思考型模型把预算全用在思考上）导致空回答时，放大预算重试一次
  const askedMax = Number(body.max_tokens ?? body.max_completion_tokens ?? 0);
  const emptyAnswer = !agg.content && agg.toolCallList.length === 0;
  if (emptyAnswer && (agg.finishReason === 'length' || agg.frames > 0) && askedMax > 0 && askedMax < 1024) {
    const bumped = { ...upstreamBody, max_tokens: Math.max(1024, askedMax * 4) };
    delete bumped.max_completion_tokens;
    warn(`[${site}] 空回答（finish=${agg.finishReason}，max_tokens=${askedMax}），放大到 ${bumped.max_tokens} 重试一次`);
    const up2 = await openWithRetry(cfg, site, bumped, signal);
    if (up2.ok) {
      try {
        agg = await aggregateFrames(up2.frames);
      } catch {
        /* 保留原结果 */
      } finally {
        up2.close();
      }
    } else {
      up2.close?.();
    }
  }

  if (agg.frames === 0) {
    requestLog({ site, model, mode: 'json', status: 502, ms: Date.now() - started, note: 'empty_stream' });
    return sendError(res, 502, '上游返回空响应');
  }

  const message = { role: agg.role || 'assistant' };
  if (agg.content) message.content = agg.content;
  else message.content = agg.toolCallList.length ? null : '';
  if (agg.reasoning) message.reasoning_content = agg.reasoning;
  if (agg.toolCallList.length) {
    message.tool_calls = agg.toolCallList.map((tc, i) => ({
      id: tc.id || `call_${i}_${Date.now().toString(36)}`,
      type: 'function',
      function: { name: tc.function.name, arguments: tc.function.arguments || '{}' },
    }));
  }

  const usage =
    agg.usage ||
    {
      prompt_tokens: estimateTokens(JSON.stringify(body.messages || [])),
      completion_tokens: estimateTokens(agg.content),
      total_tokens: estimateTokens(JSON.stringify(body.messages || [])) + estimateTokens(agg.content),
    };

  requestLog({
    site,
    model,
    mode: 'json',
    status: 200,
    ms: Date.now() - started,
    prompt: usage.prompt_tokens,
    completion: usage.completion_tokens,
    tools: agg.toolCallList.length || undefined,
  });

  recordUsage({
    site,
    model,
    mode: 'json',
    status: 200,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    credit: usage.credit ?? 0,
    ms: Date.now() - started,
    tools: agg.toolCallList.length,
  });

  sendJson(res, 200, {
    id: agg.id || newId(),
    object: 'chat.completion',
    created: agg.created || Math.floor(Date.now() / 1000),
    model: publicModel,
    choices: [{ index: 0, message, finish_reason: agg.finishReason || 'stop' }],
    usage,
  });
}

export async function handleModels(ctx) {
  const { cfg, res } = ctx;
  const merged = await mergedModels(cfg);
  const data = [];
  const seen = new Set();

  // 别名：先解析到真实模型，若目标已被白/黑名单剔除，就不要再列进目录
  // （否则客户端会照目录逐个探测，必然失败）
  for (const [alias, targetModel] of Object.entries(cfg.modelAliases || {})) {
    if (seen.has(alias)) continue;
    try {
      const t = await resolveTarget(cfg, alias);
      if (isExcluded(cfg, t.site, t.model)) continue;
    } catch {
      continue; // 解析不了（目标被剔除等）就不列出
    }
    seen.add(alias);
    data.push({ id: alias, object: 'model', created: 1700000000, owned_by: 'workbuddy', name: `${alias} → ${targetModel}` });
  }

  for (const m of merged) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const info = m.info || {};
    const item = {
      id: m.id,
      object: 'model',
      created: 1700000000,
      owned_by: m.site,
      name: info.name || m.id,
      site: m.site,
    };
    if (info.credits) {
      item.credits = info.credits; // 上游原始串，如 "x0.79 credits"
      const mult = parseMultiplier(info.credits);
      if (Number.isFinite(mult)) item.credits_multiplier = mult;
    }
    if (info.contextWindow) item.context_window = info.contextWindow;
    if (info.maxTokens) item.max_output_tokens = info.maxTokens;
    if (info.supportsImages) item.supports_images = true;
    if (info.supportsToolCall) item.supports_tools = true;
    if (m.aliasOf) item.alias_of = m.aliasOf;
    data.push(item);
  }

  // 目录拉取失败（未登录/接口不可用）时用配置兜底，保证客户端至少能看到可用 ID
  if (!merged.length) {
    for (const m of cfg.models || []) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      data.push({ id: m.id, object: 'model', created: 1700000000, owned_by: 'workbuddy', name: m.name || m.id, site: cfg.defaultSite });
    }
  }

  sendJson(res, 200, { object: 'list', data, source: merged.length ? 'upstream' : 'config' });
}
