import { validateAndNormalizeUrl } from './urlParser.ts';

export const CLOUD_RUN_SAFE_UPLOAD_BYTES = 28 * 1024 * 1024; // 28 MB (Cloud Run HTTP request limit is 32 MB)
export const MAX_SERVER_MULTIPART_BYTES = 30 * 1024 * 1024; // 30 MB multipart safety cap
export const MAX_ORIGINAL_VIDEO_BYTES = 300 * 1024 * 1024; // 300 MB max original file
export const MAX_ORIGINAL_VIDEO_DURATION_SECONDS = 180; // 3 minutes max original duration
export const INLINE_VIDEO_LIMIT_BYTES = 14 * 1024 * 1024; // Use Gemini File API for >14MB (avoids base64 JSON payload bloat)
export const MAX_VIDEO_LONG_SIDE_PX = 1280; // 720p long side

export const VIDEO_TOO_LARGE_CUT_ERROR =
  '영상이 너무 커요. 앞뒤를 잘라 짧게 만든 뒤 다시 올려 주세요';
export const ORIGINAL_VIDEO_LIMIT_ERROR =
  '원본 영상은 최대 300MB, 3분 이하까지만 올릴 수 있어요. 앞뒤를 잘라 짧게 만든 뒤 다시 올려 주세요.';

const EXTENSION_MIME_MAP: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.avi': 'video/x-msvideo',
  '.mkv': 'video/x-matroska',
};

const ALLOWED_MIME_TYPES = new Set([
  'video/mp4',
  'video/quicktime',
  'video/x-m4v',
  'video/webm',
  'video/x-msvideo',
  'video/x-matroska',
  'video/3gpp',
  'video/mpeg',
]);

export function shouldCompressVideo(sizeBytes: number): boolean {
  return sizeBytes > CLOUD_RUN_SAFE_UPLOAD_BYTES;
}

export function shouldUseGeminiFileApi(sizeBytes: number): boolean {
  return sizeBytes >= INLINE_VIDEO_LIMIT_BYTES;
}

export function validateOriginalVideoDuration(durationSeconds: number | null | undefined): {
  valid: boolean;
  error?: string;
} {
  if (durationSeconds == null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    return { valid: true };
  }
  if (durationSeconds > MAX_ORIGINAL_VIDEO_DURATION_SECONDS) {
    return { valid: false, error: ORIGINAL_VIDEO_LIMIT_ERROR };
  }
  return { valid: true };
}

export function calculateScaledDimensions(params: {
  width: number;
  height: number;
  maxLongSide?: number;
}): { width: number; height: number; resized: boolean } {
  const maxLongSide = params.maxLongSide ?? MAX_VIDEO_LONG_SIDE_PX;
  const srcW = Math.max(2, Math.round(params.width));
  const srcH = Math.max(2, Math.round(params.height));
  const longSide = Math.max(srcW, srcH);

  const ensureEven = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

  if (longSide <= maxLongSide) {
    return {
      width: ensureEven(srcW),
      height: ensureEven(srcH),
      resized: false,
    };
  }

  const scale = maxLongSide / longSide;
  return {
    width: ensureEven(srcW * scale),
    height: ensureEven(srcH * scale),
    resized: true,
  };
}

export function calculateTargetVideoBitrate(params: {
  durationSeconds: number;
  targetBytes?: number;
  audioBitrateBps?: number;
}): number {
  const safeDuration = Math.max(1, params.durationSeconds);
  // Aim slightly under 28MB (26MB default) to absorb MP4 container overhead and VBR peaks
  const targetBytes = params.targetBytes ?? 26 * 1024 * 1024;
  const audioBitrateBps = params.audioBitrateBps ?? 128_000;
  const totalBudgetBps = Math.floor((targetBytes * 8) / safeDuration);
  const rawVideoBitrate = totalBudgetBps - audioBitrateBps;

  // Clamp to practical WebCodecs H.264/VP9 bounds [150 kbps, 6 Mbps]
  return Math.max(150_000, Math.min(6_000_000, rawVideoBitrate));
}

