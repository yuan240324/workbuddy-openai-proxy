// 限流模块测试。
//
// 重点是「内存有界」：原 PR 用一个只写不删的 Map 去修 CWE-770（资源分配无限制），
// 属于自相矛盾。这里把「有界」作为必须成立的断言，而不是靠人工 review。
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/ratelimit.mjs';

const T0 = 1_700_000_000_000; // 固定基准时间，避免依赖真实时钟

describe('限流：基本行为', () => {
  test('未超限时放行，并给出剩余额度', () => {
    const rl = createRateLimiter({ windowMs: 10_000, max: 3 });
    const a = rl.hit('ip1', T0);
    assert.equal(a.limited, false);
    assert.equal(a.remaining, 2);
    assert.equal(rl.hit('ip1', T0).remaining, 1);
    assert.equal(rl.hit('ip1', T0).remaining, 0);
  });

  test('超出上限后被限流，并给出等待时间', () => {
    const rl = createRateLimiter({ windowMs: 10_000, max: 2 });
    rl.hit('ip1', T0);
    rl.hit('ip1', T0);
    const r = rl.hit('ip1', T0);
    assert.equal(r.limited, true);
    assert.equal(r.remaining, 0);
    // 最早那次在 T0，窗口 10s，所以还需等 10s
    assert.equal(r.retryAfterMs, 10_000);
  });

  test('窗口滑过后自动恢复', () => {
    const rl = createRateLimiter({ windowMs: 10_000, max: 2 });
    rl.hit('ip1', T0);
    rl.hit('ip1', T0);
    assert.equal(rl.hit('ip1', T0).limited, true);
    // 恰好一个窗口之后，最早那次滑出
    assert.equal(rl.hit('ip1', T0 + 10_000).limited, false);
  });

  test('窗口内部分滑出时，等待时间按最早那次算', () => {
    const rl = createRateLimiter({ windowMs: 10_000, max: 2 });
    rl.hit('ip1', T0);
    rl.hit('ip1', T0 + 4_000);
    const r = rl.hit('ip1', T0 + 5_000);
    assert.equal(r.limited, true);
    // 最早那次在 T0，到 T0+10000 滑出 → 从 T0+5000 起还需 5000ms
    assert.equal(r.retryAfterMs, 5_000);
  });

  test('不同来源互不影响', () => {
    const rl = createRateLimiter({ windowMs: 10_000, max: 1 });
    assert.equal(rl.hit('a', T0).limited, false);
    assert.equal(rl.hit('a', T0).limited, true);
    assert.equal(rl.hit('b', T0).limited, false, 'b 不该被 a 拖累');
  });

  test('max=1 时第二次即被限流', () => {
    const rl = createRateLimiter({ windowMs: 1_000, max: 1 });
    assert.equal(rl.hit('x', T0).limited, false);
    assert.equal(rl.hit('x', T0).limited, true);
  });
});

describe('限流：内存有界（回归 CWE-770）', () => {
  test('大量不同来源不会让 Map 无限增长', () => {
    const rl = createRateLimiter({ windowMs: 10_000, max: 5, maxKeys: 100, sweepIntervalMs: 1000 });
    // 同一时刻灌 5000 个不同 IP
    for (let i = 0; i < 5_000; i++) rl.hit(`ip-${i}`, T0);
    assert.ok(rl.size() <= rl.maxKeys, `size=${rl.size()} 应 <= maxKeys=${rl.maxKeys}`);
  });

  test('时间推进后，过期来源会被清扫掉', () => {
    const rl = createRateLimiter({ windowMs: 1_000, max: 5, maxKeys: 10_000, sweepIntervalMs: 1000 });
    for (let i = 0; i < 50; i++) rl.hit(`ip-${i}`, T0);
    assert.ok(rl.size() > 0);
    // 推进到远超窗口，并触发一次清扫
    rl.hit('trigger', T0 + 60_000);
    assert.equal(rl.size(), 1, '只剩刚触发的那个来源');
  });

  test('淘汰的是最久未活动的来源，而不是整个清空', () => {
    const rl = createRateLimiter({ windowMs: 60_000, max: 1, maxKeys: 3, sweepIntervalMs: 1000 });
    rl.hit('oldest', T0);
    rl.hit('mid', T0 + 100);
    rl.hit('newest', T0 + 200);
    // 再来一个新的，触发淘汰
    rl.hit('fresh', T0 + 300);
    assert.ok(rl.size() <= 3, `size=${rl.size()}`);
    assert.equal(rl.hit('newest', T0 + 400).limited, true, '较新的来源应仍在跟踪（额度已用尽）');
  });

  test('被限流的来源不会重复堆积时间戳', () => {
    const rl = createRateLimiter({ windowMs: 10_000, max: 2 });
    for (let i = 0; i < 100; i++) rl.hit('same', T0);
    // 超限后不再 push，所以仍应是 2 条
    assert.equal(rl.hit('same', T0).limited, true);
    assert.ok(rl.size() === 1);
  });
});

describe('限流：reset 与参数兜底', () => {
  test('reset 清空状态', () => {
    const rl = createRateLimiter({ windowMs: 10_000, max: 1 });
    rl.hit('a', T0);
    assert.equal(rl.hit('a', T0).limited, true);
    rl.reset();
    assert.equal(rl.size(), 0);
    assert.equal(rl.hit('a', T0).limited, false);
  });

  test('非法参数回退到默认值，不抛异常', () => {
    const rl = createRateLimiter({ windowMs: 0, max: -5, maxKeys: 0, sweepIntervalMs: 0 });
    assert.ok(rl.windowMs > 0);
    assert.ok(rl.max > 0);
    assert.ok(rl.maxKeys > 0);
    assert.doesNotThrow(() => rl.hit('x', T0));
  });

  test('不传参数也能用（全默认）', () => {
    const rl = createRateLimiter();
    assert.equal(rl.hit('x', T0).limited, false);
    assert.ok(rl.max > 0);
  });

  test('key 为空也能工作（不会互相串）', () => {
    const rl = createRateLimiter({ windowMs: 1000, max: 1 });
    assert.equal(rl.hit('', T0).limited, false);
    assert.equal(rl.hit('', T0).limited, true);
    assert.equal(rl.hit(undefined, T0).limited, false, 'undefined 是另一个键');
  });
});
