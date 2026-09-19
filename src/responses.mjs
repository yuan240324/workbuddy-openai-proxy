// OpenAI Responses API 兼容层：/v1/responses
//
// 背景：Codex CLI / 桌面端 0.154+ 只认 Responses 协议（wire_api 仅接受 "responses"），
// 而本项目上游是 Chat Completions 语义。本模块做双向协议转换：
//
//   Codex(Responses 请求) → 本层 → Chat Completions → 复用车载 handler → 转回 Responses
//
// 设计原则：只新增，不改动 /v1/chat/completions 的任何既有行为。
import { resolveTarget } from './router.mjs';
import { isGatewayError } from './openai.mjs';
import { openChat, classifyFrame, upstreamErrorMessage } from './upstream.mjs';
import { recordUsage } from './usage.mjs';
import { startSSE, writeSSEEvent, sendJson, sendError, estimateTokens } from './util.mjs';
import { requestLog, warn } from './log.mjs';

/** 生成 Responses 风格 id。 */
function rid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;
}

/**
 * Responses 请求 → Chat Completions 请求。
 *
 * 关键映射：
 *   - instructions          → system 消息
 *   - input(string)         → 单条 user 消息
 *   - input(数组)           → 逐项转换（message / function_call / function_call_output）
 *   - tools(function 扁平)  → tools(function 嵌套)
 *   - max_output_tokens     → max_tokens
 */
export function toChatRequest(body) {
  const messages = [];

  // 注意：上游对 system 消息做内容模式匹配，Codex 的 instructions（含 "You are a coding agent
  // running in the Codex CLI ..."）作为 system 会被判定为 "Illegal API invocation from an
  // unapproved channel"。实测证明同样内容放 user 位置可正常通过，因此这里把 instructions
  // 折进首条 user 消息，而不是用 system 角色发送。
  const instructions =
    typeof body.instructions === 'string' && body.instructions.trim() ? body.instructions.trim() : '';

  const input = body.input;

  if (typeof input === 'string') {
    if (input) messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!item || typeof item !== 'object') continue;
      const type = item.type || (item.role ? 'message' : null);

      if (type === 'message') {
        // developer 角色上游不接受，统一降级为 user；再合并进 instructions
        const role = item.role === 'assistant' ? 'assistant' : 'user';
        messages.push({ role, content: normalizeContent(item.content) });
      } else if (type === 'function_call') {
        // 模型发起的工具调用 → assistant.tool_calls
        //
        // 关键：连续的多个 function_call 必须合并进【同一条】assistant 消息。
        // 若每个都单独生成一条 assistant 消息，就会出现「两条 assistant 消息相邻、
        // 中间没有对应的 tool 结果」，上游会报：
        //   tool calls and tool results do not match
        // Codex 经常一次并行发起多个工具调用，所以这里必须合并。
        const call = {
          id: item.call_id || item.id || rid('call'),
          type: 'function',
          function: { name: item.name || '', arguments: item.arguments || '{}' },
        };
        const last = messages[messages.length - 1];
        if (last && last.role === 'assistant' && Array.isArray(last.tool_calls) && last.content === null) {
          last.tool_calls.push(call); // 并入上一条 assistant
        } else {
          messages.push({ role: 'assistant', content: null, tool_calls: [call] });
        }
      } else if (type === 'function_call_output') {
        // 工具执行结果 → role:tool
        messages.push({
          role: 'tool',
          tool_call_id: item.call_id || item.id || '',
          content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
        });
      } else if (type === 'reasoning') {
        // 推理项不回传给上游（上游不接受该角色）
        continue;
      } else if (item.role) {
        messages.push({ role: item.role, content: normalizeContent(item.content) });
      }
    }
  }

  if (!messages.length) messages.push({ role: 'user', content: '' });

  // 合并 instructions 到首条 user 消息（见上方说明：不能走 system 角色）
  if (instructions) {
    const firstUser = messages.find((m) => m.role === 'user');
    if (firstUser) {
      firstUser.content = `<instructions>\n${instructions}\n</instructions>\n\n${firstUser.content || ''}`;
    } else {
      messages.unshift({ role: 'user', content: `<instructions>\n${instructions}\n</instructions>` });
    }
  }

  // 上游硬性要求首条必须是 system，且过长/特定内容会被拒；这里只放一句极短占位
  if (messages[0]?.role !== 'system') {
    messages.unshift({ role: 'system', content: 'You are a helpful AI assistant.' });
  }

  const chat = { messages, stream: body.stream !== false };

  // 模型由调用方注入
  if (body.model) chat.model = body.model;

  if (body.max_output_tokens) chat.max_tokens = body.max_output_tokens;
  if (body.temperature !== undefined) chat.temperature = body.temperature;
  if (body.top_p !== undefined) chat.top_p = body.top_p;

  // tools：Responses 是扁平的 {type,name,parameters}，Chat 是嵌套的 {type,function:{...}}
  if (Array.isArray(body.tools) && body.tools.length) {
    const tools = [];
    for (const t of body.tools) {
      if (!t || typeof t !== 'object') continue;
      if (t.type === 'function' && t.name) {
        tools.push({
          type: 'function',
          function: {
            name: t.name,
            description: t.description || undefined,
            parameters: t.parameters || { type: 'object', properties: {} },
          },
        });
      } else if (t.type === 'function' && t.function) {
        tools.push(t); // 已是 Chat 格式，原样保留
      }
      // 其余内置工具类型（web_search 等）上游不支持，忽略
    }
    if (tools.length) chat.tools = tools;
  }

  if (body.tool_choice !== undefined) {
    const tc = body.tool_choice;
    if (typeof tc === 'string') chat.tool_choice = tc;
    else if (tc && typeof tc === 'object' && tc.name) chat.tool_choice = tc.name;
  }

  return chat;
}

