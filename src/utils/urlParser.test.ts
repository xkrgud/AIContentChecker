import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractShareTargetParams,
  isPrivateOrReservedHostname,
  validateAndNormalizeUrl,
} from './urlParser';

test('validateAndNormalizeUrl converts YouTube Shorts and youtu.be to watch?v=ID format', () => {
  const shorts = validateAndNormalizeUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ?si=test123');
  assert.equal(shorts.valid, true);
  assert.equal(shorts.platform, 'youtube');
  assert.equal(shorts.youtubeVideoId, 'dQw4w9WgXcQ');
  assert.equal(shorts.normalizedUrl, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ');

  const mobileShorts = validateAndNormalizeUrl('https://m.youtube.com/shorts/AbCdEf12345');
  assert.equal(mobileShorts.valid, true);
  assert.equal(mobileShorts.normalizedUrl, 'https://www.youtube.com/watch?v=AbCdEf12345');

  const shortLink = validateAndNormalizeUrl('youtu.be/abc123XYZ?feature=share');
  assert.equal(shortLink.valid, true);
  assert.equal(shortLink.platform, 'youtube');
  assert.equal(shortLink.youtubeVideoId, 'abc123XYZ');
  assert.equal(shortLink.normalizedUrl, 'https://www.youtube.com/watch?v=abc123XYZ');
});

test('validateAndNormalizeUrl rejects YouTube links missing video ID', () => {
  const channel = validateAndNormalizeUrl('https://www.youtube.com/@somechannel');
  assert.equal(channel.valid, false);
});

test('validateAndNormalizeUrl detects Instagram Reels and TikTok links', () => {
  const ig = validateAndNormalizeUrl('https://www.instagram.com/reel/C1234567890/');
  assert.equal(ig.valid, true);
  assert.equal(ig.platform, 'instagram');
  assert.equal(ig.youtubeVideoId, undefined);

  const tt = validateAndNormalizeUrl('https://www.tiktok.com/@creator/video/7289100000');
  assert.equal(tt.valid, true);
  assert.equal(tt.platform, 'tiktok');
});

test('validateAndNormalizeUrl rejects unsafe schemes and private network addresses', () => {
  assert.equal(validateAndNormalizeUrl('').valid, false);
  assert.equal(validateAndNormalizeUrl('javascript:alert(1)').valid, false);
  assert.equal(validateAndNormalizeUrl('http://localhost:3000/test').valid, false);
  assert.equal(validateAndNormalizeUrl('http://127.0.0.1/admin').valid, false);
  assert.equal(validateAndNormalizeUrl('http://169.254.169.254/latest/meta-data').valid, false);
  assert.equal(isPrivateOrReservedHostname('192.168.0.10'), true);
  assert.equal(isPrivateOrReservedHostname('youtube.com'), false);
});

test('extractShareTargetParams extracts URL directly or embedded inside shared text', () => {
  const direct = extractShareTargetParams('?url=https%3A%2F%2Fwww.youtube.com%2Fshorts%2Fxyz123&title=테스트');
  assert.equal(direct.hasSharedParams, true);
  assert.equal(direct.url, 'https://www.youtube.com/shorts/xyz123');
  assert.equal(direct.title, '테스트');

  const embedded = extractShareTargetParams(
    '?text=' + encodeURIComponent('이 릴스 영상 확인해보세요 https://www.instagram.com/reel/C999888/ 흥미롭네요')
  );
  assert.equal(embedded.hasSharedParams, true);
  assert.equal(embedded.url, 'https://www.instagram.com/reel/C999888/');
});
