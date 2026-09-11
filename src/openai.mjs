// OpenAI 兼容路由：/v1/models、/v1/chat/completions（流式 + 非流式，支持工具调用）
import { openChat, aggregateFrames, classifyFrame, fetchModels, upstreamErrorMessage, newId } from './upstream.mjs';
import { ensureToken } from './auth.mjs';
import { startSSE, writeSSE, sendJson, sendError, estimateTokens } from './util.mjs';
import { requestLog, warn } from './log.mjs';

let modelCache = { at: 0, list: null };

export function resolveModel(cfg, requested) {
  const raw = (requested || '').trim();
  if (!raw) return cfg.defaultModel;
  return cfg.modelAliases?.[raw] || raw;
}

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
      const nc = { index: c.index ?? 0, delta, finish_reason: c.finish_reason || null };
      return nc;
    });
  }
  if (obj.usage !== undefined) out.usage = obj.usage;
  else out.usage = null;
  return out;
}

/** 发起上游请求，遇 401 自动强刷 token 重试一次。 */
async function openWithRetry(cfg, body, signal) {
  let up = await openChat(cfg, body, { signal });
  if (!up.ok && up.status === 401) {
    warn('上游 401，强制刷新 token 后重试一次');
    try {
      await ensureToken(cfg, { force: true });
    } catch (e) {
      warn('刷新 token 失败：', e.message);
    }
    up = await openChat(cfg, body, { signal });
  }
  return up;
}

export async function handleChatCompletions(ctx) {
  const { cfg, res, body, signal } = ctx;
  const publicModel = (body.model || cfg.defaultModel).trim();
  const model = resolveModel(cfg, body.model);
  const wantsStream = body.stream === true;
  const started = Date.now();
  let ttfb = null;

  const upstreamBody = { ...body, model };
  if (upstreamBody.max_tokens === undefined && upstreamBody.max_completion_tokens === undefined) {
    upstreamBody.max_tokens = cfg.defaultMaxTokens;
  }

  const up = await openWithRetry(cfg, upstreamBody, signal);
  if (!up.ok) {
    requestLog({ model, mode: wantsStream ? 'stream' : 'json', status: up.status, ms: Date.now() - started, note: 'upstream_reject' });
    return sendError(res, up.status, upstreamErrorMessage(up.status, up.text));
  }

  if (wantsStream) {
    startSSE(res, { 'X-Service': 'workbuddy-proxy' });
    let valid = 0;
    let finished = false;
    try {
      for await (const payload of up.frames) {
        const parsed = classifyFrame(payload);
        if (parsed.kind === 'error') {
          await writeSSE(res, JSON.stringify({ error: { message: parsed.message, type: 'upstream_error' } }));
          break;
        }
        if (parsed.kind !== 'chunk') continue;
        if (ttfb === null) ttfb = Date.now() - started;
        valid++;
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
        model,
        mode: 'stream',
        status: finished ? 200 : 499,
        ttfb_ms: ttfb ?? '-',
        ms: Date.now() - started,
        frames: valid,
      });
    }
    return;
  }

  // 非流式：聚合上游 SSE 后一次性返回
  let agg;
  try {
    agg = await aggregateFrames(up.frames);
  } catch (e) {
    requestLog({ model, mode: 'json', status: e.status || 502, ms: Date.now() - started, note: 'aggregate_failed' });
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
    warn(`空回答（finish=${agg.finishReason}，max_tokens=${askedMax}），放大到 ${bumped.max_tokens} 重试一次`);
    const up2 = await openWithRetry(cfg, bumped, signal);
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
    requestLog({ model, mode: 'json', status: 502, ms: Date.now() - started, note: 'empty_stream' });
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
      total_tokens:
        estimateTokens(JSON.stringify(body.messages || [])) + estimateTokens(agg.content),
    };

  requestLog({
    model,
    mode: 'json',
    status: 200,
    ms: Date.now() - started,
    prompt: usage.prompt_tokens,
    completion: usage.completion_tokens,
    tools: agg.toolCallList.length || undefined,
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
  const now = Date.now();
  let list = cfg.models || [];
  let source = 'config';
  const withCache = process.env.WB_FORCE_DYNAMIC_MODELS !== '1';
  if (withCache && modelCache.list && now - modelCache.at < 5 * 60 * 1000) {
    list = modelCache.list;
    source = 'upstream(cache)';
  } else {
    try {
      const dynamic = await fetchModels(cfg);
      if (dynamic?.length) {
        list = dynamic;
        source = 'upstream';
        modelCache = { at: now, list: dynamic };
      }
    } catch (e) {
      warn('动态模型清单获取失败，使用配置兜底：', e.message);
    }
  }

  const data = [];
  const seen = new Set();
  for (const [alias, target] of Object.entries(cfg.modelAliases || {})) {
    if (seen.has(alias)) continue;
    seen.add(alias);
    data.push({ id: alias, object: 'model', created: 1700000000, owned_by: 'workbuddy', name: `${alias} → ${target}` });
  }
  for (const m of list) {
    if (seen.has(m.id)) continue;
    seen.add(m.id);
    const item = { id: m.id, object: 'model', created: 1700000000, owned_by: 'workbuddy', name: m.name || m.id };
    if (m.contextWindow) item.context_window = m.contextWindow;
    if (m.maxTokens) item.max_output_tokens = m.maxTokens;
    data.push(item);
  }
  sendJson(res, 200, { object: 'list', data, source });
}
