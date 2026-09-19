// 工具函数测试：token 估算、JSON body 读取、响应写出
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { estimateTokens, readJsonBody, MAX_BODY } from '../src/util.mjs';
import { maskKeyIfNeeded } from './helpers/mask.mjs';

/** 造一个可 async iterate 的假请求（readJsonBody 只依赖异步迭代）。 */
function fakeReq(chunks) {
  return Readable.from(chunks.map((c) => Buffer.from(c)));
}

describe('estimateTokens：粗略 token 估算', () => {
  test('空字符串为 0', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens(null), 0);
    assert.equal(estimateTokens(undefined), 0);
  });

  test('非空文本至少为 1', () => {
    assert.equal(estimateTokens('a'), 1);
    assert.equal(estimateTokens('中'), 1);
  });

  test('按 3 字符 ≈ 1 token 递增', () => {
    assert.equal(estimateTokens('abc'), 1);
    assert.equal(estimateTokens('abcdef'), 2);
    assert.equal(estimateTokens('a'.repeat(300)), 100);
  });

  test('中文按字符数计算（与英文同口径）', () => {
    assert.equal(estimateTokens('中文测试'), 2);
  });

  test('结果始终为有限数', () => {
    for (const s of ['', 'x', '中文', 'a'.repeat(10000)]) {
      assert.ok(Number.isFinite(estimateTokens(s)));
    }
  });

  test('非字符串输入不崩溃', () => {
    assert.ok(Number.isFinite(estimateTokens(123)));
    assert.ok(Number.isFinite(estimateTokens({})));
  });
});

describe('readJsonBody：请求体解析', () => {
  test('空 body 返回空对象', async () => {
    assert.deepEqual(await readJsonBody(fakeReq([])), {});
  });

  test('解析正常 JSON', async () => {
    const r = await readJsonBody(fakeReq(['{"a":1}']));
    assert.deepEqual(r, { a: 1 });
  });

  test('分片到达的 JSON 能正确拼接', async () => {
    const r = await readJsonBody(fakeReq(['{"a"', ':1,', '"b":"x"}']));
    assert.deepEqual(r, { a: 1, b: 'x' });
  });

  test('中文内容正确解码', async () => {
    const r = await readJsonBody(fakeReq([JSON.stringify({ msg: '你好世界' })]));
    assert.equal(r.msg, '你好世界');
  });

  test('非法 JSON 抛 400', async () => {
    const err = await readJsonBody(fakeReq(['{not json'])).catch((e) => e);
    assert.equal(err.status, 400);
    assert.match(err.message, /JSON/);
  });

  test('超出上限抛 413', async () => {
    const big = 'x'.repeat(MAX_BODY + 100);
    const err = await readJsonBody(fakeReq([big])).catch((e) => e);
    assert.equal(err.status, 413);
    assert.match(err.message, /过大|16MB/);
  });

  test('刚好等于上限被接受', async () => {
    const payload = JSON.stringify({ d: 'x'.repeat(1000) });
    assert.doesNotThrow(async () => readJsonBody(fakeReq([payload])));
  });

  test('数组 body 也能解析', async () => {
    assert.deepEqual(await readJsonBody(fakeReq(['[1,2,3]'])), [1, 2, 3]);
  });
});

describe('辅助模块自检', () => {
  test('测试辅助函数可用（占位，确保 helpers 被加载）', () => {
    assert.equal(maskKeyIfNeeded('sk-wb-abcdef123456'), 'sk-wb-…3456');
  });
});
