'use strict';
// limiter.js — حدّ الطلبات في الذاكرة (instance واحد). كان تكبّر لأكثر من instance، لازم Redis ولا جدول في القاعدة.
module.exports = function createLimiter() {
  const buckets = new Map();
  function hit(key, max, windowMs) {
    const now = Date.now(); let b = buckets.get(key);
    if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
    b.n++;
    return { ok: b.n <= max, retryAfter: Math.max(1, Math.ceil((b.reset - now) / 1000)) };
  }
  // يرمي خطأ 429 كان تعدّى الحدّ
  function check(key, max, windowMs) {
    const r = hit(key, max, windowMs);
    if (!r.ok) throw Object.assign(new Error('rate_limited'), { code: 'rate_limited', status: 429, retryAfter: r.retryAfter });
  }
  const timer = setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60000);
  if (timer.unref) timer.unref();
  return { hit, check, _size: () => buckets.size };
};
