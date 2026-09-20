// 上游请求体改写测试：prepareBody / normalizeToolChoice
// 这些是协议转换的核心，历史上出过多种边界问题。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { prepareBody, classifyFrame, aggregateFrames, upstreamErrorMessage, newId } from '../src/upstream.mjs';

const cfg = (over = {}) => ({
  defaultSystemPrompt: 'You are a helpful AI assistant.',
  stripFields: [],
  ...over,
});

const user = (content = 'hi') => ({ role: 'user', content });

describe('prepareBody：强制流式', () => {
  test('总是把 stream 置为 true（上游只接受流式）', () => {
    assert.equal(prepareBody(cfg(), { messages: [user()] }).stream, true);
    assert.equal(prepareBody(cfg(), { messages: [user()], stream: true }).stream, true);
    assert.equal(prepareBody(cfg(), { messages: [user()], stream: false }).stream, true);
  });

  test('不修改传入的原始对象', () => {
    const src = { messages: [user()], stream: false };
    prepareBody(cfg(), src);
    assert.equal(src.stream, false, '原对象不应被改动');
  });
});

describe('prepareBody：首条必须是 system（国际版硬性要求）', () => {
  test('首条是 user 时自动补 system', () => {
    const out = prepareBody(cfg(), { messages: [user()] });
    assert.equal(out.messages[0].role, 'system');
    assert.equal(out.messages[0].content, 'You are a helpful AI assistant.');
    assert.equal(out.messages[1].role, 'user');
  });

  test('首条已是 system 时不重复插入', () => {
    const out = prepareBody(cfg(), { messages: [{ role: 'system', content: 'custom' }, user()] });
    assert.equal(out.messages.length, 2);
    assert.equal(out.messages[0].content, 'custom');
  });

  test('使用配置里的 defaultSystemPrompt', () => {
    const out = prepareBody(cfg({ defaultSystemPrompt: '你是助手' }), { messages: [user()] });
    assert.equal(out.messages[0].content, '你是助手');
  });

  test('defaultSystemPrompt 为空时用兜底英文提示', () => {
    const out = prepareBody(cfg({ defaultSystemPrompt: '' }), { messages: [user()] });
    assert.equal(out.messages[0].content, 'You are a helpful AI assistant.');
  });

  test('空 messages 数组也会补上 system', () => {
    const out = prepareBody(cfg(), { messages: [] });
    assert.equal(out.messages.length, 1);
    assert.equal(out.messages[0].role, 'system');
  });

  test('messages 不是数组时不做处理（交由上游报错）', () => {
    const out = prepareBody(cfg(), { messages: 'oops' });
    assert.equal(out.messages, 'oops');
  });

  test('首条不是对象时不崩溃', () => {
    const out = prepareBody(cfg(), { messages: [null, user()] });
    assert.ok(Array.isArray(out.messages));
    assert.equal(out.messages[0].role, 'system');
  });
});

describe('prepareBody：developer 角色改写', () => {
  test('developer 改写为 system（上游 role 白名单没有 developer）', () => {
    const out = prepareBody(cfg(), { messages: [{ role: 'developer', content: 'x' }, user()] });
    assert.equal(out.messages[0].role, 'system');
  });

  test('大小写不敏感', () => {
    for (const role of ['Developer', 'DEVELOPER', 'DeVeLoPeR']) {
      const out = prepareBody(cfg(), { messages: [{ role, content: 'x' }] });
      assert.equal(out.messages[0].role, 'system', `role=${role} 应被改写`);
    }
  });

  test('其他角色不受影响', () => {
    const out = prepareBody(cfg(), { messages: [{ role: 'system', content: 's' }, { role: 'assistant', content: 'a' }, user()] });
    assert.deepEqual(out.messages.map((m) => m.role), ['system', 'assistant', 'user']);
  });

  test('messages 里的 null 项不导致崩溃', () => {
    assert.doesNotThrow(() => prepareBody(cfg(), { messages: [null, user(), undefined] }));
  });
});

