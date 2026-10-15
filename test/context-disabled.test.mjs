// 回归：context.enabled=false 时，上游 400 后也不能做「压缩后重试」。
// 背景：applyContextFit 早已尊重 enabled=false，但 openChat 里的「撞墙后压缩重试」
// 循环没有检查该开关，每次 400 都会裁剪并重新请求，白白多打上游、多扣积分。
import { test, describe, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wb-ctxoff-'));
const { authPathFor, setConfigDir } = await import('../src/config.mjs');
const restoreConfigDir = setConfigDir(tmpDir);

const CRED = JSON.stringify({
  site: 'cn-cli',
  accessToken: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1MSIsImV4cCI6NDEwMjQ0NDgwMH0.x',
  refreshToken: 'rt',
  expiresAt: Date.now() + 86400_000,
  uid: 'u1',
}, null, 2);

function useOwnDir() {
  setConfigDir(tmpDir);
  const f = authPathFor('cn-cli');
  fs.writeFileSync(f, CRED);
  const t = Date.now() / 1000 + 1;
  fs.utimesSync(f, t, t);
}

const { openChat } = await import('../src/upstream.mjs');

const PORT = 19_000 + Math.floor(Math.random() * 1000);
let hits = 0;
// 永远返回「输入超限」类 400，逼出压缩重试逻辑
const server = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    hits++;
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 11133, msg: 'model_param_invalid' }));
  });
});

const mkCfg = (context) => ({
  defaultSite: 'cn-cli',
  defaultSystemPrompt: 'You are a helpful AI assistant.',
  stripFields: [],
  timeouts: { headerMs: 2000, idleMs: 2000, metaMs: 1000 },
  upstreamRetry: { attempts: 1, backoffMs: [] },
  context,
  sites: {
    'cn-cli': {
      label: 'T', enabled: true,
      apiBase: `http://127.0.0.1:${PORT}`,
      billingBase: `http://127.0.0.1:${PORT}`,
      origin: 'https://x.test', userAgent: 'T/1',
    },
  },
});

const longBody = () => ({
  model: 'm',
  stream: false,
  messages: Array.from({ length: 30 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: '啊'.repeat(20000) })),
});

before(async () => { await new Promise((r) => server.listen(PORT, '127.0.0.1', r)); });
beforeEach(() => { useOwnDir(); hits = 0; });
after(async () => {
  await new Promise((r) => server.close(r));
  restoreConfigDir();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('context.enabled=false：上游 400 后不得压缩重试', () => {
  test('只发一次请求，不做压缩重试', async () => {
    const r = await openChat(mkCfg({ enabled: false, reserveForOutput: 4096, minKeepMessages: 4, safetyRatio: 0.95 }), 'cn-cli', longBody());
    assert.equal(r.ok, false);
    assert.equal(hits, 1, `期望只请求 1 次，实际 ${hits} 次（压缩重试未被 enabled=false 关闭）`);
  });
});
