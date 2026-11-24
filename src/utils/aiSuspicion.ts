import type {
  AiLogoClue,
  AiSuspicionBreakdown,
  AiSuspicionLevel,
  AiTimestampClue,
} from '../types/analysis.ts';

export function hasValidVideoTimestamp(timestamp?: string | null): boolean {
  if (!timestamp) return false;
  const trimmed = timestamp.trim();
  if (!trimmed) return false;
  // Matches m:ss, mm:ss, or h:mm:ss (e.g. 0:04, 01:23, 1:02:15)
  return /\b\d{1,2}:\d{2}(?::\d{2})?\b/.test(trimmed);
}

const KEYWORD_MATCHERS: Array<{ label: string; pattern: RegExp }> = [
  { label: 'Sora', pattern: /(?<![a-z0-9])sora\d*(?![a-z0-9])/i },
  { label: 'Veo', pattern: /(?<![a-z0-9])veo\d*(?![a-z0-9])/i },
  { label: 'Kling', pattern: /(?<![a-z0-9])kling(?:ai)?(?![a-z0-9])/i },
  { label: 'Runway', pattern: /(?<![a-z0-9])runway(?:ml)?(?![a-z0-9])/i },
  { label: 'Midjourney', pattern: /(?<![a-z0-9])midjourney(?![a-z0-9])/i },
  { label: 'Luma', pattern: /(?<![a-z0-9])luma(?:\s*dream\s*machine)?(?![a-z0-9])/i },
  { label: 'Pika', pattern: /(?<![a-z0-9])pika(?:labs)?(?![a-z0-9])/i },
  { label: 'HeyGen', pattern: /(?<![a-z0-9])heygen(?![a-z0-9])/i },
  { label: 'Hailuo', pattern: /(?<![a-z0-9])hailuo(?![a-z0-9])/i },
  { label: 'Seedance', pattern: /(?<![a-z0-9])seedance(?![a-z0-9])/i },
  { label: '딥페이크', pattern: /딥페이크|(?<![a-z0-9])deepfake(?![a-z0-9])/i },
  { label: 'AIGC', pattern: /(?<![a-z0-9])aigc(?![a-z0-9])/i },
  {
    label: 'AI 생성/합성',
    pattern:
      /(?<![a-z0-9])ai\s*(?:생성|합성|영상|제작|이미지|더빙|보이스|목소리|그림)|(?<![a-z0-9])(?:ai-generated|made\s+with\s+ai|created\s+with\s+ai)(?![a-z0-9])/i,
  },
  { label: '#AI / AI', pattern: /(?<![a-z0-9])(?:a\.i\.|ai)(?![a-z0-9])|#ai(?![a-z0-9])/i },
];

export function detectAiMetadataKeywords(input: {
  title?: string;
  description?: string;
  tags?: string[];
  extraText?: string;
}): string[] {
  const combined = [
    input.title ?? '',
    input.description ?? '',
    ...(input.tags ?? []).map((t) => `#${t}`),
    input.extraText ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  if (!combined.trim()) return [];

  const found: string[] = [];
  for (const matcher of KEYWORD_MATCHERS) {
    if (matcher.pattern.test(combined) && !found.includes(matcher.label)) {
      found.push(matcher.label);
    }
  }
  return found;
}

export function parseIso8601DurationSeconds(isoDuration?: string | null): number | null {
  if (!isoDuration) return null;
  const match = isoDuration.trim().match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/i);
  if (!match) return null;
  const hours = Number(match[1] ?? 0);
  const minutes = Number(match[2] ?? 0);
  const seconds = Number(match[3] ?? 0);
  return hours * 3600 + minutes * 60 + seconds;
}

export function determineAiSuspicionLevel(score: number | null | undefined): AiSuspicionLevel {
  if (score == null || Number.isNaN(score)) {
    return '판별 불가';
  }
  if (score >= 60) {
    return '의심 단서 많음';
  }
  if (score >= 30) {
    return '일부 의심';
  }
  return '의심 단서 적음';
}

export function getReliabilityScoreFromAiSuspicion(
  suspicionScore: number | null | undefined
): number {
  if (suspicionScore == null || Number.isNaN(suspicionScore)) {
    return 5;
  }
  if (suspicionScore <= 29) {
    return 10;
  }
  if (suspicionScore <= 59) {
    return 5;
  }
  return 0;
}

export function calculateAiSuspicionScore(params: {
  available: boolean;
  aiLogos: AiLogoClue[];
  visualAndAudioClues: AiTimestampClue[];
  metadataKeywords: string[];
}): AiSuspicionBreakdown {
  const logoFound = params.aiLogos.length > 0;
  const metadataKeywordFound = params.metadataKeywords.length > 0;

  if (!params.available) {
    return {
      available: false,
      totalScore: null,
      maxScore: 100,
      level: '판별 불가',
      logoFound,
      logoScore: 0,
      logoMaxScore: 40,
      timestampedClueCount: 0,
      excludedClueCount: 0,
      timestampCluesScore: 0,
      timestampCluesMaxScore: 40,
      metadataKeywordFound,
      metadataKeywordScore: 0,
      metadataKeywordMaxScore: 20,
      totalCluesDetected: (logoFound ? params.aiLogos.length : 0) + (metadataKeywordFound ? 1 : 0),
    };
  }

  // Exclude logo clues from visualAndAudioClues if AI somehow repeated a logo entry in both arrays
  const nonLogoClues = params.visualAndAudioClues.filter(
    (clue) => !/로고|워터마크|watermark|logo/i.test(clue.category)
  );
  const validTimestampClues = nonLogoClues.filter((clue) => hasValidVideoTimestamp(clue.timestamp));
  const excludedClueCount = nonLogoClues.length - validTimestampClues.length;

  const logoScore = logoFound ? 40 : 0;
  const timestampCluesScore = Math.min(40, validTimestampClues.length * 10);
  const metadataKeywordScore = metadataKeywordFound ? 20 : 0;

  const totalScore = Math.min(100, logoScore + timestampCluesScore + metadataKeywordScore);
  const level = determineAiSuspicionLevel(totalScore);

  const totalCluesDetected =
    params.aiLogos.length +
    validTimestampClues.length +
    (metadataKeywordFound ? params.metadataKeywords.length : 0);

  return {
    available: true,
    totalScore,
    maxScore: 100,
    level,
    logoFound,
    logoScore,
    logoMaxScore: 40,
    timestampedClueCount: validTimestampClues.length,
    excludedClueCount,
    timestampCluesScore,
    timestampCluesMaxScore: 40,
    metadataKeywordFound,
    metadataKeywordScore,
    metadataKeywordMaxScore: 20,
    totalCluesDetected,
  };
}

export function getAiSuspicionMeta(level: AiSuspicionLevel): {
  label: string;
  badgeClass: string;
  gaugeStrokeColor: string;
} {
  switch (level) {
    case '의심 단서 많음':
      return {
        label: '의심 단서 많음',
        badgeClass: 'bg-rose-50 border-rose-200 text-rose-950',
        gaugeStrokeColor: '#BE123C',
      };
    case '일부 의심':
      return {
        label: '일부 의심',
        badgeClass: 'bg-amber-50 border-amber-200 text-amber-950',
        gaugeStrokeColor: '#B45309',
      };
    case '의심 단서 적음':
      return {
        label: '의심 단서 적음',
        badgeClass: 'bg-emerald-50 border-emerald-200 text-emerald-950',
        gaugeStrokeColor: '#15803D',
      };
    case '판별 불가':
      return {
        label: '판별 불가',
        badgeClass: 'bg-slate-100 border-slate-300 text-slate-800',
        gaugeStrokeColor: '#64748B',
      };
  }
}