describe('prepareBody：tool_choice 归一（上游只接受字符串）', () => {
  test('字符串 none 时连同 tools 一起删除', () => {
    const out = prepareBody(cfg(), { messages: [user()], tools: [{ type: 'function' }], tool_choice: 'none' });
    assert.equal(out.tool_choice, undefined);
    assert.equal(out.tools, undefined);
  });

  test('对象 {type:none} 同样删除工具', () => {
    const out = prepareBody(cfg(), { messages: [user()], tools: [{ type: 'function' }], tool_choice: { type: 'none' } });
    assert.equal(out.tool_choice, undefined);
    assert.equal(out.tools, undefined);
  });

  test('对象 {type:auto} 转成字符串 auto', () => {
    const out = prepareBody(cfg(), { messages: [user()], tool_choice: { type: 'auto' } });
    assert.equal(out.tool_choice, 'auto');
  });

  test('对象 {type:required} 转成字符串 required', () => {
    const out = prepareBody(cfg(), { messages: [user()], tool_choice: { type: 'required' } });
    assert.equal(out.tool_choice, 'required');
  });

  test('对象 {type:function} 转成函数名字符串', () => {
    const out = prepareBody(cfg(), {
      messages: [user()],
      tool_choice: { type: 'function', function: { name: 'get_weather' } },
    });
    assert.equal(out.tool_choice, 'get_weather');
  });

  test('function 缺 name 时降级为 auto', () => {
    const out = prepareBody(cfg(), { messages: [user()], tool_choice: { type: 'function', function: {} } });
    assert.equal(out.tool_choice, 'auto');
  });

  test('未知对象类型时删除 tool_choice（不传给上游）', () => {
    const out = prepareBody(cfg(), { messages: [user()], tool_choice: { type: 'weird' } });
    assert.equal(out.tool_choice, undefined);
  });

  test('字符串 auto / required 原样保留', () => {
    assert.equal(prepareBody(cfg(), { messages: [user()], tool_choice: 'auto' }).tool_choice, 'auto');
    assert.equal(prepareBody(cfg(), { messages: [user()], tool_choice: 'required' }).tool_choice, 'required');
  });

  test('没有 tool_choice 时不添加该字段', () => {
    const out = prepareBody(cfg(), { messages: [user()] });
    assert.ok(!('tool_choice' in out));
  });
});

describe('prepareBody：stripFields', () => {
  test('按配置剔除字段', () => {
    const out = prepareBody(cfg({ stripFields: ['presence_penalty', 'frequency_penalty'] }), {
      messages: [user()],
      presence_penalty: 0.5,
      frequency_penalty: 0.5,
      temperature: 0.7,
    });
    assert.ok(!('presence_penalty' in out));
    assert.ok(!('frequency_penalty' in out));
    assert.equal(out.temperature, 0.7, '未列出的字段应保留');
  });

  test('stripFields 为空时不删任何东西', () => {
    const out = prepareBody(cfg({ stripFields: [] }), { messages: [user()], temperature: 0.7 });
    assert.equal(out.temperature, 0.7);
  });
});

describe('prepareBody：剥离客户端指纹（回归 #1 #2）', () => {
  // 上游对 system 做「客户端指纹」精确匹配，命中就回
  //   400 Illegal API invocation from an unapproved channel
  // 实测只认完整原句，拆开任一部分都放行，说明是精确黑名单而非关键词过滤。
  // 受影响：Claude Code、Claude desktop 的 /code 面板。
  const 指纹 = "You are Claude Code, Anthropic's official CLI for Claude.";

  test('命中指纹时被剥离', () => {
    const out = prepareBody(cfg(), {
      messages: [{ role: 'system', content: 指纹 }, user()],
    });
    assert.ok(!out.messages[0].content.includes('Anthropic'), '指纹应被剥离');
  });

  test('system 的其余内容原样保留', () => {
    const out = prepareBody(cfg(), {
      messages: [{ role: 'system', content: `${指纹}\n\nYou are an interactive CLI tool.` }, user()],
    });
    assert.ok(out.messages[0].content.includes('interactive CLI tool'), '其余指令不该丢');
    assert.ok(!out.messages[0].content.includes('official CLI for Claude'));
  });

  test('整条 system 就是指纹时，用默认提示词兜底（不留空串）', () => {
    const out = prepareBody(cfg(), { messages: [{ role: 'system', content: 指纹 }, user()] });
    assert.equal(out.messages[0].role, 'system');
    assert.equal(out.messages[0].content, 'You are a helpful AI assistant.');
  });

  test('只剥离 system，不动 user 内容', () => {
    const out = prepareBody(cfg(), {
      messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 指纹 }],
    });
    assert.equal(out.messages[1].content, 指纹, 'user 里的同样文字不应被改');
  });

  test('不误伤：拆开的部分、其他客户端提示词都原样保留', () => {
    const 不该动 = [
      'You are Claude Code',                                  // 只有前半
      "Anthropic's official CLI for Claude",                  // 只有后半
      'You are a coding agent running in the Codex CLI.',     // Codex
      'You are an AI coding assistant. You operate in Cursor.',
      '你是一个有帮助的助手。',
    ];
    for (const c of 不该动) {
      const out = prepareBody(cfg(), { messages: [{ role: 'system', content: c }, user()] });
      assert.equal(out.messages[0].content, c, `不该改动：${c}`);
    }
  });

  test('stripClientFingerprint=false 时完全不处理', () => {
    const out = prepareBody(cfg({ stripClientFingerprint: false }), {
      messages: [{ role: 'system', content: 指纹 }, user()],
    });
    assert.equal(out.messages[0].content, 指纹, '关掉开关后应原样透传');
  });

  test('大小写与末尾句号容错', () => {
    for (const v of [
      'you are claude code, anthropic\'s official CLI for claude',
      "You are Claude Code, Anthropic's official CLI for Claude.\n\nextra",
    ]) {
      const out = prepareBody(cfg(), { messages: [{ role: 'system', content: v }, user()] });
      assert.ok(!/official CLI for Claude/i.test(out.messages[0].content), `应被剥离：${v.slice(0, 40)}`);
    }
  });

  test('非字符串 content（多模态数组）不崩', () => {
    const out = prepareBody(cfg(), {
      messages: [{ role: 'system', content: [{ type: 'text', text: 指纹 }] }, user()],
    });
    assert.ok(Array.isArray(out.messages[0].content), '数组内容应原样保留');
  });
});

