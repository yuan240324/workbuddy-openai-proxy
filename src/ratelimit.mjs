// 滑动窗口限流：每个来源 IP 在每个时间窗口内最多 N 次请求。
//
// 为什么需要：
// 项目原有的防护（控制台 Origin/Host 校验、apiKey 鉴权）挡的是「未授权的访问」，
// 挡不住两类问题：
//   1. 失控的重试循环 —— 客户端 bug 导致死循环重试，会把上游打爆
//   2. 重端点被反复触发 —— /console/api/probe 一次最多 60 次上游调用 + 至少 15 秒
//      （见 console-api.mjs 里那句「顺序执行，避免打爆上游」）
// 所以限流是「纵深防御 / 健壮性」，不是补一个安全漏洞。
//
// 设计要点：
//   - **内存有界**：Map 定期惰性清扫过期键，并设硬上限。
//     绝不能用一个只写不删的 Map —— 那本身就是在制造 CWE-770（资源分配无限制），
//     用无界结构去修「无界资源」是自相矛盾的。
//   - **不用 setInterval**：定时器会拖住进程退出（server.mjs 用 SIGINT 优雅停机）。
//     改成惰性清扫：每次 hit() 顺带判断是否该清扫。
//   - **纯函数式**：不依赖全局状态，便于单测直接构造多个实例。

/**
 * @param {object} opts
 * @param {number} opts.windowMs   窗口长度（毫秒）
 * @param {number} opts.max        窗口内允许的最大次数
 * @param {number} [opts.maxKeys]  最多跟踪多少个来源键（硬上限，防内存膨胀）
 * @param {number} [opts.sweepIntervalMs] 惰性清扫的最小间隔
 */
export function createRateLimiter({
  windowMs = 10_000,
  max = 600,
  maxKeys = 10_000,
  sweepIntervalMs = 30_000,
} = {}) {
  const 窗口 = Math.max(1, Number(windowMs) || 10_000);
  const 上限 = Math.max(1, Number(max) || 600);
  const 键上限 = Math.max(1, Number(maxKeys) || 10_000);
  const 清扫间隔 = Math.max(1000, Number(sweepIntervalMs) || 30_000);

  /** 来源键 → 时间戳数组（严格升序） */
  const hits = new Map();
  let 上次清扫 = 0;

  /** 丢弃所有已滑出窗口的时间戳；整条都过期就删键。 */
  function 清掉过期(now) {
    for (const [key, list] of hits) {
      let i = 0;
      while (i < list.length && now - list[i] >= 窗口) i++;
      if (i >= list.length) hits.delete(key);
      else if (i > 0) list.splice(0, i);
    }
  }

  /**
   * 清扫。两道防线：
   *   1. 定期清掉过期键（正常路径）
   *   2. 若窗口内活跃键仍超过硬上限（异常情况，例如被大量不同源轮番打），
   *      按「最久未活动」淘汰到上限之内 —— 保留限流能力，而不是整个清空。
   */
  function 惰性清扫(now) {
    if (now - 上次清扫 < 清扫间隔 && hits.size <= 键上限) return;
    上次清扫 = now;
    清掉过期(now);
    if (hits.size <= 键上限) return;
    const 按最后活动 = [...hits.entries()].sort(
      (a, b) => (a[1][a[1].length - 1] ?? 0) - (b[1][b[1].length - 1] ?? 0),
    );
    for (const [key] of 按最后活动.slice(0, hits.size - 键上限)) hits.delete(key);
  }

  return {
    /**
     * 记一次访问。
     * @returns {{limited: boolean, retryAfterMs: number, remaining: number}}
     */
    hit(key, now = Date.now()) {
      let list = hits.get(key);
      if (!list) {
        list = [];
        hits.set(key, list);
      }
      // 先丢掉该键已滑出窗口的时间戳
      while (list.length && now - list[0] >= 窗口) list.shift();

      let 结果;
      if (list.length >= 上限) {
        // 最早那次滑出窗口后就恢复
        结果 = { limited: true, retryAfterMs: Math.max(0, 窗口 - (now - list[0])), remaining: 0 };
      } else {
        list.push(now);
        结果 = { limited: false, retryAfterMs: 0, remaining: 上限 - list.length };
      }

      // 清扫必须放在**插入之后**：键数上限要按插入后的 size 判定。
      // 先扫后插会让 size 短暂比 maxKeys 多一个（实测差 1，被单测抓到过）。
      惰性清扫(now);
      return 结果;
    },

    /** 当前跟踪的键数量（测试用来断言内存有界）。 */
    size() {
      return hits.size;
    },

    /** 清空状态（测试用）。 */
    reset() {
      hits.clear();
      上次清扫 = 0;
    },

    // 暴露给测试断言
    windowMs: 窗口,
    max: 上限,
    maxKeys: 键上限,
  };
}