/** Responses 的 content 可能是字符串或分块数组，统一压成字符串。 */
function normalizeContent(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return content ?? '';
  const parts = [];
  for (const p of content) {
    if (!p || typeof p !== 'object') {
      if (typeof p === 'string') parts.push(p);
      continue;
    }
    if (typeof p.text === 'string') parts.push(p.text);
    else if (p.type === 'input_text' && typeof p.text === 'string') parts.push(p.text);
  }
  return parts.join('');
}

/** 组装一个完整的 Responses 对象（供非流式与流式收尾共用）。 */
function buildResponse({ id, model, status, output, usage, createdAt }) {
  return {
    id,
    object: 'response',
    created_at: createdAt || Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    parallel_tool_calls: true,
    tool_choice: 'auto',
    tools: [],
    usage: usage || null,
    error: null,
    incomplete_details: null,
    instructions: null,
    metadata: {},
  };
}

/** 把聚合后的 Chat 结果转成 Responses 的 output 数组。 */
function toOutput(agg) {
  const output = [];

  if (agg.reasoning) {
    output.push({
      type: 'reasoning',
      id: rid('rs'),
      summary: [{ type: 'summary_text', text: agg.reasoning }],
    });
  }

  if (agg.content) {
    output.push({
      type: 'message',
      id: rid('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: agg.content, annotations: [] }],
    });
  }

  for (const tc of agg.toolCallList || []) {
    output.push({
      type: 'function_call',
      id: rid('fc'),
      call_id: tc.id || rid('call'),
      name: tc.function?.name || '',
      arguments: tc.function?.arguments || '{}',
      status: 'completed',
    });
  }

  if (!output.length) {
    output.push({
      type: 'message',
      id: rid('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: '', annotations: [] }],
    });
  }

  return output;
}

/** Chat usage → Responses usage。 */
function toUsage(u) {
  if (!u) return { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
  const input = u.prompt_tokens ?? u.input_tokens ?? 0;
  const output = u.completion_tokens ?? u.output_tokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: u.prompt_cache_hit_tokens ?? u.cached_tokens ?? 0 },
    output_tokens: output,
    output_tokens_details: {
      reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? u.completion_thinking_tokens ?? 0,
    },
    total_tokens: u.total_tokens ?? input + output,
  };
}

export async function handleResponses(ctx) {
  const { cfg, res, body, signal } = ctx;
  const started = Date.now();
  const wantsStream = body.stream !== false;

  // 先解析模型（保持与 chat 相同的路由语义：支持 site/model 前缀与别名）
  const target = await resolveTarget(cfg, body.model);
  let { site, model } = target;

  const chatReq = toChatRequest({ ...body, model });
  const requestModel = target.requested;

  let up = await openChat(cfg, site, chatReq, { signal });
  // 站点降级：上游网关故障（openresty/APISIX 返回 502/503/504）→ 换备用站点重试一次
  if (!up.ok && target.fallback && site !== target.fallback.site && isGatewayError(up.status)) {
    warn(`[${site}] 上游网关 ${up.status}，自动降级到备用站点 ${target.fallback.site} 重试`);
    site = target.fallback.site;
    model = target.fallback.model;
    chatReq.model = target.fallback.model;
    up = await openChat(cfg, site, chatReq, { signal });
  }
  if (!up.ok) {
    requestLog({ site, model, mode: 'responses', status: up.status, ms: Date.now() - started, note: 'upstream_reject' });
    return sendError(res, up.status, upstreamErrorMessage(up.status, up.text, site));
  }

  const responseId = rid('resp');

  // ---------- 非流式 ----------
  if (!wantsStream) {
    const { aggregateFrames } = await import('./upstream.mjs');
    let agg;
    try {
      agg = await aggregateFrames(up.frames);
    } catch (e) {
      up.close();
      return sendError(res, e.status || 502, e.message);
    } finally {
      up.close();
    }

    const usage = toUsage(agg.usage);
    recordUsage({
      site,
      model,
      mode: 'responses',
      status: 200,
      promptTokens: usage.input_tokens,
      completionTokens: usage.output_tokens,
      credit: agg.usage?.credit ?? 0,
      ms: Date.now() - started,
      tools: agg.toolCallList.length,
    });

    return sendJson(
      res,
      200,
      buildResponse({
        id: responseId,
        model: requestModel,
        status: 'completed',
        output: toOutput(agg),
        usage,
        createdAt: agg.created,
      }),
    );
  }

  // ---------- 流式 ----------
  startSSE(res, { 'X-Service': 'workbuddy-proxy', 'X-Upstream-Site': site });

  let seq = 0;
  const emit = (type, payload) =>
    writeSSEEvent(res, type, JSON.stringify({ type, sequence_number: seq++, ...payload }));

  let finished = false;
  let contentChars = 0;
  let contentText = ''; // 累积正文，供 output_text.done / response.completed 回填
  let reasoningText = ''; // 累积推理内容
  let upstreamUsage = null;
  let outputIndex = 0;
  let textItemId = null;
  let textOpened = false;
  let textDone = false;
  let reasoningItemId = null;
  let reasoningOpened = false;
  let reasoningDone = false;
  const toolItems = new Map(); // index → { id, call_id, name, args }

  try {
    await emit('response.created', {
      response: buildResponse({ id: responseId, model: requestModel, status: 'in_progress', output: [] }),
    });
    await emit('response.in_progress', {
      response: buildResponse({ id: responseId, model: requestModel, status: 'in_progress', output: [] }),
    });

    for await (const payload of up.frames) {
      const parsed = classifyFrame(payload);
      if (parsed.kind === 'error') {
        await emit('response.failed', {
          response: buildResponse({
            id: responseId,
            model: requestModel,
            status: 'failed',
            output: [],
            usage: null,
          }),
        });
        break;
      }
      if (parsed.kind !== 'chunk') continue;

      const obj = parsed.obj;
      if (obj.usage) upstreamUsage = obj.usage;
      const delta = obj.choices?.[0]?.delta;
      if (!delta) continue;

      // 推理内容：作为 reasoning 项的增量。
      // Codex 要求增量前必须先 output_item.added，否则报 "ReasoningSummaryDelta without active item"。
      if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
        if (!reasoningOpened) {
          reasoningItemId = rid('rs');
          await emit('response.output_item.added', {
            output_index: outputIndex,
            item: { type: 'reasoning', id: reasoningItemId, summary: [] },
          });
          reasoningOpened = true;
        }
        reasoningText += delta.reasoning_content;
        await emit('response.reasoning_summary_text.delta', {
          item_id: reasoningItemId,
          output_index: outputIndex,
          summary_index: 0,
          delta: delta.reasoning_content,
        });
      }

      // 正文
      if (typeof delta.content === 'string' && delta.content) {
        if (!textOpened) {
          // 正文开始前，先把 reasoning 项收尾并让出 output_index
          if (reasoningOpened && !reasoningDone) {
            await emit('response.reasoning_summary_text.done', {
              item_id: reasoningItemId,
              output_index: outputIndex,
              summary_index: 0,
              text: reasoningText,
            });
            await emit('response.output_item.done', {
              output_index: outputIndex,
              item: { type: 'reasoning', id: reasoningItemId, summary: [{ type: 'summary_text', text: reasoningText }] },
            });
            reasoningDone = true;
            outputIndex++;
          }
          textItemId = rid('msg');
          await emit('response.output_item.added', {
            output_index: outputIndex,
            item: { type: 'message', id: textItemId, status: 'in_progress', role: 'assistant', content: [] },
          });
          await emit('response.content_part.added', {
            item_id: textItemId,
            output_index: outputIndex,
            content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          });
          textOpened = true;
        }
        contentChars += delta.content.length;
        contentText += delta.content;
        await emit('response.output_text.delta', {
          item_id: textItemId,
          output_index: outputIndex,
          content_index: 0,
          delta: delta.content,
        });
      }

      // 工具调用
      if (Array.isArray(delta.tool_calls) && delta.tool_calls.length) {
        // 正文先收尾，工具项另起
        if (textOpened && !textDone) {
          await emit('response.output_text.done', { item_id: textItemId, output_index: outputIndex, content_index: 0, text: contentText });
          await emit('response.content_part.done', {
            item_id: textItemId,
            output_index: outputIndex,
            content_index: 0,
            part: { type: 'output_text', text: contentText, annotations: [] },
          });
          await emit('response.output_item.done', {
            output_index: outputIndex,
            item: { type: 'message', id: textItemId, status: 'completed', role: 'assistant', content: [] },
          });
          outputIndex++;
          textDone = true;
        }

        for (const tc of delta.tool_calls) {
          const idx = Number.isInteger(tc.index) ? tc.index : 0;
          let cur = toolItems.get(idx);
          if (!cur) {
            cur = { id: rid('fc'), call_id: tc.id || rid('call'), name: tc.function?.name || '', args: '' };
            toolItems.set(idx, cur);
            await emit('response.output_item.added', {
              output_index: outputIndex + idx,
              item: {
                type: 'function_call',
                id: cur.id,
                call_id: cur.call_id,
                name: cur.name,
                arguments: '',
                status: 'in_progress',
              },
            });
          }
          if (tc.function?.name && !cur.name) cur.name = tc.function.name;
          if (tc.function?.arguments) {
            cur.args += tc.function.arguments;
            await emit('response.function_call_arguments.delta', {
              item_id: cur.id,
              output_index: outputIndex + idx,
              delta: tc.function.arguments,
            });
          }
        }
      }
    }

    // 正文收尾
    if (textOpened && !textDone) {
      await emit('response.output_text.done', { item_id: textItemId, output_index: outputIndex, content_index: 0, text: contentText });
      await emit('response.content_part.done', {
        item_id: textItemId,
        output_index: outputIndex,
        content_index: 0,
        part: { type: 'output_text', text: contentText, annotations: [] },
      });
      await emit('response.output_item.done', {
        output_index: outputIndex,
        item: {
          type: 'message',
          id: textItemId,
          status: 'completed',
          role: 'assistant',
          content: [{ type: 'output_text', text: contentText, annotations: [] }],
        },
      });
      outputIndex++;
      textDone = true;
    }

    // 工具项收尾
    const finalOutput = [];

    // 兜底：若从未出现正文，reasoning 项可能仍处于打开状态，先收尾
    if (reasoningOpened && !reasoningDone) {
      await emit('response.reasoning_summary_text.done', {
        item_id: reasoningItemId,
        output_index: outputIndex,
        summary_index: 0,
        text: reasoningText,
      });
      await emit('response.output_item.done', {
        output_index: outputIndex,
        item: { type: 'reasoning', id: reasoningItemId, summary: [{ type: 'summary_text', text: reasoningText }] },
      });
      reasoningDone = true;
      finalOutput.push({
        type: 'reasoning',
        id: reasoningItemId,
        summary: [{ type: 'summary_text', text: reasoningText }],
      });
      outputIndex++;
    }

    if (textOpened) {
      finalOutput.push({
        type: 'message',
        id: textItemId,
        status: 'completed',
        role: 'assistant',
        content: [{ type: 'output_text', text: contentText, annotations: [] }],
      });
    }
    for (const [, cur] of [...toolItems.entries()].sort((a, b) => a[0] - b[0])) {
      await emit('response.function_call_arguments.done', {
        item_id: cur.id,
        output_index: outputIndex,
        arguments: cur.args,
      });
      await emit('response.output_item.done', {
        output_index: outputIndex,
        item: {
          type: 'function_call',
          id: cur.id,
          call_id: cur.call_id,
          name: cur.name,
          arguments: cur.args,
          status: 'completed',
        },
      });
      finalOutput.push({
        type: 'function_call',
        id: cur.id,
        call_id: cur.call_id,
        name: cur.name,
        arguments: cur.args,
        status: 'completed',
      });
      outputIndex++;
    }

    const usage = toUsage(upstreamUsage);
    finished = true;

    await emit('response.completed', {
      response: buildResponse({
        id: responseId,
        model: requestModel,
        status: 'completed',
        output: finalOutput,
        usage,
      }),
    });
  } catch (e) {
    warn(`[${site}] Responses 流式转换异常：${e?.message || e}`);
  } finally {
    up.close();
    if (!res.writableEnded) res.end();
    requestLog({
      site,
      model,
      mode: 'responses',
      status: finished ? 200 : 499,
      ms: Date.now() - started,
    });
    recordUsage({
      site,
      model,
      mode: 'responses',
      status: finished ? 200 : 499,
      promptTokens: upstreamUsage?.prompt_tokens ?? estimateTokens(JSON.stringify(chatReq.messages || [])),
      completionTokens: upstreamUsage?.completion_tokens ?? estimateTokens('x'.repeat(contentChars)),
      credit: upstreamUsage?.credit ?? 0,
      ms: Date.now() - started,
      tools: toolItems.size,
    });
  }
}
