import type { PlatformType } from '../types/analysis.ts';

export interface UrlValidationResult {
  valid: boolean;
  normalizedUrl?: string;
  platform?: PlatformType;
  youtubeVideoId?: string;
  isShortVideo?: boolean;
  error?: string;
}

export interface SharedPayload {
  url?: string;
  title?: string;
  text?: string;
  hasSharedParams: boolean;
}

const PRIVATE_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^::1$/,
  /^\[::1\]$/,
  /^fe80:/i,
  /^fc00:/i,
  /^fd00:/i,
  /\.local$/i,
  /\.internal$/i,
];

export function isPrivateOrReservedHostname(hostname: string): boolean {
  const cleanHost = hostname.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!cleanHost) return true;
  return PRIVATE_HOSTNAME_PATTERNS.some((pattern) => pattern.test(cleanHost));
}

export function extractYouTubeVideoId(parsed: URL): string | undefined {
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be') {
    const id = parsed.pathname.split('/').filter(Boolean)[0];
    return id && /^[a-zA-Z0-9_-]{6,20}$/.test(id) ? id : undefined;
  }
  if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com') {
    const vParam = parsed.searchParams.get('v');
    if (vParam && /^[a-zA-Z0-9_-]{6,20}$/.test(vParam)) {
      return vParam;
    }
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length >= 2 && (parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed')) {
      return /^[a-zA-Z0-9_-]{6,20}$/.test(parts[1]) ? parts[1] : undefined;
    }
  }
  return undefined;
}

export function normalizeYouTubeWatchUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

export function detectPlatform(hostname: string): PlatformType {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  if (host === 'youtu.be' || host.endsWith('youtube.com')) {
    return 'youtube';
  }
  if (host === 'instagr.am' || host.endsWith('instagram.com')) {
    return 'instagram';
  }
  if (host.endsWith('tiktok.com')) {
    return 'tiktok';
  }
  if (host.endsWith('threads.net') || host.endsWith('threads.com')) {
    return 'threads';
  }
  return 'web';
}

export function getPlatformLabel(platform?: PlatformType): string {
  switch (platform) {
    case 'youtube':
      return 'YouTube';
    case 'instagram':
      return 'Instagram';
    case 'tiktok':
      return 'TikTok';
    case 'threads':
      return 'Threads';
    case 'web':
      return '웹 콘텐츠';
    default:
      return '외부 링크';
  }
}

export function validateAndNormalizeUrl(rawInput: string): UrlValidationResult {
  const trimmed = rawInput.trim();
  if (!trimmed) {
    return { valid: false, error: '분석할 영상이나 게시물의 URL을 입력해 주세요.' };
  }

  let candidate = trimmed;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(candidate)) {
      return { valid: false, error: 'http 또는 https 형식의 웹 링크만 지원합니다.' };
    }
    candidate = `https://${candidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { valid: false, error: '올바른 URL 형식이 아닙니다. 링크 전체를 확인해 주세요.' };
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { valid: false, error: 'http 또는 https 프로토콜 링크만 분석할 수 있습니다.' };
  }

  if (!parsed.hostname || !parsed.hostname.includes('.')) {
    return { valid: false, error: '유효한 도메인이 포함된 링크를 입력해 주세요.' };
  }

  if (isPrivateOrReservedHostname(parsed.hostname)) {
    return { valid: false, error: '내부 네트워크 또는 로컬 주소는 분석할 수 없습니다.' };
  }

  const platform = detectPlatform(parsed.hostname);
  const youtubeVideoId = platform === 'youtube' ? extractYouTubeVideoId(parsed) : undefined;
  const isShortVideo =
    (platform === 'youtube' && parsed.pathname.toLowerCase().includes('/shorts/')) ||
    platform === 'tiktok' ||
    platform === 'instagram';

  if (platform === 'youtube' && !youtubeVideoId) {
    return {
      valid: false,
      error:
        '올바른 YouTube 영상(watch, shorts, youtu.be, live) 링크 형식이 아닙니다. 영상 고유 ID가 포함되었는지 확인해 주세요.',
    };
  }

  const normalizedUrl =
    platform === 'youtube' && youtubeVideoId
      ? normalizeYouTubeWatchUrl(youtubeVideoId)
      : parsed.toString();

  return {
    valid: true,
    normalizedUrl,
    platform,
    youtubeVideoId,
    isShortVideo,
  };
}

export function isInstagramUrl(rawInput: string): boolean {
  const trimmed = rawInput.trim();
  if (!trimmed) return false;
  const validation = validateAndNormalizeUrl(trimmed);
  return Boolean(validation.valid && validation.platform === 'instagram');
}

export function extractShareTargetParams(search: string): SharedPayload {
  const params = new URLSearchParams(search);
  const rawUrl = params.get('url')?.trim() || undefined;
  const rawTitle = params.get('title')?.trim() || undefined;
  const rawText = params.get('text')?.trim() || undefined;

  let detectedUrl = rawUrl;
  if (!detectedUrl && rawText) {
    const match = rawText.match(/https?:\/\/[^\s"'<>]+/i);
    if (match) {
      detectedUrl = match[0];
    }
  }

  const hasSharedParams = Boolean(rawUrl || rawTitle || rawText);

  return {
    url: detectedUrl,
    title: rawTitle,
    text: rawText,
    hasSharedParams,
  };
}
