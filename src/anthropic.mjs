// Anthropic 兼容路由：/v1/messages、/v1/messages/count_tokens
// Trae 的「Claude 型自定义模型」走 Anthropic Messages 协议，这里做双向转换。
import { openChat, openChatRotating, aggregateFrames, classifyFrame, upstreamErrorMessage, newId } from './upstream.mjs';
import { resolveTarget } from './router.mjs';
import { isModelNotFound, isTransportFailure, isGatewayError } from './openai.mjs';
import { recordUsage } from './usage.mjs';
import { startSSE, writeSSEEvent, sendJson, sendError, writeAsync, estimateTokens } from './util.mjs';
import { requestLog, warn } from './log.mjs';

const stopReasonMap = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
};

function textFromBlocks(blocks) {
  if (typeof blocks === 'string') return blocks;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text || '')
    .join('');
}

/** Anthropic Messages 请求 → OpenAI Chat Completions 请求 */
export function toOpenAIBody(a) {
  const messages = [];
  const system = typeof a.system === 'string' ? a.system : textFromBlocks(a.system);
  if (system && system.trim()) messages.push({ role: 'system', content: system });

  for (const m of a.messages || []) {
    if (!m) continue;
    if (typeof m.content === 'string') {
      messages.push({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content });
      continue;
    }
    const blocks = Array.isArray(m.content) ? m.content : [];
    if (m.role === 'assistant') {
      const text = textFromBlocks(blocks);
      const toolUses = blocks.filter((b) => b && b.type === 'tool_use');
      const msg = { role: 'assistant', content: text || null };
      if (toolUses.length) {
        msg.tool_calls = toolUses.map((t, i) => ({
          id: t.id || `call_${i}`,
          type: 'function',
          function: { name: t.name, arguments: typeof t.input === 'string' ? t.input : JSON.stringify(t.input ?? {}) },
        }));
      }
      messages.push(msg);
      continue;
    }

    // user：可能同时含 tool_result 与普通内容，工具结果必须先于后续用户文本
    const parts = [];
    const toolResults = [];
    for (const b of blocks) {
      if (!b) continue;
      if (b.type === 'text') parts.push({ type: 'text', text: b.text || '' });
      else if (b.type === 'image' && b.source) {
        const url = b.source.type === 'base64' ? `data:${b.source.media_type};base64,${b.source.data}` : b.source.url;
        parts.push({ type: 'image_url', image_url: { url } });
      } else if (b.type === 'tool_result') toolResults.push(b);
    }
    for (const r of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: r.tool_use_id,
        content: typeof r.content === 'string' ? r.content : textFromBlocks(r.content) || JSON.stringify(r.content ?? ''),
      });
    }
    if (parts.length) {
      const onlyText = parts.length === 1 && parts[0].type === 'text';
      messages.push({ role: 'user', content: onlyText ? parts[0].text : parts });
    }
  }

  const body = {
    model: a.model,
    messages,
    stream: a.stream !== false,
  };
  if (a.max_tokens) body.max_tokens = a.max_tokens;
  if (a.temperature !== undefined) body.temperature = a.temperature;
  if (a.top_p !== undefined) body.top_p = a.top_p;
  if (Array.isArray(a.stop_sequences) && a.stop_sequences.length) body.stop = a.stop_sequences;
  if (Array.isArray(a.tools) && a.tools.length) {
    body.tools = a.tools
      .filter((t) => t && t.name)
      .map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description || '', parameters: t.input_schema || { type: 'object', properties: {} } },
      }));
  }
  if (a.tool_choice) {
    const tc = a.tool_choice;
    if (tc.type === 'any') body.tool_choice = 'required';
    else if (tc.type === 'tool' && tc.name) body.tool_choice = tc.name;
    else if (tc.type === 'none') body.tool_choice = 'none';
    else body.tool_choice = 'auto';
  }
  return body;
}

function parseArgs(str) {
  if (!str) return {};
  try {
    return JSON.parse(str);
  } catch {
    return {};
  }
}

function usageOf(usage, fallbackIn, fallbackOut) {
  return {
    input_tokens: usage?.prompt_tokens ?? fallbackIn ?? 0,
    output_tokens: usage?.completion_tokens ?? fallbackOut ?? 0,
  };
}

