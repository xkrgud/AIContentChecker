import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractErrorMessageFromBody,
  mapHttpStatusToFriendlyError,
  readSafeJsonResponse,
} from './httpResponse.ts';

test('mapHttpStatusToFriendlyError returns specific Korean messages for 413, 502, 504, 503, 429', () => {
  assert.match(mapHttpStatusToFriendlyError(413), /파일이 너무 커요/);
  assert.match(mapHttpStatusToFriendlyError(504), /서버 응답이 늦어요/);
  assert.match(mapHttpStatusToFriendlyError(502), /502/);
  assert.match(mapHttpStatusToFriendlyError(503), /요청이 몰리고/);
  assert.match(mapHttpStatusToFriendlyError(429), /1분에 최대 5회/);
});

test('extractErrorMessageFromBody prefers JSON error field and falls back cleanly for HTML gateway errors', () => {
  assert.equal(
    extractErrorMessageFromBody(JSON.stringify({ error: '서버가 전달한 상세 오류' }), 422),
    '서버가 전달한 상세 오류'
  );

  const html413 = '<html><head><title>413 Request Entity Too Large</title></head><body>nginx</body></html>';
  assert.match(extractErrorMessageFromBody(html413, 413), /파일이 너무 커요/);

  const html504 = '<html><body><h1>504 Gateway Time-out</h1></body></html>';
  assert.match(extractErrorMessageFromBody(html504, 504), /서버 응답이 늦어요/);

  const empty502 = '';
  assert.match(extractErrorMessageFromBody(empty502, 502), /502/);
});

test('readSafeJsonResponse handles non-JSON error responses and malformed 200 HTML without throwing SyntaxError', async () => {
  const html504Response = new Response('<html>504 Gateway Time-out</html>', {
    status: 504,
    headers: { 'Content-Type': 'text/html' },
  });
  const res504 = await readSafeJsonResponse(html504Response, 'analyze');
  assert.equal(res504.ok, false);
  if (!res504.ok) {
    assert.equal(res504.status, 504);
    assert.match(res504.error, /서버 응답이 늦어요/);
  }

  const malformedOk = new Response('<html>unexpected gateway html</html>', {
    status: 200,
    headers: { 'Content-Type': 'text/html' },
  });
  const resMalformed = await readSafeJsonResponse(malformedOk, 'inspect');
  assert.equal(resMalformed.ok, false);
  if (!resMalformed.ok) {
    assert.match(resMalformed.error, /502/);
  }
});
