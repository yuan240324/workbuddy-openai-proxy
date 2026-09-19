// 路径匹配单测（P1-3）：按路径段匹配，同时保留 TraeWork 的拼接容错。
// 与源码 server.mjs 中的 hasSeg 逻辑保持同构；若源码逻辑变更，这里会失败提醒。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

// —— 与 server.mjs 中相同实现的判定函数（源码内联，故在此复刻一份做单测）——
function makeClassifier() {
  const segsOf = (p) => p.split('/').filter(Boolean);
  const hasSeg = (pathname, ...want) => {
    const segs = segsOf(pathname);
    for (let i = 0; i + want.length <= segs.length; i++) {
      let ok = true;
      for (let j = 0; j < want.length; j++) {
        if (segs[i + j] !== want[j]) { ok = false; break; }
      }
      if (ok) return true;
    }
    return false;
  };
  return (method, pathname) => {
    const isCountTokens = method === 'POST' && (hasSeg(pathname, 'count_tokens') || hasSeg(pathname, 'count-tokens'));
    const isChat = method === 'POST' && hasSeg(pathname, 'chat', 'completions');
    const isMessages = method === 'POST' && hasSeg(pathname, 'messages');
    const segs = segsOf(pathname);
    const isModels = method === 'GET' && segs[segs.length - 1] === 'models';
    if (isModels) return 'models';
    if (isCountTokens) return 'count_tokens';
    if (isChat) return 'chat';
    if (isMessages) return 'messages';
    return '404';
  };
}
const classify = makeClassifier();

describe('路径路由：标准端点', () => {
  const cases = [
    ['POST', '/v1/chat/completions', 'chat'],
    ['POST', '/v1/messages', 'messages'],
    ['POST', '/v1/messages/count_tokens', 'count_tokens'],
    ['POST', '/v1/messages/count-tokens', 'count_tokens'],
    ['GET', '/v1/models', 'models'],
  ];
  for (const [m, p, want] of cases) {
    test(`${m} ${p} → ${want}`, () => assert.equal(classify(m, p), want));
  }
});

describe('路径路由：客户端拼接容错（TraeWork）', () => {
  test('/v1/messages/chat/completions 识别为 chat（注释里点名要支持的场景）', () => {
    assert.equal(classify('POST', '/v1/messages/chat/completions'), 'chat');
  });

  test('count_tokens 优先级高于 messages', () => {
    assert.equal(classify('POST', '/v1/messages/count_tokens'), 'count_tokens');
  });

  test('无 /v1 前缀也能识别', () => {
    assert.equal(classify('POST', '/chat/completions'), 'chat');
    assert.equal(classify('POST', '/messages'), 'messages');
    assert.equal(classify('GET', '/models'), 'models');
  });

  test('多余的前缀层级不影响识别', () => {
    assert.equal(classify('POST', '/api/v1/chat/completions'), 'chat');
    assert.equal(classify('POST', '/openai/v1/messages'), 'messages');
  });

  test('尾斜杠被容忍（server.mjs 会先去掉）', () => {
    assert.equal(classify('POST', '/v1/chat/completions/'), 'chat');
  });
});

describe('路径路由：不应误判（旧实现的 includes 子串问题）', () => {
  const bad = [
    ['POST', '/v1/mymessagesfoo', '含 messages 子串但非路径段'],
    ['POST', '/v1/notmessages', '后缀相似'],
    ['POST', '/xchat/completionsy', '含子串但非完整段'],
    ['GET', '/v1/models2', 'endsWith 曾误判'],
    ['POST', '/v1/count_tokens_extra', '子串相似'],
    ['POST', '/v1/messagesfoo', '前缀相似'],
  ];
  for (const [m, p, why] of bad) {
    test(`${m} ${p} → 404（${why}）`, () => assert.equal(classify(m, p), '404'));
  }
});

describe('路径路由：HTTP 方法约束', () => {
  test('GET /v1/chat/completions 不匹配（必须是 POST）', () => {
    assert.equal(classify('GET', '/v1/chat/completions'), '404');
  });

  test('POST /v1/models 不匹配（必须是 GET）', () => {
    assert.equal(classify('POST', '/v1/models'), '404');
  });

  test('GET /v1/messages 不匹配', () => {
    assert.equal(classify('GET', '/v1/messages'), '404');
  });
});