describe('classifyFrame：区分正常 chunk 与错误信封', () => {
  test('正常 chunk 被识别', () => {
    const r = classifyFrame(JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }));
    assert.equal(r.kind, 'chunk');
    assert.ok(r.obj.choices);
  });

  test('带 code 的错误信封被识别', () => {
    const r = classifyFrame(JSON.stringify({ code: 40001, msg: '额度不足' }));
    assert.equal(r.kind, 'error');
    assert.equal(r.message, '额度不足');
  });

  test('带 error 字段的响应被识别为错误', () => {
    const r = classifyFrame(JSON.stringify({ error: { message: 'boom' } }));
    assert.equal(r.kind, 'error');
    assert.equal(r.message, 'boom');
  });

  test('同时有 choices 和 code 时按 chunk 处理（避免误判）', () => {
    const r = classifyFrame(JSON.stringify({ choices: [{ delta: {} }], code: 0 }));
    assert.equal(r.kind, 'chunk');
  });

  test('非 JSON 视为垃圾帧', () => {
    assert.equal(classifyFrame('not json').kind, 'garbage');
  });
});

describe('aggregateFrames：聚合上游流', () => {
  const frame = (obj) => JSON.stringify(obj);
  async function* gen(list) {
    for (const f of list) yield f;
  }

  test('拼接文本增量', async () => {
    const out = await aggregateFrames(gen([
      frame({ id: 'a', model: 'm', choices: [{ delta: { role: 'assistant', content: '你' } }] }),
      frame({ choices: [{ delta: { content: '好' } }] }),
      frame({ choices: [{ delta: { content: '！' }, finish_reason: 'stop' }] }),
    ]));
    assert.equal(out.content, '你好！');
    assert.equal(out.finishReason, 'stop');
    assert.equal(out.id, 'a');
    assert.equal(out.model, 'm');
    assert.equal(out.frames, 3);
  });

  test('拼接 reasoning_content', async () => {
    const out = await aggregateFrames(gen([
      frame({ choices: [{ delta: { reasoning_content: '思考' } }] }),
      frame({ choices: [{ delta: { reasoning_content: '中' } }] }),
    ]));
    assert.equal(out.reasoning, '思考中');
  });

  test('按 index 聚合 tool_calls 的分片参数', async () => {
    const out = await aggregateFrames(gen([
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'get_weather', arguments: '{"a"' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ':1}' } }] } }] }),
    ]));
    assert.equal(out.toolCallList.length, 1);
    assert.equal(out.toolCallList[0].id, 'c1');
    assert.equal(out.toolCallList[0].function.name, 'get_weather');
    assert.equal(out.toolCallList[0].function.arguments, '{"a":1}', 'arguments 应累加拼接');
  });

  // 记录既有行为：name 用的是赋值而非累加（arguments 才是累加）。
  // 主流上游都在首个 chunk 里一次性给出完整函数名，所以实际很少触发；
  // 若将来有上游分片发送函数名，这里需要改成累加。此测试用于锁住当前语义。
  test('函数名分片时当前只保留最后一片（既有行为，非本次改动）', async () => {
    const out = await aggregateFrames(gen([
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'get_' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'weather' } }] } }] }),
    ]));
    assert.equal(out.toolCallList[0].function.name, 'weather');
  });

  test('多个 tool_call 按 index 排序输出', async () => {
    const out = await aggregateFrames(gen([
      frame({ choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'f2', arguments: '{}' } }] } }] }),
      frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'f1', arguments: '{}' } }] } }] }),
    ]));
    assert.deepEqual(out.toolCallList.map((t) => t.id), ['a', 'b']);
  });

  test('缺 index 的 tool_call 默认归到 0', async () => {
    const out = await aggregateFrames(gen([
      frame({ choices: [{ delta: { tool_calls: [{ id: 'x', function: { name: 'f', arguments: '{}' } }] } }] }),
    ]));
    assert.equal(out.toolCallList.length, 1);
    assert.equal(out.toolCallList[0].id, 'x');
  });

  test('保留 usage', async () => {
    const out = await aggregateFrames(gen([
      frame({ choices: [{ delta: { content: 'x' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }),
    ]));
    assert.deepEqual(out.usage, { prompt_tokens: 10, completion_tokens: 2 });
  });

  test('遇到错误信封时抛出 UpstreamError', async () => {
    await assert.rejects(
      () => aggregateFrames(gen([frame({ code: 402, msg: '积分不足' })])),
      (e) => {
        assert.equal(e.message, '积分不足');
        assert.equal(e.code, 402);
        return true;
      },
    );
  });

  test('忽略垃圾帧但继续处理后续正常帧', async () => {
    const out = await aggregateFrames(gen([
      'garbage',
      frame({ choices: [{ delta: { content: 'ok' } }] }),
    ]));
    assert.equal(out.content, 'ok');
    assert.equal(out.frames, 1);
  });

  test('choice 缺失的帧不崩溃', async () => {
    const out = await aggregateFrames(gen([frame({ id: 'z' }), frame({ choices: [] })]));
    assert.equal(out.content, '');
  });

  test('空流返回空结果且 frames 为 0', async () => {
    const out = await aggregateFrames(gen([]));
    assert.equal(out.frames, 0);
    assert.equal(out.content, '');
    assert.deepEqual(out.toolCallList, []);
  });

  test('退化到 message 而非 delta（非流式上游）', async () => {
    const out = await aggregateFrames(gen([
      frame({ choices: [{ message: { role: 'assistant', content: '完整回复' } }] }),
    ]));
    assert.equal(out.content, '完整回复');
  });
});

describe('upstreamErrorMessage：用户可读的错误信息', () => {
  test('401 映射为登录态失效提示', () => {
    assert.match(upstreamErrorMessage(401, '{}', 'cn-cli'), /登录态失效/);
  });

  test('402 映射为额度不足', () => {
    assert.match(upstreamErrorMessage(402, '{}'), /额度|积分/);
  });

  test('429 映射为限流提示', () => {
    assert.match(upstreamErrorMessage(429, '{}'), /限流/);
  });

  test('从 JSON 里提取 msg 字段', () => {
    assert.match(upstreamErrorMessage(400, JSON.stringify({ msg: '参数错误' })), /参数错误/);
  });

  test('500 且响应为 HTML 时给出友好提示（不暴露原始 HTML）', () => {
    const r = upstreamErrorMessage(500, '<html><body>Bad Gateway</body></html>');
    assert.ok(!r.includes('<html'), '不应保留 HTML 标签');
    assert.ok(!r.includes('Bad Gateway'), '不应原样回显上游 HTML 文本');
    assert.match(r, /上游网关 500|不可用|故障/);
  });

  test('非 500 的 HTML 响应被去标签后保留文字', () => {
    const r = upstreamErrorMessage(404, '<html><body>Not Found</body></html>');
    assert.ok(!r.includes('<html'), '不应保留 HTML 标签');
    assert.match(r, /Not Found/);
  });

  test('站点前缀被加上', () => {
    assert.match(upstreamErrorMessage(500, 'x', 'intl-cli'), /\[intl-cli\]/);
  });
});

describe('newId：ID 生成', () => {
  test('带默认前缀', () => {
    assert.match(newId(), /^chatcmpl-[0-9a-f]{24}$/);
  });

  test('支持自定义前缀', () => {
    assert.match(newId('msg'), /^msg-[0-9a-f]{24}$/);
    assert.match(newId('toolu'), /^toolu-[0-9a-f]{24}$/);
  });

  test('大量生成不重复', () => {
    const set = new Set(Array.from({ length: 2000 }, () => newId()));
    assert.equal(set.size, 2000, 'ID 必须唯一');
  });
});
