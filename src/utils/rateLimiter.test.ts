import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createAnalyzeRateLimiter,
  createIpRateLimiter,
  normalizeClientIp,
} from './rateLimiter.ts';

test('normalizeClientIp extracts first IP and strips IPv4-mapped IPv6 prefix', () => {
  assert.equal(normalizeClientIp('::ffff:192.0.2.10'), '192.0.2.10');
  assert.equal(normalizeClientIp('203.0.113.5, 10.0.0.1'), '203.0.113.5');
  assert.equal(normalizeClientIp(''), 'unknown');
  assert.equal(normalizeClientIp(undefined), 'unknown');
});

test('createIpRateLimiter allows up to 5 requests per minute per IP and blocks the 6th', () => {
  const limiter = createIpRateLimiter({ maxRequests: 5, windowMs: 60_000 });
  const t0 = 1_700_000_000_000;

  for (let i = 0; i < 5; i += 1) {
    const decision = limiter.consume('203.0.113.7', t0 + i * 1000);
    assert.equal(decision.allowed, true);
    assert.equal(decision.remaining, 4 - i);
  }

  const blocked = limiter.consume('203.0.113.7', t0 + 5000);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfterSeconds, 55);
});

test('createIpRateLimiter tracks separate IPs independently and resets after 60 seconds', () => {
  const limiter = createIpRateLimiter({ maxRequests: 5, windowMs: 60_000 });
  const t0 = 1_700_000_000_000;

  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.consume('198.51.100.1', t0 + i * 500).allowed, true);
  }
  assert.equal(limiter.consume('198.51.100.1', t0 + 3000).allowed, false);

  // Different IP is unaffected
  const otherIp = limiter.consume('198.51.100.2', t0 + 3000);
  assert.equal(otherIp.allowed, true);
  assert.equal(otherIp.remaining, 4);

  // Original IP becomes allowed again once the 60s window expires
  const afterWindow = limiter.consume('198.51.100.1', t0 + 60_001);
  assert.equal(afterWindow.allowed, true);
});

test('createAnalyzeRateLimiter isolates students on same school IP by browser ID (5/min each) up to 60/min IP cap', () => {
  const limiter = createAnalyzeRateLimiter({
    browserMaxRequests: 5,
    ipMaxRequests: 60,
    windowMs: 60_000,
  });
  const sharedSchoolIp = '203.0.113.99';
  const t0 = 1_700_000_000_000;

  // Student A uses 5 requests
  for (let i = 0; i < 5; i += 1) {
    const res = limiter.consume({
      clientId: 'br-student-a-1111',
      ip: sharedSchoolIp,
      now: t0 + i * 500,
    });
    assert.equal(res.allowed, true);
    assert.equal(res.browserRemaining, 4 - i);
  }

  // Student A's 6th request is blocked by browser limit without eating IP budget
  const blockedA = limiter.consume({
    clientId: 'br-student-a-1111',
    ip: sharedSchoolIp,
    now: t0 + 3000,
  });
  assert.equal(blockedA.allowed, false);
  assert.equal(blockedA.limitedBy, 'browser');
  assert.equal(blockedA.ipRemaining, 55);

  // Student B on the exact same school Wi-Fi IP still gets 5 requests
  for (let i = 0; i < 5; i += 1) {
    const res = limiter.consume({
      clientId: 'br-student-b-2222',
      ip: sharedSchoolIp,
      now: t0 + 4000 + i * 200,
    });
    assert.equal(res.allowed, true);
  }

  // 12 students x 5 requests = 60 requests total -> 13th student hits the 60/min IP limit
  for (let s = 3; s <= 12; s += 1) {
    const id = `br-student-${s}-0000`;
    for (let i = 0; i < 5; i += 1) {
      const res = limiter.consume({ clientId: id, ip: sharedSchoolIp, now: t0 + 10_000 });
      assert.equal(res.allowed, true);
    }
  }

  const blockedByIp = limiter.consume({
    clientId: 'br-student-13-0000',
    ip: sharedSchoolIp,
    now: t0 + 11_000,
  });
  assert.equal(blockedByIp.allowed, false);
  assert.equal(blockedByIp.limitedBy, 'ip');
  assert.equal(blockedByIp.browserRemaining, 5);
});

test('createAnalyzeRateLimiter falls back to IP key when browser client ID is missing or invalid', () => {
  const limiter = createAnalyzeRateLimiter({
    browserMaxRequests: 5,
    ipMaxRequests: 60,
    windowMs: 60_000,
  });
  const t0 = 1_700_000_000_000;

  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.consume({ clientId: null, ip: '198.51.100.77', now: t0 + i * 100 }).allowed, true);
  }
  const blocked = limiter.consume({ clientId: 'bad', ip: '198.51.100.77', now: t0 + 1000 });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.limitedBy, 'browser');
});
