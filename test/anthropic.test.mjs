// Anthropic Messages ↔ OpenAI Chat Completions 转换测试
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { toOpenAIBody } from '../src/anthropic.mjs';

describe('toOpenAIBody：system 处理', () => {
  test('字符串 system 放到首条', () => {
    const out = toOpenAIBody({ system: '你是助手', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(out.messages[0].role, 'system');
    assert.equal(out.messages[0].content, '你是助手');
  });

  test('system 为文本块数组时拼接', () => {
    const out = toOpenAIBody({
      system: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }],
      messages: [{ role: 'user', content: 'hi' }],
    });
    assert.equal(out.messages[0].content, 'AB');
  });

  test('无 system 时不插入', () => {
    const out = toOpenAIBody({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].role, 'user');
  });

  test('空白 system 不插入', () => {
    const out = toOpenAIBody({ system: '   ', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(out.messages.length, 1);
  });
});

describe('toOpenAIBody：普通消息', () => {
  test('字符串内容原样传递', () => {
    const out = toOpenAIBody({ messages: [{ role: 'user', content: '你好' }] });
    assert.equal(out.messages[0].content, '你好');
  });

  test('assistant 字符串内容', () => {
    const out = toOpenAIBody({ messages: [{ role: 'assistant', content: '回复' }] });
    assert.equal(out.messages[0].role, 'assistant');
    assert.equal(out.messages[0].content, '回复');
  });

  test('多轮顺序保持', () => {
    const out = toOpenAIBody({
      messages: [
        { role: 'user', content: 'a' },
        { role: 'assistant', content: 'b' },
        { role: 'user', content: 'c' },
      ],
    });
    assert.deepEqual(out.messages.map((m) => m.content), ['a', 'b', 'c']);
  });

  test('null 消息项被跳过', () => {
    const out = toOpenAIBody({ messages: [null, { role: 'user', content: 'x' }] });
    assert.equal(out.messages.length, 1);
  });

  test('未知 role 归为 user（Anthropic 只有 user/assistant）', () => {
    const out = toOpenAIBody({ messages: [{ role: 'weird', content: 'x' }] });
    assert.equal(out.messages[0].role, 'user');
  });
});

describe('toOpenAIBody：文本块数组', () => {
  test('单个文本块退化为字符串', () => {
    const out = toOpenAIBody({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
    assert.equal(out.messages[0].content, 'hi');
  });

  test('多个文本块保持数组结构（不只取第一块）', () => {
    const out = toOpenAIBody({
      messages: [{ role: 'user', content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] }],
    });
    assert.ok(Array.isArray(out.messages[0].content));
    assert.equal(out.messages[0].content.length, 2);
  });
});

describe('toOpenAIBody：图片块', () => {
  test('base64 图片转成 data URL', () => {
    const out = toOpenAIBody({
      messages: [{
        role: 'user',
        content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }],
      }],
    });
    const img = out.messages[0].content.find((p) => p.type === 'image_url');
    assert.equal(img.image_url.url, 'data:image/png;base64,AAAA');
  });

  test('URL 图片直接透传', () => {
    const out = toOpenAIBody({
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }] }],
    });
    const img = out.messages[0].content.find((p) => p.type === 'image_url');
    assert.equal(img.image_url.url, 'https://x/y.png');
  });
});

describe('toOpenAIBody：assistant 工具调用', () => {
  test('tool_use 块转成 tool_calls', () => {
    const out = toOpenAIBody({
      messages: [{
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: { city: 'SH' } }],
      }],
    });
    const m = out.messages[0];
    assert.equal(m.role, 'assistant');
    assert.equal(m.tool_calls.length, 1);
    assert.equal(m.tool_calls[0].id, 'toolu_1');
    assert.equal(m.tool_calls[0].function.name, 'get_weather');
    assert.equal(m.tool_calls[0].function.arguments, '{"city":"SH"}');
  });

  test('文本 + 工具调用共存', () => {
    const out = toOpenAIBody({
      messages: [{
        role: 'assistant',
        content: [
          { type: 'text', text: '我来查一下' },
          { type: 'tool_use', id: 't1', name: 'f', input: {} },
        ],
      }],
    });
    assert.equal(out.messages[0].content, '我来查一下');
    assert.equal(out.messages[0].tool_calls.length, 1);
  });

  test('只有工具调用时 content 为 null（而非空串）', () => {
    const out = toOpenAIBody({
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'f', input: {} }] }],
    });
    assert.equal(out.messages[0].content, null);
  });

  test('input 已是字符串时不重复序列化', () => {
    const out = toOpenAIBody({
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'f', input: '{"a":1}' }] }],
    });
    assert.equal(out.messages[0].tool_calls[0].function.arguments, '{"a":1}');
  });

  test('input 缺失时用空对象', () => {
    const out = toOpenAIBody({
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'f' }] }],
    });
    assert.equal(out.messages[0].tool_calls[0].function.arguments, '{}');
  });

  test('多个 tool_use 全部保留', () => {
    const out = toOpenAIBody({
      messages: [{
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'f1', input: {} },
          { type: 'tool_use', id: 't2', name: 'f2', input: {} },
        ],
      }],
    });
    assert.equal(out.messages[0].tool_calls.length, 2);
  });
});

