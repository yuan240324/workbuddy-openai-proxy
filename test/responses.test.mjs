// Responses API 兼容层测试。
//
// 这层此前完全没有测试覆盖，于是两个 bug 都躲过去了：
//   1. reasoning.effort 被整个丢弃 → 上游完全不思考（思考 token 恒为 0）
//   2. openWithFallback 返回值形状错误 → 四条站点降级路径全崩（在 openai.mjs 里）
// 这里先给纯函数 toChatRequest 补上覆盖。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { toChatRequest } from '../src/responses.mjs';

/** 最小可用的 Responses 请求。 */
function req(extra = {}) {
  return {
    model: 'm',
    input: [{ type: 'message', role: 'user', content: 'hi' }],
    ...extra,
  };
}

describe('toChatRequest：推理强度（reasoning.effort → reasoning_effort）', () => {
  // 背景：客户端（DSH / Codex）用 reasoning.effort 表达思考强度。
  // 实测上游把「有没有这个字段」当开关：不传 = 完全不思考（reasoning_tokens 为 0），
  // 传了（哪怕 minimal）= 会思考并返回 reasoning 项。所以这个映射不能丢。

  test('reasoning.effort 映射为 reasoning_effort', () => {
    const chat = toChatRequest(req({ reasoning: { effort: 'high' } }));
    assert.equal(chat.reasoning_effort, 'high');
  });

  test('四档 effort 都能透传', () => {
    for (const effort of ['minimal', 'low', 'medium', 'high']) {
      assert.equal(toChatRequest(req({ reasoning: { effort } })).reasoning_effort, effort, effort);
    }
  });

  test('没有 reasoning 时不得凭空造出该字段', () => {
    assert.equal('reasoning_effort' in toChatRequest(req()), false);
  });

  test('只有 summary、没有 effort 时不映射', () => {
    const chat = toChatRequest(req({ reasoning: { summary: 'auto' } }));
    assert.equal('reasoning_effort' in chat, false, 'summary 不参与强度映射');
  });

  test('effort 为空串/假值时忽略', () => {
    for (const effort of ['', null, undefined, 0]) {
      assert.equal('reasoning_effort' in toChatRequest(req({ reasoning: { effort } })), false, String(effort));
    }
  });

  test('reasoning 不是对象时不炸', () => {
    for (const bad of [null, 'high', 42, []]) {
      assert.doesNotThrow(() => toChatRequest(req({ reasoning: bad })), String(bad));
    }
  });
});

describe('toChatRequest：基础映射没被改坏', () => {
  test('instructions 折进首条 user（上游不接受它作 system）', () => {
    const chat = toChatRequest(req({ instructions: 'RULES' }));
    const firstUser = chat.messages.find((m) => m.role === 'user');
    assert.match(firstUser.content, /RULES/);
  });

  test('首条必须是 system', () => {
    assert.equal(toChatRequest(req()).messages[0].role, 'system');
  });

  test('max_output_tokens → max_tokens', () => {
    assert.equal(toChatRequest(req({ max_output_tokens: 1234 })).max_tokens, 1234);
  });

  test('temperature / top_p 透传', () => {
    const chat = toChatRequest(req({ temperature: 0.3, top_p: 0.9 }));
    assert.equal(chat.temperature, 0.3);
    assert.equal(chat.top_p, 0.9);
  });

  test('扁平 tools 转成嵌套 function 格式', () => {
    const chat = toChatRequest(
      req({ tools: [{ type: 'function', name: 'f', description: 'd', parameters: { type: 'object' } }] }),
    );
    assert.equal(chat.tools[0].type, 'function');
    assert.equal(chat.tools[0].function.name, 'f');
  });

  test('input 里的 reasoning 项不回传上游（上游不认该角色）', () => {
    const chat = toChatRequest(
      req({
        input: [
          { type: 'message', role: 'user', content: 'q' },
          { type: 'reasoning', summary: [{ type: 'summary_text', text: '想过了' }] },
          { type: 'message', role: 'assistant', content: 'a' },
        ],
      }),
    );
    const joined = JSON.stringify(chat.messages);
    assert.equal(joined.includes('reasoning'), false);
    assert.equal(joined.includes('想过了'), false);
  });

  test('连续的多个 function_call 合并进同一条 assistant 消息', () => {
    const chat = toChatRequest(
      req({
        input: [
          { type: 'message', role: 'user', content: 'q' },
          { type: 'function_call', call_id: 'c1', name: 'a', arguments: '{}' },
          { type: 'function_call', call_id: 'c2', name: 'b', arguments: '{}' },
        ],
      }),
    );
    const assistants = chat.messages.filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls));
    assert.equal(assistants.length, 1, '必须合并成一条，否则上游报 tool calls 不匹配');
    assert.equal(assistants[0].tool_calls.length, 2);
  });

  test('function_call_output → role:tool', () => {
    const chat = toChatRequest(
      req({
        input: [
          { type: 'message', role: 'user', content: 'q' },
          { type: 'function_call', call_id: 'c1', name: 'a', arguments: '{}' },
          { type: 'function_call_output', call_id: 'c1', output: 'ok' },
        ],
      }),
    );
    const tool = chat.messages.find((m) => m.role === 'tool');
    assert.equal(tool.tool_call_id, 'c1');
    assert.equal(tool.content, 'ok');
  });

  test('input 是字符串时转成单条 user', () => {
    const chat = toChatRequest({ model: 'm', input: 'hello' });
    assert.equal(chat.messages.find((m) => m.role === 'user').content, 'hello');
  });

  test('空 input 不产生空消息数组', () => {
    const chat = toChatRequest({ model: 'm', input: [] });
    assert.ok(chat.messages.length >= 1);
  });
});
