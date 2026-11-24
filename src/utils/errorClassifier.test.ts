import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyAnalyzeError, isQuotaExhaustedError } from './errorClassifier';

test('classifyAnalyzeError treats missing/invalid model NOT_FOUND as model error, not video error', () => {
  const err = Object.assign(
    new Error('models/gemini-nonexistent is not found for API version v1beta (404 NOT_FOUND)'),
    { status: 404 }
  );
  const result = classifyAnalyzeError(err, { isYouTubeVideo: true });
  assert.equal(result.status, 502);
  assert.match(result.error, /모델/);
  assert.doesNotMatch(result.error, /영상을 불러올 수 없어요/);
});

test('classifyAnalyzeError treats 429 RESOURCE_EXHAUSTED as quota exceeded with KST 5pm guidance', () => {
  const err = Object.assign(new Error('429 RESOURCE_EXHAUSTED: Quota exceeded for metric'), {
    status: 429,
  });
  assert.equal(isQuotaExhaustedError(err), true);
  const result = classifyAnalyzeError(err, { isYouTubeVideo: true });
  assert.equal(result.status, 429);
  assert.match(result.error, /오늘 무료 사용량을 다 썼어요/);
  assert.match(result.error, /한국 시간 오후 5시/);
  assert.doesNotMatch(result.error, /영상을 불러올 수 없어요/);
});

test('classifyAnalyzeError treats 503 UNAVAILABLE as temporary model overload', () => {
  const err = new Error('503 UNAVAILABLE: This model is currently experiencing high demand.');
  const result = classifyAnalyzeError(err, { isYouTubeVideo: true });
  assert.equal(result.status, 503);
  assert.match(result.error, /요청이 몰리고 있습니다/);
  assert.doesNotMatch(result.error, /영상을 불러올 수 없어요/);
});

test('classifyAnalyzeError returns "영상을 불러올 수 없어요" only for actual video access failures', () => {
  const err1 = new Error('FAILED_PRECONDITION: Unable to fetch fileUri youtube video');
  const r1 = classifyAnalyzeError(err1, { isYouTubeVideo: true });
  assert.equal(r1.status, 422);
  assert.match(r1.error, /영상을 불러올 수 없어요/);

  const err2 = Object.assign(new Error('YouTube video cannot access or is private'), {
    status: 404,
  });
  const r2 = classifyAnalyzeError(err2, { isYouTubeVideo: true });
  assert.equal(r2.status, 422);
  assert.match(r2.error, /영상을 불러올 수 없어요/);
});

test('classifyAnalyzeError identifies AbortError cleanly', () => {
  const abortErr = new DOMException('The operation was aborted', 'AbortError');
  const result = classifyAnalyzeError(abortErr, { isYouTubeVideo: true });
  assert.equal(result.isAborted, true);
  assert.equal(result.status, 499);
});