describe('toOpenAIBody：tool_result（关键顺序约束）', () => {
  test('tool_result 转成 role=tool 消息', () => {
    const out = toOpenAIBody({
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: '结果' }],
      }],
    });
    assert.equal(out.messages[0].role, 'tool');
    assert.equal(out.messages[0].tool_call_id, 't1');
    assert.equal(out.messages[0].content, '结果');
  });

  test('tool_result 必须排在后续用户文本之前', () => {
    const out = toOpenAIBody({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: '这是补充说明' },
          { type: 'tool_result', tool_use_id: 't1', content: '工具结果' },
        ],
      }],
    });
    assert.equal(out.messages[0].role, 'tool', 'tool 消息应在前');
    assert.equal(out.messages[1].role, 'user', '用户文本应在后');
    assert.equal(out.messages[1].content, '这是补充说明');
  });

  test('tool_result 内容为块数组时提取文本', () => {
    const out = toOpenAIBody({
      messages: [{
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'abc' }] }],
      }],
    });
    assert.equal(out.messages[0].content, 'abc');
  });

  test('多个 tool_result 顺序保持', () => {
    const out = toOpenAIBody({
      messages: [{
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'r1' },
          { type: 'tool_result', tool_use_id: 't2', content: 'r2' },
        ],
      }],
    });
    assert.deepEqual(out.messages.map((m) => m.tool_call_id), ['t1', 't2']);
  });
});

describe('toOpenAIBody：参数透传', () => {
  test('max_tokens / temperature / top_p', () => {
    const out = toOpenAIBody({ messages: [], max_tokens: 100, temperature: 0.5, top_p: 0.9 });
    assert.equal(out.max_tokens, 100);
    assert.equal(out.temperature, 0.5);
    assert.equal(out.top_p, 0.9);
  });

  test('temperature 为 0 也要保留（不能被当成 falsy 丢掉）', () => {
    const out = toOpenAIBody({ messages: [], temperature: 0 });
    assert.equal(out.temperature, 0);
  });

  test('stop_sequences 转成 stop', () => {
    const out = toOpenAIBody({ messages: [], stop_sequences: ['\n\n', 'END'] });
    assert.deepEqual(out.stop, ['\n\n', 'END']);
  });

  test('空 stop_sequences 不产生 stop 字段', () => {
    const out = toOpenAIBody({ messages: [], stop_sequences: [] });
    assert.ok(!('stop' in out));
  });

  test('工具定义转成 OpenAI function 格式', () => {
    const out = toOpenAIBody({
      messages: [],
      tools: [{ name: 'get_weather', description: '查天气', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
    });
    assert.equal(out.tools[0].type, 'function');
    assert.equal(out.tools[0].function.name, 'get_weather');
    assert.equal(out.tools[0].function.description, '查天气');
    assert.ok(out.tools[0].function.parameters.properties.city);
  });

  test('缺 input_schema 时给空对象 schema', () => {
    const out = toOpenAIBody({ messages: [], tools: [{ name: 'f' }] });
    assert.deepEqual(out.tools[0].function.parameters, { type: 'object', properties: {} });
  });

  test('无名字的工具被过滤', () => {
    const out = toOpenAIBody({ messages: [], tools: [{ description: 'no name' }, { name: 'ok' }] });
    assert.equal(out.tools.length, 1);
    assert.equal(out.tools[0].function.name, 'ok');
  });

  test('空 tools 不产生 tools 字段', () => {
    const out = toOpenAIBody({ messages: [], tools: [] });
    assert.ok(!('tools' in out));
  });
});

describe('toOpenAIBody：tool_choice 映射', () => {
  const tc = (choice) => toOpenAIBody({ messages: [], tool_choice: choice }).tool_choice;

  test('any → required', () => {
    assert.equal(tc({ type: 'any' }), 'required');
  });

  test('tool → 具体函数名', () => {
    assert.equal(tc({ type: 'tool', name: 'get_weather' }), 'get_weather');
  });

  test('none → none', () => {
    assert.equal(tc({ type: 'none' }), 'none');
  });

  test('auto → auto', () => {
    assert.equal(tc({ type: 'auto' }), 'auto');
  });

  test('未知类型 → auto', () => {
    assert.equal(tc({ type: 'weird' }), 'auto');
  });

  test('无 tool_choice 时不设置', () => {
    const out = toOpenAIBody({ messages: [] });
    assert.ok(!('tool_choice' in out));
  });
});

describe('toOpenAIBody：stream 默认值', () => {
  test('缺省视为流式（stream !== false）', () => {
    assert.equal(toOpenAIBody({ messages: [] }).stream, true);
  });

  test('显式 false 保持 false', () => {
    assert.equal(toOpenAIBody({ messages: [], stream: false }).stream, false);
  });

  test('显式 true', () => {
    assert.equal(toOpenAIBody({ messages: [], stream: true }).stream, true);
  });
});

describe('toOpenAIBody：健壮性', () => {
  test('完全空的请求不崩溃', () => {
    assert.doesNotThrow(() => toOpenAIBody({}));
  });

  test('messages 非数组时不崩溃', () => {
    assert.doesNotThrow(() => toOpenAIBody({ messages: 'oops' }));
  });

  test('content 里的 null 块被跳过', () => {
    const out = toOpenAIBody({ messages: [{ role: 'user', content: [null, { type: 'text', text: 'x' }] }] });
    assert.equal(out.messages.length, 1);
  });

  test('未知内容块类型被忽略', () => {
    const out = toOpenAIBody({ messages: [{ role: 'user', content: [{ type: 'unknown_thing' }] }] });
    assert.equal(out.messages.length, 0, '无有效内容时不产生消息');
  });
});