export function resolveVideoMimeType(fileName: string, rawMimeType?: string): string | null {
  const normalizedMime = rawMimeType?.trim().toLowerCase().split(';')[0] || '';
  if (
    normalizedMime.startsWith('video/') &&
    (ALLOWED_MIME_TYPES.has(normalizedMime) ||
      normalizedMime === 'video/mp4' ||
      normalizedMime === 'video/quicktime')
  ) {
    return normalizedMime === 'video/x-m4v' ? 'video/mp4' : normalizedMime;
  }
  const dotIdx = fileName.lastIndexOf('.');
  const ext = dotIdx >= 0 ? fileName.slice(dotIdx).toLowerCase() : '';
  if (ext && EXTENSION_MIME_MAP[ext]) {
    return EXTENSION_MIME_MAP[ext];
  }
  if (normalizedMime.startsWith('video/')) {
    return normalizedMime;
  }
  return null;
}

export function validateVideoFileMeta(
  file: {
    name: string;
    type?: string;
    size: number;
  },
  options: { maxBytes?: number; maxBytesError?: string } = {}
): { valid: boolean; mimeType?: string; error?: string } {
  if (!file || typeof file.size !== 'number' || file.size <= 0) {
    return { valid: false, error: '비어 있는 영상 파일은 분석할 수 없어요.' };
  }
  const maxBytes = options.maxBytes ?? MAX_ORIGINAL_VIDEO_BYTES;
  if (file.size > maxBytes) {
    return {
      valid: false,
      error: options.maxBytesError ?? ORIGINAL_VIDEO_LIMIT_ERROR,
    };
  }
  const resolvedMime = resolveVideoMimeType(file.name || '', file.type);
  if (!resolvedMime) {
    return {
      valid: false,
      error: 'MP4, MOV 등 지원되는 영상 파일만 업로드할 수 있어요.',
    };
  }
  return { valid: true, mimeType: resolvedMime };
}

export function formatFileSizeLabel(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) {
    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  }
  return `${mb.toFixed(1)} MB`;
}

export function canStartUrlScreenAnalysis(params: {
  urlInput: string;
  hasUploadedVideo: boolean;
  transcriptInput: string;
}): {
  allowed: boolean;
  reason?:
    | 'instagram_video_required'
    | 'invalid_url'
    | 'external_context_required';
  error?: string;
} {
  const trimmedUrl = params.urlInput.trim();

  if (!trimmedUrl && params.hasUploadedVideo) {
    return { allowed: true };
  }

  const validation = validateAndNormalizeUrl(trimmedUrl);
  if (!validation.valid || !validation.normalizedUrl || !validation.platform) {
    return {
      allowed: false,
      reason: 'invalid_url',
      error: validation.error || '올바른 영상 또는 게시물 링크를 입력해 주세요.',
    };
  }

  if (validation.platform === 'instagram' && !params.hasUploadedVideo) {
    return {
      allowed: false,
      reason: 'instagram_video_required',
      error:
        "인스타 릴스는 링크로 영상을 볼 수 없어요. 인스타 공유 버튼 → '다운로드'로 저장한 뒤 영상을 올려 주세요. 게시물에 'AI 정보' 표시가 있는지도 직접 확인해 보세요.",
    };
  }

  const isYouTube = validation.platform === 'youtube' && Boolean(validation.youtubeVideoId);
  if (!isYouTube && !params.hasUploadedVideo && params.transcriptInput.trim().length < 8) {
    return {
      allowed: false,
      reason: 'external_context_required',
      error:
        '영상을 불러올 수 없어요. 이 링크는 플랫폼 제한으로 영상을 직접 불러올 수 없으니 아래 입력란에 영상 내용이나 자막을 입력해 주세요.',
    };
  }

  return { allowed: true };
}
