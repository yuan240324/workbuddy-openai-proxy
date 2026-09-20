// DeepSeek 站点 → OpenAI / Anthropic 兼容层的适配器。
//
// 职责：把 src/deepseek.mjs 的原始 SSE 流，转换成与 CodeBuddy 路径
// 完全一致的中间结构，从而复用 openai.mjs / anthropic.mjs 的既有逻辑。
//
// 关键差异（与 CodeBuddy 相比）：
//   1. 无 messages 数组 → 必须先 flattenMessages 压平成 prompt
//   2. 无 model 概念 → 用 resolveOptions 映射成 thinking/search 开关
//   3. 上游帧不是 OpenAI 格式 → 需要翻译成 { choices:[{delta:{content}}] }
import { dsToken, openCompletion, extractDelta, resolveOptions, flattenMessages, DeepSeekError } from './deepseek.mjs';
import { newId } from './upstream.mjs';

/** 判断某站点是否走 DeepSeek 官方协议。 */
export function isDeepSeek(protocol) {
  return protocol === 'deepseek';
}

/**
 * 打开一次 DeepSeek 补全，返回与 openChat 同构的结果对象。
 *
 * @returns {{ok:true, status, site, frames:AsyncGenerator<string>, close:()=>void}}
 *          或 {ok:false, status, text, site}
 */
export async function openDeepSeekChat(cfg, site, body, { signal } = {}) {
  let token;
  try {
    token = dsToken();
  } catch (e) {
    return { ok: false, status: 401, text: e.message, site };
  }

  const model = body.model || 'deepseek-chat';
  const { modelType, thinking, search } = resolveOptions(model);
  const prompt = flattenMessages(body.messages);

  if (!prompt.trim()) {
    return { ok: false, status: 400, text: '消息内容为空（DeepSeek 官方接口要求非空 prompt）', site };
  }

  let up;
  try {
    up = await openCompletion(token, {
      prompt,
      modelType,
      thinking: thinking || Boolean(body.thinking),
      search: search || Boolean(body.search),
      signal,
    });
  } catch (e) {
    const status = e instanceof DeepSeekError ? e.status : 502;
    return { ok: false, status, text: e.message, site };
  }

  if (!up.ok) return { ok: false, status: up.status, text: up.text, site };

  return {
    ok: true,
    status: up.status,
    site,
    sessionId: up.sessionId,
    frames: translateFrames(up.frames, model),
    close: up.close,
  };
}

/**
 * 把 DeepSeek 的原始帧翻译成 OpenAI chunk 形状。
 *
 * 产出形如：
 *   {"id":"chatcmpl-...","object":"chat.completion.chunk",
 *    "choices":[{"index":0,"delta":{"content":"..."},"finish_reason":null}]}
 *
 * 这样 openai.mjs 的 normalizeChunk() 与 anthropic.mjs 的解析器都能直接复用。
 */
export async function* translateFrames(frames, model) {
  const id = newId('chatcmpl');
  const created = Math.floor(Date.now() / 1000);
  let first = true;

  for await (const payload of frames) {
    let obj;
    try {
      obj = JSON.parse(payload);
    } catch {
      continue; // 非 JSON 帧（心跳等）忽略
    }

    const { text, reasoning, done } = extractDelta(obj);

    if (done) break;

    // 深思考的推理内容 → reasoning_content
    if (reasoning) {
      yield JSON.stringify({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta: { reasoning_content: reasoning }, finish_reason: null }],
      });
    }

    if (text) {
      const delta = first ? { role: 'assistant', content: text } : { content: text };
      first = false;
      yield JSON.stringify({
        id, object: 'chat.completion.chunk', created, model,
        choices: [{ index: 0, delta, finish_reason: null }],
      });
    }
  }

  // 正常收尾帧
  yield JSON.stringify({
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });
}

/**
 * DeepSeek 站点没有可拉取的模型目录接口，直接用站点预设的 seedModels。
 * 与 router.getCatalog 的回落路径衔接。
 */
export function deepseekModels(cfg, site) {
  const seed = cfg.sites?.[site]?.seedModels || [];
  return seed.map((m) => ({
    id: m.id,
    name: m.name || m.id,
    credits: null,
    contextWindow: null,
    maxTokens: null,
    supportsImages: false,
    supportsToolCall: false,
    supportsReasoning: String(m.id).includes('reasoner'),
    seed: true,
  }));
}
