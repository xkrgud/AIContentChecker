import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateScaledDimensions,
  calculateTargetVideoBitrate,
  canStartUrlScreenAnalysis,
  CLOUD_RUN_SAFE_UPLOAD_BYTES,
  INLINE_VIDEO_LIMIT_BYTES,
  MAX_ORIGINAL_VIDEO_BYTES,
  MAX_ORIGINAL_VIDEO_DURATION_SECONDS,
  resolveVideoMimeType,
  shouldCompressVideo,
  shouldUseGeminiFileApi,
  validateOriginalVideoDuration,
  validateVideoFileMeta,
} from './videoUpload.ts';
import { isInstagramUrl, validateAndNormalizeUrl } from './urlParser.ts';

test('shouldCompressVideo triggers strictly above 28MB Cloud Run safe limit', () => {
  assert.equal(shouldCompressVideo(10 * 1024 * 1024), false);
  assert.equal(shouldCompressVideo(CLOUD_RUN_SAFE_UPLOAD_BYTES), false);
  assert.equal(shouldCompressVideo(CLOUD_RUN_SAFE_UPLOAD_BYTES + 1), true);
  assert.equal(shouldCompressVideo(80 * 1024 * 1024), true);
});

test('shouldUseGeminiFileApi sends <14MB inline and >=14MB via File API on server', () => {
  assert.equal(shouldUseGeminiFileApi(5 * 1024 * 1024), false);
  assert.equal(shouldUseGeminiFileApi(INLINE_VIDEO_LIMIT_BYTES - 1), false);
  assert.equal(shouldUseGeminiFileApi(INLINE_VIDEO_LIMIT_BYTES), true);
});

test('calculateScaledDimensions caps long side at 1280px with even dimensions and preserves aspect ratio', () => {
  const landscape4k = calculateScaledDimensions({ width: 3840, height: 2160 });
  assert.deepEqual(landscape4k, { width: 1280, height: 720, resized: true });

  const portrait1080 = calculateScaledDimensions({ width: 1080, height: 1920 });
  assert.deepEqual(portrait1080, { width: 720, height: 1280, resized: true });

  const already720p = calculateScaledDimensions({ width: 1280, height: 720 });
  assert.deepEqual(already720p, { width: 1280, height: 720, resized: false });
});

test('calculateTargetVideoBitrate computes duration-fitted bitrate inside 28MB ceiling', () => {
  const bitrate60s = calculateTargetVideoBitrate({ durationSeconds: 60 });
  const totalBytes60s = ((bitrate60s + 128_000) * 60) / 8;
  assert.ok(totalBytes60s <= CLOUD_RUN_SAFE_UPLOAD_BYTES);
  assert.ok(bitrate60s >= 2_000_000);

  const bitrate180s = calculateTargetVideoBitrate({ durationSeconds: 180 });
  const totalBytes180s = ((bitrate180s + 128_000) * 180) / 8;
  assert.ok(totalBytes180s <= CLOUD_RUN_SAFE_UPLOAD_BYTES);
  assert.ok(bitrate180s < bitrate60s);
});

test('validateVideoFileMeta and validateOriginalVideoDuration enforce 300MB and 3-minute limits', () => {
  const mp4 = validateVideoFileMeta({ name: 'reel.mp4', type: 'video/mp4', size: 1024 * 500 });
  assert.equal(mp4.valid, true);
  assert.equal(mp4.mimeType, 'video/mp4');

  const largeUnder300 = validateVideoFileMeta({
    name: 'big.mov',
    type: 'video/quicktime',
    size: 120 * 1024 * 1024,
  });
  assert.equal(largeUnder300.valid, true);

  const over300 = validateVideoFileMeta({
    name: 'huge.mp4',
    type: 'video/mp4',
    size: MAX_ORIGINAL_VIDEO_BYTES + 1,
  });
  assert.equal(over300.valid, false);
  assert.match(over300.error ?? '', /300MB/);

  assert.equal(validateOriginalVideoDuration(MAX_ORIGINAL_VIDEO_DURATION_SECONDS).valid, true);
  assert.equal(validateOriginalVideoDuration(181).valid, false);

  assert.equal(resolveVideoMimeType('doc.pdf', 'application/pdf'), null);
  assert.equal(
    validateVideoFileMeta({ name: 'empty.mp4', type: 'video/mp4', size: 0 }).valid,
    false
  );
});

test('isInstagramUrl and validateAndNormalizeUrl detect Instagram Reels links cleanly', () => {
  assert.equal(isInstagramUrl('https://www.instagram.com/reel/C8xSample99/'), true);
  assert.equal(isInstagramUrl('https://instagr.am/p/AbCdEf/'), true);
  assert.equal(isInstagramUrl('https://www.youtube.com/shorts/dQw4w9WgXcQ'), false);

  const parsed = validateAndNormalizeUrl('https://www.instagram.com/reel/C8xSample99/');
  assert.equal(parsed.platform, 'instagram');
  assert.equal(parsed.isShortVideo, true);
});

test('canStartUrlScreenAnalysis blocks Instagram link without video upload and allows with video or standalone video', () => {
  const blocked = canStartUrlScreenAnalysis({
    urlInput: 'https://www.instagram.com/reel/C8xSample99/',
    hasUploadedVideo: false,
    transcriptInput: '자막이 있어도 영상 업로드가 필요함',
  });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, 'instagram_video_required');
  assert.match(blocked.error ?? '', /다운로드/);
  assert.match(blocked.error ?? '', /AI 정보/);

  const allowedWithVideo = canStartUrlScreenAnalysis({
    urlInput: 'https://www.instagram.com/reel/C8xSample99/',
    hasUploadedVideo: true,
    transcriptInput: '',
  });
  assert.equal(allowedWithVideo.allowed, true);

  const allowedGalleryOnly = canStartUrlScreenAnalysis({
    urlInput: '',
    hasUploadedVideo: true,
    transcriptInput: '',
  });
  assert.equal(allowedGalleryOnly.allowed, true);
});
