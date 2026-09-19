// 站点路由测试：模型名 → { 站点, 模型 } 的解析规则
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseMultiplier } from '../src/router.mjs';

// 说明：resolveTarget / mergedModels 依赖 auth 与上游目录（需要网络与凭证），
// 这里只对纯函数 parseMultiplier 做单测；涉及路由优先级的用例放在
// test/router.resolve.test.mjs 中通过依赖注入方式覆盖。

describe('parseMultiplier：解析上游倍率串', () => {
  test('标准格式 "x0.79 credits"', () => {
    assert.equal(parseMultiplier('x0.79 credits'), 0.79);
  });

  test('零倍率（免费模型）', () => {
    assert.equal(parseMultiplier('x0.00 credits'), 0);
  });

  test('整数倍率', () => {
    assert.equal(parseMultiplier('x2 credits'), 2);
    assert.equal(parseMultiplier('x2'), 2);
  });

  test('大写 X 也识别', () => {
    assert.equal(parseMultiplier('X1.5 credits'), 1.5);
  });

  test('x 与数字之间有空格', () => {
    assert.equal(parseMultiplier('x 0.5 credits'), 0.5);
  });

  test('多位小数', () => {
    assert.equal(parseMultiplier('x0.125 credits'), 0.125);
  });

  test('空值返回 Infinity（视为最贵，排最后）', () => {
    assert.equal(parseMultiplier(null), Number.POSITIVE_INFINITY);
    assert.equal(parseMultiplier(undefined), Number.POSITIVE_INFINITY);
    assert.equal(parseMultiplier(''), Number.POSITIVE_INFINITY);
  });

  test('无法解析的字符串返回 Infinity', () => {
    assert.equal(parseMultiplier('免费'), Number.POSITIVE_INFINITY);
    assert.equal(parseMultiplier('credits'), Number.POSITIVE_INFINITY);
  });

  test('非字符串输入不崩溃', () => {
    assert.equal(parseMultiplier(123), Number.POSITIVE_INFINITY);
    assert.equal(parseMultiplier({}), Number.POSITIVE_INFINITY);
    assert.equal(parseMultiplier([]), Number.POSITIVE_INFINITY);
  });

  test('倍率可用于排序：小的排前面', () => {
    const list = ['x2 credits', null, 'x0.00 credits', 'x0.79 credits'];
    const sorted = [...list].sort((a, b) => parseMultiplier(a) - parseMultiplier(b));
    assert.deepEqual(sorted, ['x0.00 credits', 'x0.79 credits', 'x2 credits', null]);
  });
});