export async function handleMessages(ctx) {
  const { cfg, res, body, signal } = ctx;
  const publicModel = body.model || cfg.defaultModel;
  const wantsStream = body.stream === true; // 与 Anthropic 规范一致：缺省为非流式
  const started = Date.now();
  const target = await resolveTarget(cfg, publicModel);
  let { site, model } = target;
  const openaiBody = toOpenAIBody({ ...body, model });
  if (openaiBody.max_tokens === undefined) openaiBody.max_tokens = cfg.defaultMaxTokens;

  // 请求上游（openChatRotating 内部处理 401 刷 token 与换号）；连接级失败时降级到备用站点
  const 打开一次 = async () => openChatRotating(cfg, site, openaiBody, { signal }).then((r) => r.up);

  let up;
  try {
    up = await 打开一次();
  } catch (e) {
    if (target.fallback && isTransportFailure(e) && !signal?.aborted) {
      warn(`[${site}] 连接失败（${e?.cause?.code || e?.message}），自动降级到备用站点 ${target.fallback.site} 重试`);
      site = target.fallback.site;
      model = target.fallback.model;
      openaiBody.model = target.fallback.model;
      up = await 打开一次();
    } else {
      throw e;
    }
  }

  // 钉死的站点上没有这个模型 → 同样降级重试
  if (!up.ok && target.fallback && isModelNotFound(up.status, up.text)) {
    warn(`[${site}] 没有模型 ${model}，自动降级到备用站点 ${target.fallback.site} 重试`);
    site = target.fallback.site;
    model = target.fallback.model;
    openaiBody.model = target.fallback.model;
    up = await 打开一次();
  }
  // 站点降级：上游网关故障（502/503/504）→ 换备用站点重试一次
  if (!up.ok && target.fallback && site !== target.fallback.site && isGatewayError(up.status)) {
    warn(`[${site}] 上游网关 ${up.status}，自动降级到备用站点 ${target.fallback.site} 重试`);
    site = target.fallback.site;
    model = target.fallback.model;
    openaiBody.model = target.fallback.model;
    up = await 打开一次();
  }
  if (!up.ok) {
    requestLog({ site, model, mode: wantsStream ? 'anthropic-stream' : 'anthropic-json', status: up.status, ms: Date.now() - started, note: 'upstream_reject' });
    return sendError(res, up.status, upstreamErrorMessage(up.status, up.text, site), 'api_error');
  }

  if (!wantsStream) {
    let agg;
    try {
      agg = await aggregateFrames(up.frames);
    } catch (e) {
      return sendError(res, e.status || 502, e.message, 'api_error');
    } finally {
      up.close();
    }
    // 兜底：max_tokens 过小导致空回答时放大预算重试一次
    const askedMax = Number(body.max_tokens ?? 0);
    if (!agg.content && agg.toolCallList.length === 0 && askedMax > 0 && askedMax < 1024) {
      warn(`[${site}] 空回答（finish=${agg.finishReason}，max_tokens=${askedMax}），放大到 1024 重试一次`);
      const up2 = await openChat(cfg, site, { ...openaiBody, max_tokens: Math.max(1024, askedMax * 4) }, { signal });
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
    const content = [];
    if (agg.content) content.push({ type: 'text', text: agg.content });
    for (const tc of agg.toolCallList) {
      content.push({ type: 'tool_use', id: tc.id || newId('toolu'), name: tc.function.name, input: parseArgs(tc.function.arguments) });
    }
    requestLog({ site, model, mode: 'anthropic-json', status: 200, ms: Date.now() - started });
    recordUsage({
      site,
      model,
      mode: 'anthropic-json',
      status: 200,
      promptTokens: agg.usage?.prompt_tokens ?? estimateTokens(JSON.stringify(body.messages || [])),
      completionTokens: agg.usage?.completion_tokens ?? estimateTokens(agg.content),
      credit: agg.usage?.credit ?? 0,
      ms: Date.now() - started,
      tools: agg.toolCallList.length,
    });
    return sendJson(res, 200, {
      id: newId('msg'),
      type: 'message',
      role: 'assistant',
      model: publicModel,
      content: content.length ? content : [{ type: 'text', text: '' }],
      stop_reason: stopReasonMap[agg.finishReason] || 'end_turn',
      stop_sequence: null,
      usage: usageOf(agg.usage, estimateTokens(JSON.stringify(body.messages || [])), estimateTokens(agg.content)),
    });
  }

  // 流式：把 OpenAI 增量翻译成 Anthropic SSE 事件序列
  startSSE(res, { 'X-Service': 'workbuddy-proxy', 'X-Upstream-Site': site });
  const msgId = newId('msg');
  let blockIndex = -1; // 当前打开的内容块
  let textBlockOpened = false;
  let nextBlock = 0;
  const toolBlocks = new Map(); // 上游 tool_call index → anthropic block index
  let finishReason = null;
  let usage = null;
  let textLen = 0;
  let closed = false;

  const emit = (event, data) => writeSSEEvent(res, event, JSON.stringify(data));

  const closeBlock = async () => {
    if (blockIndex >= 0) {
      await emit('content_block_stop', { type: 'content_block_stop', index: blockIndex });
      blockIndex = -1;
    }
  };

  try {
    await emit('message_start', {
      type: 'message_start',
      message: {
        id: msgId,
        type: 'message',
        role: 'assistant',
        model: publicModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: estimateTokens(JSON.stringify(body.messages || [])), output_tokens: 0 },
      },
    });

    for await (const payload of up.frames) {
      const parsed = classifyFrame(payload);
      if (parsed.kind === 'error') {
        await emit('error', { type: 'error', error: { type: 'api_error', message: parsed.message } });
        closed = true;
        break;
      }
      if (parsed.kind !== 'chunk') continue;
      const chunk = parsed.obj;
      if (chunk.usage) usage = chunk.usage;
      const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : null;
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};

      if (typeof delta.content === 'string' && delta.content) {
        if (!textBlockOpened) {
          await closeBlock();
          blockIndex = nextBlock++;
          textBlockOpened = true;
          await emit('content_block_start', { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } });
        }
        textLen += delta.content.length;
        await emit('content_block_delta', { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text: delta.content } });
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const key = Number.isInteger(tc.index) ? tc.index : 0;
          let bi = toolBlocks.get(key);
          if (bi === undefined) {
            await closeBlock();
            bi = nextBlock++;
            toolBlocks.set(key, bi);
            blockIndex = bi;
            await emit('content_block_start', {
              type: 'content_block_start',
              index: bi,
              content_block: { type: 'tool_use', id: tc.id || newId('toolu'), name: tc.function?.name || '' },
            });
          }
          const args = tc.function?.arguments;
          if (args) {
            await emit('content_block_delta', {
              type: 'content_block_delta',
              index: bi,
              delta: { type: 'partial_json', partial_json: args },
            });
          }
        }
      }
    }

    if (!closed) {
      await closeBlock();
      await emit('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: stopReasonMap[finishReason] || (toolBlocks.size ? 'tool_use' : 'end_turn'), stop_sequence: null },
        usage: { output_tokens: usage?.completion_tokens ?? Math.max(1, Math.ceil(textLen / 3)) },
      });
      await emit('message_stop', { type: 'message_stop' });
    }
  } catch (e) {
    warn('Anthropic 流式转发异常：', e.message);
    if (!res.writableEnded) {
      await emit('error', { type: 'error', error: { type: 'api_error', message: e.message } }).catch(() => {});
    }
  } finally {
    up.close();
    if (!res.writableEnded) res.end();
    requestLog({ site, model, mode: 'anthropic-stream', status: closed ? 502 : 200, ms: Date.now() - started, blocks: nextBlock });
    recordUsage({
      site,
      model,
      mode: 'anthropic-stream',
      status: closed ? 502 : 200,
      promptTokens: usage?.prompt_tokens ?? estimateTokens(JSON.stringify(body.messages || [])),
      completionTokens: usage?.completion_tokens ?? Math.max(1, Math.ceil(textLen / 3)),
      credit: usage?.credit ?? 0,
      ms: Date.now() - started,
      tools: toolBlocks.size,
    });
  }
}

export function handleCountTokens(ctx) {
  const { body, res } = ctx;
  const text = JSON.stringify(body.system || '') + JSON.stringify(body.messages || '') + JSON.stringify(body.tools || '');
  sendJson(res, 200, { input_tokens: estimateTokens(text) });
}
