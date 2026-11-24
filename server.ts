import 'dotenv/config';
import dns from 'node:dns/promises';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import multer from 'multer';
import { GoogleGenAI, MediaResolution, ThinkingLevel, Type } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import { GEMINI_MODELS } from './src/config/geminiModels.ts';
import {
  isPrivateOrReservedHostname,
  validateAndNormalizeUrl,
} from './src/utils/urlParser.ts';
import {
  calculateReliabilityScore,
  CORE_CHECKLIST_QUESTIONS,
  determineOverallStatusFromScore,
} from './src/utils/analysisHelpers.ts';
import {
  calculateAiSuspicionScore,
  detectAiMetadataKeywords,
  hasValidVideoTimestamp,
  parseIso8601DurationSeconds,
} from './src/utils/aiSuspicion.ts';
import {
  CLOUD_RUN_SAFE_UPLOAD_BYTES,
  MAX_SERVER_MULTIPART_BYTES,
  shouldUseGeminiFileApi,
  VIDEO_TOO_LARGE_CUT_ERROR,
  validateVideoFileMeta,
} from './src/utils/videoUpload.ts';
import {
  applyFactCheckVerdictsToSummaries,
  buildFactCheckReport,
  buildTodayDateInstruction,
  parseMultiClaimFactCheckResponse,
  sanitizeInitialAnalysisText,
  selectClaimsForFactCheck,
} from './src/utils/factCheck.ts';
import {
  classifyAnalyzeError,
  extractErrorStatus,
  isAbortLikeError,
  isQuotaExhaustedError,
  QUOTA_EXHAUSTED_USER_MESSAGE,
} from './src/utils/errorClassifier.ts';
import { createAnalyzeRateLimiter, normalizeClientIp } from './src/utils/rateLimiter.ts';
import type {
  AiGenerationAssessment,
  AiLogoClue,
  AiSuspicionReport,
  AiTimestampClue,
  AnalysisStageId,
  AnalyzedVideoInfo,
  C2paMetadataSummary,
  ChecklistItem,
  ChecklistVerdict,
  ClaimFactCheck,
  CoreClaim,
  ExaggeratedExpression,
  FactCheckReport,
  InputMode,
  PlatformType,
  RealFootageClue,
  SourceAssessment,
  ThreeLineSummary,
  UrlInspectionResult,
  VideoCompressionSummary,
  YouTubeCreatorCheckStatus,
} from './src/types/analysis.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;

function isPrivateIpAddress(ip: string): boolean {
  const version = net.isIP(ip);
  if (version === 4) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) return true;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a >= 224) return true;
    return false;
  }
  if (version === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::' || normalized === '::1') return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
    if (normalized.startsWith('fe80:') || normalized.startsWith('ff')) return true;
    if (normalized.startsWith('::ffff:')) {
      const v4 = normalized.slice(7);
      return isPrivateIpAddress(v4);
    }
    return false;
  }
  return true;
}

async function assertPublicDnsResolution(targetUrl: URL): Promise<void> {
  const host = targetUrl.hostname.replace(/^\[|\]$/g, '');
  if (isPrivateOrReservedHostname(host)) {
    throw new Error('내부 네트워크 주소는 조회할 수 없습니다.');
  }
  if (net.isIP(host)) {
    if (isPrivateIpAddress(host)) {
      throw new Error('사설 IP 주소는 조회할 수 없습니다.');
    }
    return;
  }
  const records = await dns.lookup(host, { all: true });
  if (!records.length || records.some((r) => isPrivateIpAddress(r.address))) {
    throw new Error('외부 공개 인터넷 주소만 조회할 수 있습니다.');
  }
}

async function safeFetchText(
  rawUrl: string,
  options: { timeoutMs?: number; maxBytes?: number; headers?: Record<string, string> } = {}
): Promise<{ ok: boolean; status: number; text: string; finalUrl: string }> {
  const timeoutMs = options.timeoutMs ?? 6000;
  const maxBytes = options.maxBytes ?? 1_500_000;
  let currentUrl = rawUrl;

  for (let hop = 0; hop < 3; hop += 1) {
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('지원되지 않는 URL 프로토콜입니다.');
    }
    await assertPublicDnsResolution(parsed);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(parsed.toString(), {
        method: 'GET',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent':
            'Mozilla/5.0 (compatible; AIContentCheckerBot/1.0; +https://ai-content-checker.local)',
          'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
          ...(options.headers ?? {}),
        },
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          return { ok: false, status: response.status, text: '', finalUrl: currentUrl };
        }
        const nextUrl = new URL(location, parsed);
        const validation = validateAndNormalizeUrl(nextUrl.toString());
        if (!validation.valid || !validation.normalizedUrl) {
          throw new Error('리다이렉트 대상 URL이 안전하지 않습니다.');
        }
        currentUrl = validation.normalizedUrl;
        continue;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        return { ok: response.ok, status: response.status, text: '', finalUrl: currentUrl };
      }

      const chunks: Uint8Array[] = [];
      let received = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          received += value.byteLength;
          if (received > maxBytes) {
            await reader.cancel();
            break;
          }
          chunks.push(value);
        }
      }
      const decoder = new TextDecoder('utf-8', { fatal: false });
      const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      return {
        ok: response.ok,
        status: response.status,
        text: decoder.decode(merged),
        finalUrl: currentUrl,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  return { ok: false, status: 310, text: '', finalUrl: currentUrl };
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : _;
    })
    .replace(/&#(\d+);/g, (_, code) => {
      const num = Number(code);
      return Number.isFinite(num) ? String.fromCodePoint(num) : _;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMetaTag(html: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patternA = new RegExp(
    `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`,
    'i'
  );
  const patternB = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["'][^>]*>`,
    'i'
  );
  const match = html.match(patternA) || html.match(patternB);
  return match?.[1] ? decodeHtmlEntities(match[1]) : undefined;
}

function extractHtmlTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match?.[1] ? decodeHtmlEntities(match[1]) : undefined;
}

async function fetchYouTubeOEmbed(
  watchUrl: string
): Promise<{ title?: string; author?: string; thumbnailUrl?: string }> {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(watchUrl)}&format=json`;
    const oembedRes = await safeFetchText(oembedUrl, { timeoutMs: 4500, maxBytes: 200_000 });
    if (oembedRes.ok && oembedRes.text) {
      const parsed = JSON.parse(oembedRes.text) as {
        title?: string;
        author_name?: string;
        thumbnail_url?: string;
      };
      return {
        title: parsed.title?.trim(),
        author: parsed.author_name?.trim(),
        thumbnailUrl: parsed.thumbnail_url?.trim(),
      };
    }
  } catch {
    // oEmbed failed
  }
  return {};
}

interface YouTubeDataApiDetails {
  containsSyntheticMedia: boolean;
  title?: string;
  description?: string;
  tags: string[];
  channelTitle?: string;
  thumbnailUrl?: string;
  durationSeconds: number | null;
}

async function fetchYouTubeDataApiDetails(
  videoId: string,
  signal?: AbortSignal
): Promise<{ status: YouTubeCreatorCheckStatus; data: YouTubeDataApiDetails | null }> {
  const ytKey = process.env.YOUTUBE_API_KEY?.trim();
  if (!ytKey || ytKey === 'MY_YOUTUBE_API_KEY') {
    return { status: 'no_api_key', data: null };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4500);
  const onParentAbort = () => controller.abort();
  signal?.addEventListener('abort', onParentAbort, { once: true });

  try {
    const endpoint = `https://www.googleapis.com/youtube/v3/videos?part=status,snippet,contentDetails&id=${encodeURIComponent(
      videoId
    )}&key=${encodeURIComponent(ytKey)}`;
    const response = await fetch(endpoint, {
      method: 'GET',
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return { status: 'failed', data: null };
    }
    const payload = (await response.json()) as {
      items?: Array<{
        status?: { containsSyntheticMedia?: boolean };
        snippet?: {
          title?: string;
          description?: string;
          tags?: string[];
          channelTitle?: string;
          thumbnails?: {
            high?: { url?: string };
            medium?: { url?: string };
            default?: { url?: string };
          };
        };
        contentDetails?: { duration?: string };
      }>;
    };
    const item = payload.items?.[0];
    if (!item) {
      return { status: 'failed', data: null };
    }

    const thumbs = item.snippet?.thumbnails;
    return {
      status: 'checked',
      data: {
        containsSyntheticMedia: Boolean(item.status?.containsSyntheticMedia),
        title: item.snippet?.title?.trim(),
        description: item.snippet?.description?.trim(),
        tags: Array.isArray(item.snippet?.tags) ? item.snippet.tags.filter(Boolean) : [],
        channelTitle: item.snippet?.channelTitle?.trim(),
        thumbnailUrl: thumbs?.high?.url || thumbs?.medium?.url || thumbs?.default?.url,
        durationSeconds: parseIso8601DurationSeconds(item.contentDetails?.duration),
      },
    };
  } catch {
    return { status: 'failed', data: null };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
  }
}

async function inspectYouTubeVideo(
  normalizedWatchUrl: string,
  videoId: string
): Promise<UrlInspectionResult> {
  const oembed = await fetchYouTubeOEmbed(normalizedWatchUrl);
  const title = oembed.title;
  const author = oembed.author;
  const thumbnailUrl = oembed.thumbnailUrl;

  if (title || author) {
    return {
      normalizedUrl: normalizedWatchUrl,
      platform: 'youtube',
      youtubeVideoId: videoId,
      title,
      author,
      thumbnailUrl,
      accessStatus: 'extracted',
      accessMessage:
        'YouTube 영상 정보가 확인되었습니다. 쇼츠 및 단축 링크는 표준 watch 형식으로 변환되었으며, AI가 영상을 직접 분석합니다.',
    };
  }

  return {
    normalizedUrl: normalizedWatchUrl,
    platform: 'youtube',
    youtubeVideoId: videoId,
    accessStatus: 'metadata_only',
    accessMessage:
      'YouTube 링크를 표준 watch 형식으로 변환했습니다. 분석 시작 시 Gemini 영상 입력으로 직접 불러오기를 시도합니다.',
  };
}

async function inspectGeneralSocialUrl(
  normalizedUrl: string,
  platform: PlatformType
): Promise<UrlInspectionResult> {
  try {
    const res = await safeFetchText(normalizedUrl, { timeoutMs: 5500, maxBytes: 1_000_000 });
    if (res.ok && res.text) {
      const title = extractMetaTag(res.text, 'og:title') || extractHtmlTitle(res.text);
      const descriptionText =
        extractMetaTag(res.text, 'og:description') || extractMetaTag(res.text, 'description');

      const hasUsefulText = Boolean(
        (title && !/login|instagram|tiktok/i.test(title)) ||
          (descriptionText && descriptionText.length > 20)
      );

      if (hasUsefulText) {
        return {
          normalizedUrl,
          platform,
          title,
          descriptionText,
          accessStatus: 'metadata_only',
          accessMessage:
            '게시물의 공개 제목·설명 일부만 가져왔습니다. 실제 영상 파일은 플랫폼 제한으로 직접 불러올 수 없으므로, 아래에 영상 내용이나 자막을 입력해 주세요.',
        };
      }
    }
  } catch {
    // Platform blocked automated request or timed out
  }

  return {
    normalizedUrl,
    platform,
    accessStatus: 'inaccessible',
    accessMessage:
      '공유 링크가 등록되었습니다. 해당 플랫폼의 접근 제한으로 영상을 직접 불러올 수 없으니, 영상의 주요 발언이나 화면 텍스트를 아래에 입력해 주세요.',
  };
}

const analysisResponseSchema = {
  type: Type.OBJECT,
  properties: {
    videoAccessible: {
      type: Type.BOOLEAN,
      description:
        '영상 입력(fileData)이 전달된 경우 실제로 영상을 불러와 시청/청취할 수 있었으면 true, 비공개·삭제·접근 불가 등으로 영상을 불러오지 못했으면 반드시 false. 텍스트나 이미지 입력만 있을 때는 true.',
    },
    contentTitle: {
      type: Type.STRING,
      description: '분석한 영상 또는 콘텐츠의 주제를 중학생도 한눈에 알 수 있게 쓴 쉬운 한국어 제목',
    },
    whatVideoIsAbout: {
      type: Type.STRING,
      description:
        '어떤 영상(또는 콘텐츠)인지 쉬운 말로 설명하는 2~3문장. 영상을 불러올 수 없으면 빈 문자열.',
    },
    threeLineSummary: {
      type: Type.OBJECT,
      description: '중학생도 바로 이해할 수 있는 아주 쉬운 3줄 요약',
      properties: {
        whatItIs: {
          type: Type.STRING,
          description: '1줄 요약 - 무슨 영상인지 (1~2문장, 쉬운 일상 말로)',
        },
        watchOutFor: {
          type: Type.STRING,
          description: '2줄 요약 - 주의할 점 (과장된 말, 빠진 근거 등 1~2문장, 쉬운 말로)',
        },
        howToVerify: {
          type: Type.STRING,
          description: '3줄 요약 - 이렇게 확인해 보세요 (직접 해볼 수 있는 간단한 확인 방법 1~2문장)',
        },
      },
      required: ['whatItIs', 'watchOutFor', 'howToVerify'],
    },
    inputSummary: {
      type: Type.STRING,
      description: '콘텐츠가 전달하려는 핵심 내용을 쉬운 말로 요약한 2~3문장',
    },
    extractedImageText: {
      type: Type.STRING,
      description:
        '이미지 입력인 경우 이미지 내부에서 읽어낸 글자와 숫자 정보. 이미지가 아니면 빈 문자열.',
    },
    overallSummary: {
      type: Type.STRING,
      description:
        '1차 내용 정리 요약 (2~3문장). 참/거짓을 판정하거나 "잘못된 정보", "사실이 아님"이라고 말하지 말고, 이 콘텐츠가 어떤 주장과 근거 구조를 제시하는지만 중학생도 이해하기 쉽게 정리.',
    },
    coreClaims: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          claimType: {
            type: Type.STRING,
            description:
              '반드시 "fact" 또는 "opinion" 중 하나. 수치·사건·제품 사양·공식 발표처럼 객관적으로 확인할 수 있는 사실 주장은 "fact", 사용 후기·개인 느낌·평가·추천은 "opinion".',
          },
          claim: {
            type: Type.STRING,
            description: '콘텐츠에서 말하는 핵심 주장 (쉬운 말로)',
          },
          specificFiguresAndFacts: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: '주장에 나온 구체적인 숫자, 기간, 비율, 기관 이름',
          },
          evidenceNeeds: {
            type: Type.STRING,
            description: '이 말이 맞는지 확인하려면 어떤 자료를 찾아봐야 하는지 쉬운 말로 설명',
          },
        },
        required: ['id', 'claimType', 'claim', 'specificFiguresAndFacts', 'evidenceNeeds'],
      },
    },
    exaggeratedExpressions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          phrase: {
            type: Type.STRING,
            description: '원문 또는 영상에서 나온 과장·오해 유발 표현 그대로 인용',
          },
          category: {
            type: Type.STRING,
            description:
              '다음 중 하나: "과장 표현", "근거 없는 확신", "공포·불안 유발", "소비자 오해 유발", "광고·홍보성 표현"',
          },
          reason: {
            type: Type.STRING,
            description: '이 표현이 왜 조심해서 봐야 하는 말인지 쉬운 말로 설명',
          },
        },
        required: ['id', 'phrase', 'category', 'reason'],
      },
    },
    sourceAssessment: {
      type: Type.OBJECT,
      properties: {
        hasCitedSources: {
          type: Type.BOOLEAN,
          description: '콘텐츠 안에 믿고 찾아볼 수 있는 출처가 적혀 있거나 언급되어 있는지 여부',
        },
        citedSourcesSummary: {
          type: Type.STRING,
          description: '콘텐츠에 출처가 어떻게 나와 있는지 쉬운 말로 설명',
        },
        claimsRequiringStatisticsOrStudies: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: '공식 통계나 연구 자료 확인이 꼭 필요한 주장 목록',
        },
        unverifiedWarning: {
          type: Type.STRING,
          description:
            '핵심 주장 최대 3개는 Google 검색으로 관련 자료를 대조하지만, 모든 세부 내용과 전문 자료를 최종 검증한 것은 아니므로 아래 출처 링크와 검색어를 통해 직접 한 번 더 확인해야 한다는 쉬운 안내 문구',
        },
        recommendedOfficialSources: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: '확인해 볼 만한 믿을 수 있는 기관이나 사이트 종류',
        },
        recommendedSearchQueries: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: '사실 확인을 위해 직접 검색해 볼 수 있는 쉬운 한국어 검색어 3~5개',
        },
      },
      required: [
        'hasCitedSources',
        'citedSourcesSummary',
        'claimsRequiringStatisticsOrStudies',
        'unverifiedWarning',
        'recommendedOfficialSources',
        'recommendedSearchQueries',
      ],
    },
    aiGenerationAssessment: {
      type: Type.OBJECT,
      properties: {
        likelihoodLevel: {
          type: Type.STRING,
          description:
            '다음 중 하나: "가능성 낮음", "판별 불확실", "일부 AI 활용 가능성", "AI 생성·합성 의심 요소 발견"',
        },
        observedIndicators: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
          description: '영상·이미지·목소리·글에서 AI가 만들었거나 합성한 것처럼 보이는 특징 (쉬운 말로)',
        },
        audioOrSynthesisNotes: {
          type: Type.STRING,
          description: 'AI 목소리나 합성 영상·이미지 가능성에 대한 쉬운 참고 설명',
        },
        uncertaintyExplanation: {
          type: Type.STRING,
          description: 'AI가 만들었는지 100% 딱 잘라 말하기 어려운 이유를 중학생도 이해하기 쉽게 설명',
        },
      },
      required: [
        'likelihoodLevel',
        'observedIndicators',
        'audioOrSynthesisNotes',
        'uncertaintyExplanation',
      ],
    },
    checklistEvaluations: {
      type: Type.ARRAY,
      description:
        '신뢰성 체크리스트의 5가지 기본 검증 항목에 대해 AI가 콘텐츠를 직접 점검하여 판정("예", "아니오", "확인 필요")과 쉬운 이유(aiReason)를 작성한 결과',
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING },
          question: { type: Type.STRING },
          aiVerdict: {
            type: Type.STRING,
            description: '반드시 다음 3가지 중 하나: "예", "아니오", "확인 필요"',
          },
          aiReason: {
            type: Type.STRING,
            description: '왜 그렇게 판단했는지 쉬운 말로 1~2문장 설명',
          },
        },
        required: ['id', 'question', 'aiVerdict', 'aiReason'],
      },
    },
    additionalVerificationSteps: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: '직접 해볼 수 있는 간단한 확인 방법 3~4가지 (쉬운 말로)',
    },
    aiDetection: {
      type: Type.OBJECT,
      description:
        '영상 입력이 있을 때 화면·소리·메타데이터에서 관찰된 AI 생성·합성 단서 및 실제 촬영 단서 점검 결과. 텍스트·이미지 단독 입력이면 빈 배열과 짧은 안내 문구 반환.',
      properties: {
        aiLogos: {
          type: Type.ARRAY,
          description:
            '화면 구석이나 영상 안에 보이는 AI 생성 도구 로고 또는 워터마크 목록(예: Sora, Veo, Kling, Runway, Luma, Hailuo 등). 없으면 빈 배열.',
          items: {
            type: Type.OBJECT,
            properties: {
              toolName: { type: Type.STRING, description: '도구 이름(예: Sora, Veo, Runway)' },
              timestamp: { type: Type.STRING, description: '보인 시점(반드시 분:초 형식, 예: 0:02)' },
              description: { type: Type.STRING, description: '로고가 어디에 어떻게 보였는지 쉬운 설명' },
            },
            required: ['toolName', 'timestamp', 'description'],
          },
        },
        visualAndAudioClues: {
          type: Type.ARRAY,
          description:
            '손가락·치아·눈 이상, 깨진 글자, 얼굴/머리카락 경계 번짐, 물체 변화, 부자연스러운 움직임, 입모양-소리 불일치, 단조로운 TTS 음성 중 실제로 관찰한 단서만 시점(분:초)과 함께 기록. 로고는 제외.',
          items: {
            type: Type.OBJECT,
            properties: {
              category: {
                type: Type.STRING,
                description:
                  '다음 중 가장 가까운 항목: "손가락·치아·눈 모양 이상", "깨지거나 뜻 없는 글자", "얼굴·머리카락 경계 번짐", "물체가 갑자기 변하거나 사라짐", "부자연스러운 움직임", "입 모양과 소리 불일치", "단조로운 합성 음성", "기타 화면·소리 이상"',
              },
              timestamp: {
                type: Type.STRING,
                description: '단서가 나타난 영상 속 정확한 시점(반드시 분:초 형식, 예: 0:04)',
              },
              description: {
                type: Type.STRING,
                description: '무엇이 어떻게 어색했는지 중학생도 알 수 있게 구체적으로 설명',
              },
            },
            required: ['category', 'timestamp', 'description'],
          },
        },
        realFootageClues: {
          type: Type.ARRAY,
          description:
            '실제로 카메라로 촬영한 영상이라는 단서(자연스러운 손 떨림, 일관된 배경·그림자, 실제 장소·간판·사람 반응 등). 없으면 빈 배열.',
          items: {
            type: Type.OBJECT,
            properties: {
              timestamp: {
                type: Type.STRING,
                description: '해당 모습이 보이는 시점(분:초 형식, 예: 0:03). 영상 전체 특징이면 "전체"',
              },
              description: {
                type: Type.STRING,
                description: '실제 촬영 영상처럼 보이는 구체적인 이유(쉬운 말로)',
              },
            },
            required: ['timestamp', 'description'],
          },
        },
        summaryNote: {
          type: Type.STRING,
          description:
            'AI 생성·합성 단서를 종합한 1~2문장의 쉬운 참고 메모. 절대 "100% AI 영상이다"라고 단정하지 마세요.',
        },
      },
      required: ['aiLogos', 'visualAndAudioClues', 'realFootageClues', 'summaryNote'],
    },
  },
  required: [
    'videoAccessible',
    'contentTitle',
    'whatVideoIsAbout',
    'threeLineSummary',
    'inputSummary',
    'extractedImageText',
    'overallSummary',
    'coreClaims',
    'exaggeratedExpressions',
    'sourceAssessment',
    'aiGenerationAssessment',
    'checklistEvaluations',
    'additionalVerificationSteps',
    'aiDetection',
  ],
};

function sanitizeChecklistVerdict(raw?: string): ChecklistVerdict {
  if (raw === '예' || raw === '아니오' || raw === '확인 필요') {
    return raw;
  }
  if (raw?.includes('예') && !raw.includes('아니오')) return '예';
  if (raw?.includes('아니오')) return '아니오';
  return '확인 필요';
}

const VALID_EXAGGERATION_CATEGORIES = new Set([
  '과장 표현',
  '근거 없는 확신',
  '공포·불안 유발',
  '소비자 오해 유발',
  '광고·홍보성 표현',
]);

const VALID_AI_LEVELS = new Set([
  '가능성 낮음',
  '판별 불확실',
  '일부 AI 활용 가능성',
  'AI 생성·합성 의심 요소 발견',
]);

async function generateWithRetry<T>(
  fn: () => Promise<T>,
  retries = 1,
  signal?: AbortSignal
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (signal?.aborted || isAbortLikeError(error) || isQuotaExhaustedError(error)) {
        throw error;
      }
      const msg = error instanceof Error ? error.message : String(error);
      const isTransient = /503|502|500|timeout|ECONNRESET|UNAVAILABLE/i.test(msg);
      if (!isTransient || attempt === retries) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '10mb' }));

  const analyzeRateLimiter = createAnalyzeRateLimiter({
    browserMaxRequests: 5,
    ipMaxRequests: 60,
    windowMs: 60_000,
  });
  const uploadTempDir = path.join(os.tmpdir(), 'ai-content-checker-uploads');
  fs.mkdirSync(uploadTempDir, { recursive: true });

  const videoUploadMiddleware = multer({
    dest: uploadTempDir,
    limits: {
      fileSize: MAX_SERVER_MULTIPART_BYTES,
      files: 1,
    },
  });

  const shareFallbackParser = multer({
    dest: uploadTempDir,
    limits: { fileSize: MAX_SERVER_MULTIPART_BYTES, files: 1 },
  });

  const maybeParseMultipartVideo: express.RequestHandler = (req, res, next) => {
    if (!req.is('multipart/form-data')) {
      next();
      return;
    }
    videoUploadMiddleware.single('videoFile')(req, res, (err) => {
      if (!err) {
        next();
        return;
      }
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error: VIDEO_TOO_LARGE_CUT_ERROR,
        });
        return;
      }
      res.status(400).json({
        error: '업로드된 영상 파일을 읽는 중 문제가 발생했습니다. 파일 형식을 확인해 주세요.',
      });
    });
  };

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, hasApiKey: Boolean(process.env.GEMINI_API_KEY) });
  });

  // Fallback handler for Web Share Target POST if service worker is not yet active
  app.post('/share-target', shareFallbackParser.any(), async (req, res) => {
    const files = Array.isArray(req.files) ? req.files : [];
    await Promise.all(files.map((f) => fs.promises.unlink(f.path).catch(() => undefined)));
    const params = new URLSearchParams();
    if (typeof req.body?.url === 'string' && req.body.url.trim()) {
      params.set('url', req.body.url.trim());
    }
    if (typeof req.body?.title === 'string' && req.body.title.trim()) {
      params.set('title', req.body.title.trim());
    }
    if (typeof req.body?.text === 'string' && req.body.text.trim()) {
      params.set('text', req.body.text.trim());
    }
    const suffix = params.toString();
    res.redirect(303, suffix ? `/?${suffix}` : '/');
  });

  app.post('/api/inspect-url', async (req, res) => {
    try {
      const rawUrl = typeof req.body?.url === 'string' ? req.body.url : '';
      const validation = validateAndNormalizeUrl(rawUrl);
      if (!validation.valid || !validation.normalizedUrl || !validation.platform) {
        return res.status(400).json({ error: validation.error || '유효하지 않은 URL입니다.' });
      }

      if (validation.platform === 'youtube' && validation.youtubeVideoId) {
        const result = await inspectYouTubeVideo(
          validation.normalizedUrl,
          validation.youtubeVideoId
        );
        return res.json(result);
      }

      const result = await inspectGeneralSocialUrl(validation.normalizedUrl, validation.platform);
      return res.json(result);
    } catch (err) {
      const message =
        err instanceof Error ? err.message : '링크 정보를 확인하는 중 오류가 발생했습니다.';
      return res.status(400).json({ error: message });
    }
  });

  app.post('/api/analyze', maybeParseMultipartVideo, async (req, res) => {
    const uploadedFile = req.file;
    const localUploadedFilePath = uploadedFile?.path;
    let remoteGeminiFileName: string | undefined;
    let aiClientForCleanup: GoogleGenAI | null = null;

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      if (localUploadedFilePath) {
        await fs.promises.unlink(localUploadedFilePath).catch(() => undefined);
      }
      return res.status(500).json({
        error:
          'GEMINI_API_KEY가 설정되어 있지 않습니다. Settings > Secrets 패널에서 API 키를 확인해 주세요.',
      });
    }

    const serverAbortController = new AbortController();
    const handleClientClose = () => {
      if (!res.writableEnded) {
        serverAbortController.abort();
      }
    };
    res.on('close', handleClientClose);

    const wantsStream =
      Boolean(req.get('accept')?.includes('application/x-ndjson')) ||
      req.get('x-stream-progress') === '1';
    let streamStarted = false;

    const startStreamIfWanted = () => {
      if (!wantsStream || streamStarted || res.headersSent) return;
      streamStarted = true;
      res.status(200);
      res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders?.();
    };

    const emitStreamEvent = (event: Record<string, unknown>) => {
      if (!wantsStream || !streamStarted || res.writableEnded) return;
      res.write(`${JSON.stringify(event)}\n`);
    };

    const emitStageProgress = (stage: AnalysisStageId) => {
      emitStreamEvent({ type: 'progress', stage });
    };

    const sendErrorResponse = (status: number, error: string) => {
      if (res.writableEnded) return;
      if (wantsStream && streamStarted) {
        res.write(`${JSON.stringify({ type: 'error', status, error })}\n`);
        res.end();
        return;
      }
      res.status(status).json({ error });
    };

    const sendSuccessResponse = (payload: Record<string, unknown>) => {
      if (res.writableEnded) return;
      if (wantsStream && streamStarted) {
        res.write(`${JSON.stringify({ type: 'result', data: payload })}\n`);
        res.end();
        return;
      }
      res.json(payload);
    };

    let isYouTubeVideo = false;

    try {
      const inputMode = (req.body?.inputMode as InputMode) || 'url';
      const sourceUrl = typeof req.body?.sourceUrl === 'string' ? req.body.sourceUrl.trim() : '';
      const contentTitle =
        typeof req.body?.contentTitle === 'string' ? req.body.contentTitle.trim() : '';
      const textContent =
        typeof req.body?.textContent === 'string' ? req.body.textContent.trim() : '';
      const transcriptOrNotes =
        typeof req.body?.transcriptOrNotes === 'string' ? req.body.transcriptOrNotes.trim() : '';
      const imageDataUrl =
        typeof req.body?.imageDataUrl === 'string' ? req.body.imageDataUrl.trim() : undefined;

      const parseOptionalJson = <T>(raw: unknown): T | null => {
        if (!raw) return null;
        if (typeof raw === 'object') return raw as T;
        if (typeof raw === 'string') {
          try {
            return JSON.parse(raw) as T;
          } catch {
            return null;
          }
        }
        return null;
      };

      const parsedC2paRaw = parseOptionalJson<C2paMetadataSummary>(req.body?.c2paMetadata);
      const clientC2paMetadata: C2paMetadataSummary | null =
        parsedC2paRaw && parsedC2paRaw.hasManifest
          ? {
              hasManifest: true,
              claimGenerator:
                typeof parsedC2paRaw.claimGenerator === 'string'
                  ? parsedC2paRaw.claimGenerator.slice(0, 120)
                  : undefined,
              title:
                typeof parsedC2paRaw.title === 'string'
                  ? parsedC2paRaw.title.slice(0, 120)
                  : undefined,
              issuer:
                typeof parsedC2paRaw.issuer === 'string'
                  ? parsedC2paRaw.issuer.slice(0, 120)
                  : undefined,
              signedAt:
                typeof parsedC2paRaw.signedAt === 'string'
                  ? parsedC2paRaw.signedAt.slice(0, 64)
                  : undefined,
              digitalSourceType:
                typeof parsedC2paRaw.digitalSourceType === 'string'
                  ? parsedC2paRaw.digitalSourceType.slice(0, 160)
                  : undefined,
              isAiGeneratedClaim: Boolean(parsedC2paRaw.isAiGeneratedClaim),
              actions: Array.isArray(parsedC2paRaw.actions)
                ? parsedC2paRaw.actions.filter((a): a is string => typeof a === 'string').slice(0, 6)
                : undefined,
              validationState:
                typeof parsedC2paRaw.validationState === 'string'
                  ? parsedC2paRaw.validationState.slice(0, 40)
                  : undefined,
            }
          : null;

      const parsedCompressionRaw = parseOptionalJson<VideoCompressionSummary>(
        req.body?.compressionSummary
      );
      const clientCompressionSummary: VideoCompressionSummary | null =
        parsedCompressionRaw &&
        typeof parsedCompressionRaw.originalSizeBytes === 'number' &&
        typeof parsedCompressionRaw.compressedSizeBytes === 'number'
          ? {
              wasCompressed: Boolean(parsedCompressionRaw.wasCompressed),
              originalSizeBytes: parsedCompressionRaw.originalSizeBytes,
              compressedSizeBytes: parsedCompressionRaw.compressedSizeBytes,
              durationSeconds:
                typeof parsedCompressionRaw.durationSeconds === 'number'
                  ? parsedCompressionRaw.durationSeconds
                  : undefined,
            }
          : null;

      const rawClientDuration = Number(req.body?.videoDurationSeconds);
      const clientDurationSeconds =
        Number.isFinite(rawClientDuration) && rawClientDuration > 0 ? rawClientDuration : null;

      if (!['url', 'text', 'image'].includes(inputMode)) {
        return sendErrorResponse(400, '올바른 분석 입력 방식을 선택해 주세요.');
      }

      let resolvedUploadedMime: string | undefined;
      if (uploadedFile) {
        const videoValidation = validateVideoFileMeta(
          {
            name: uploadedFile.originalname || 'video.mp4',
            type: uploadedFile.mimetype,
            size: uploadedFile.size,
          },
          {
            maxBytes: CLOUD_RUN_SAFE_UPLOAD_BYTES,
            maxBytesError: VIDEO_TOO_LARGE_CUT_ERROR,
          }
        );
        if (!videoValidation.valid || !videoValidation.mimeType) {
          return sendErrorResponse(
            400,
            videoValidation.error || 'MP4, MOV 등 지원되는 영상 파일만 업로드할 수 있어요.'
          );
        }
        resolvedUploadedMime = videoValidation.mimeType;
      }

      let normalizedUrl: string | undefined = sourceUrl || undefined;
      let platform: PlatformType | undefined = req.body?.platform as PlatformType | undefined;
      let youtubeVideoId: string | undefined;
      let urlIsShortVideo = false;

      if (inputMode === 'url') {
        if (sourceUrl) {
          const validation = validateAndNormalizeUrl(sourceUrl);
          if (!validation.valid || !validation.normalizedUrl || !validation.platform) {
            return sendErrorResponse(400, validation.error || '올바른 URL을 입력해 주세요.');
          }
          normalizedUrl = validation.normalizedUrl;
          platform = validation.platform;
          youtubeVideoId = validation.youtubeVideoId;
          urlIsShortVideo = Boolean(validation.isShortVideo);
          isYouTubeVideo = platform === 'youtube' && Boolean(youtubeVideoId);

          if (platform === 'instagram' && !uploadedFile) {
            return sendErrorResponse(
              422,
              "인스타 릴스는 링크로 영상을 볼 수 없어요. 인스타 공유 버튼 → '다운로드'로 저장한 뒤 영상을 올려 주세요. 게시물에 'AI 정보' 표시가 있는지도 직접 확인해 보세요."
            );
          }

          if (!isYouTubeVideo && !uploadedFile && transcriptOrNotes.length < 8) {
            return sendErrorResponse(
              422,
              '영상을 불러올 수 없어요. 이 링크는 플랫폼 제한으로 영상을 직접 불러올 수 없으니 아래 입력란에 영상 내용이나 자막을 입력해 주세요.'
            );
          }
        } else if (uploadedFile) {
          normalizedUrl = undefined;
          platform = platform || 'web';
          urlIsShortVideo = true;
        } else {
          return sendErrorResponse(400, '분석할 영상 링크를 입력하거나 영상을 올려 주세요.');
        }
      } else if (inputMode === 'text') {
        if (textContent.length < 8) {
          return sendErrorResponse(400, '분석할 텍스트를 8자 이상 입력해 주세요.');
        }
      } else if (inputMode === 'image') {
        if (!imageDataUrl) {
          return sendErrorResponse(400, '분석할 이미지를 업로드해 주세요.');
        }
      }

      // Count 1 slot per /api/analyze execution: 5/min per browser ID, 60/min per IP (school Wi-Fi friendly)
      const clientIp = normalizeClientIp(req.ip || req.socket?.remoteAddress);
      const clientIdHeader = req.get('x-client-id');
      const clientIdBody = typeof req.body?.clientId === 'string' ? req.body.clientId : undefined;
      const rateLimit = analyzeRateLimiter.consume({
        clientId: clientIdHeader || clientIdBody,
        ip: clientIp,
      });
      if (!rateLimit.allowed) {
        res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
        return sendErrorResponse(
          429,
          rateLimit.limitedBy === 'ip'
            ? '같은 네트워크(IP)에서 요청이 너무 많아요. 잠시 후 다시 시도해 주세요. (IP당 1분에 최대 60회)'
            : '잠시 후 다시 시도해 주세요. (브라우저당 1분에 최대 5회까지만 분석할 수 있어요.)'
        );
      }

      // Validation and rate limiting passed -> switch to NDJSON progress stream if requested
      startStreamIfWanted();
      emitStageProgress('loading_video');

      let youtubeMeta: { title?: string; author?: string; thumbnailUrl?: string } = {};
      let ytData: YouTubeDataApiDetails | null = null;
      let ytCheckStatus: YouTubeCreatorCheckStatus | undefined;
      let linkMeta: { title?: string; descriptionText?: string } = {};

      if (inputMode === 'url' && isYouTubeVideo && normalizedUrl) {
        const [oembedResult, ytApiResponse] = await Promise.all([
          fetchYouTubeOEmbed(normalizedUrl),
          youtubeVideoId
            ? fetchYouTubeDataApiDetails(youtubeVideoId, serverAbortController.signal)
            : Promise.resolve({
                status: 'failed' as YouTubeCreatorCheckStatus,
                data: null,
              }),
        ]);
        ytCheckStatus = ytApiResponse.status;
        const ytApiResult = ytApiResponse.data;
        youtubeMeta = {
          title: ytApiResult?.title || oembedResult.title,
          author: ytApiResult?.channelTitle || oembedResult.author,
          thumbnailUrl: ytApiResult?.thumbnailUrl || oembedResult.thumbnailUrl,
        };
        ytData = ytApiResult;
      } else if (
        inputMode === 'url' &&
        !isYouTubeVideo &&
        normalizedUrl &&
        platform &&
        (!contentTitle || !transcriptOrNotes)
      ) {
        try {
          const inspected = await inspectGeneralSocialUrl(normalizedUrl, platform);
          linkMeta = {
            title: inspected.title,
            descriptionText: inspected.descriptionText,
          };
        } catch {
          // Ignore optional social link metadata fetch failure when video file is uploaded
        }
      }

      if (serverAbortController.signal.aborted) {
        return;
      }

      const resolvedDurationSeconds =
        ytData?.durationSeconds ?? clientDurationSeconds ?? clientCompressionSummary?.durationSeconds ?? null;

      const sampledFps = 1;

      emitStreamEvent({
        type: 'meta',
        videoDurationSeconds: resolvedDurationSeconds,
        hasDirectVideo: Boolean((isYouTubeVideo && normalizedUrl) || uploadedFile),
      });

      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: {
          headers: {
            'User-Agent': 'aistudio-build',
          },
        },
      });
      aiClientForCleanup = ai;

      type GeminiPart =
        | { text: string }
        | { inlineData: { mimeType: string; data: string }; videoMetadata?: { fps?: number } }
        | { fileData: { fileUri: string; mimeType?: string }; videoMetadata?: { fps?: number } };

      const uploadVideoViaFileApi = async (): Promise<{
        fileData: { fileUri: string; mimeType: string };
      }> => {
        if (!localUploadedFilePath || !resolvedUploadedMime) {
          throw new Error('업로드된 영상 파일을 찾을 수 없습니다.');
        }
        const uploaded = await ai.files.upload({
          file: localUploadedFilePath,
          config: {
            mimeType: resolvedUploadedMime,
            displayName: uploadedFile?.originalname || 'uploaded-video.mp4',
          },
        });
        if (!uploaded.name) {
          throw new Error('영상 파일 업로드에 실패했습니다.');
        }
        remoteGeminiFileName = uploaded.name;

        let current = uploaded;
        const maxWaitMs = 120_000;
        const startedAt = Date.now();
        while (current.state === 'PROCESSING') {
          if (serverAbortController.signal.aborted) {
            throw new DOMException('Aborted', 'AbortError');
          }
          if (Date.now() - startedAt > maxWaitMs) {
            throw new Error('대용량 영상 파일 처리 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.');
          }
          await new Promise((resolve) => setTimeout(resolve, 1500));
          current = await ai.files.get({ name: uploaded.name });
        }

        if (current.state === 'FAILED' || !current.uri) {
          throw new Error('업로드된 영상 파일을 Gemini에서 처리하지 못했습니다.');
        }

        return {
          fileData: {
            fileUri: current.uri,
            mimeType: current.mimeType || resolvedUploadedMime,
          },
        };
      };

      let uploadedVideoPart:
        | { inlineData: { mimeType: string; data: string } }
        | { fileData: { fileUri: string; mimeType: string } }
        | null = null;

      if (uploadedFile && localUploadedFilePath && resolvedUploadedMime) {
        if (shouldUseGeminiFileApi(uploadedFile.size)) {
          uploadedVideoPart = await uploadVideoViaFileApi();
        } else {
          const buffer = await fs.promises.readFile(localUploadedFilePath);
          uploadedVideoPart = {
            inlineData: {
              mimeType: resolvedUploadedMime,
              data: buffer.toString('base64'),
            },
          };
        }
      }

      if (serverAbortController.signal.aborted) {
        return;
      }

      const hasDirectVideoInput = Boolean((isYouTubeVideo && normalizedUrl) || uploadedVideoPart);
      const parts: GeminiPart[] = [];

      if (uploadedVideoPart) {
        parts.push({
          ...uploadedVideoPart,
          videoMetadata: { fps: sampledFps },
        });
      } else if (isYouTubeVideo && normalizedUrl) {
        parts.push({
          fileData: {
            fileUri: normalizedUrl,
          },
          videoMetadata: { fps: sampledFps },
        });
      }

      if (imageDataUrl) {
        const match = imageDataUrl.match(
          /^data:(image\/(?:png|jpeg|jpg|webp|gif));base64,([A-Za-z0-9+/=]+)$/
        );
        if (!match) {
          return sendErrorResponse(
            400,
            'PNG, JPG, WEBP, GIF 형식의 올바른 이미지 파일만 분석할 수 있습니다.'
          );
        }
        const mimeType = match[1] === 'image/jpg' ? 'image/jpeg' : match[1];
        const base64Data = match[2];
        if (base64Data.length > 11_000_000) {
          return sendErrorResponse(400, '이미지 파일 용량은 8MB 이하만 지원합니다.');
        }
        parts.push({
          inlineData: {
            mimeType,
            data: base64Data,
          },
        });
      }

      const checklistPromptSection = CORE_CHECKLIST_QUESTIONS.map(
        (q, idx) => `${idx + 1}. [id: ${q.id}] ${q.question}`
      ).join('\n');

      const resolvedLinkTitle = contentTitle || linkMeta.title || '';
      const resolvedLinkDescription = linkMeta.descriptionText || '';

      let promptText = '';
      if (uploadedVideoPart) {
        const linkContextLines = [
          normalizedUrl ? `[연결된 게시물 링크 (참고용)]\n${normalizedUrl}` : '',
          resolvedLinkTitle ? `[게시물 제목]\n${resolvedLinkTitle}` : '',
          resolvedLinkDescription ? `[게시물 공개 설명]\n${resolvedLinkDescription}` : '',
          transcriptOrNotes ? `[사용자가 함께 적은 메모·자막]\n${transcriptOrNotes}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');

        promptText = [
          '사용자가 직접 올린 영상 파일이 이 요청에 이미 첨부되어 있습니다. 링크 사이트에 접속할 필요 없이, 첨부된 영상 파일의 화면과 소리를 직접 보고 들은 뒤 중학생도 이해하기 쉬운 말로 분석해 주세요.',
          '중요 원칙: 첨부된 영상 파일이 손상되어 화면·소리를 전혀 읽을 수 없는 경우에만 videoAccessible을 false로 설정하세요. 영상이 보인다면(짧은 영상이나 단순 화면이라도) 반드시 videoAccessible을 true로 두고 보이는 내용과 함께 전달된 링크·메모를 바탕으로 분석하세요.',
          '영상을 확인했다면:',
          '1) whatVideoIsAbout에 이 영상이 어떤 영상인지 쉬운 말로 설명하고, threeLineSummary(무슨 영상인지 / 주의할 점 / 이렇게 확인해 보세요)를 채워 주세요.',
          '2) 핵심 주장과 수치, 과장·오해 유발 표현, 출처 제시 여부, AI 생성/합성 가능성을 쉬운 일상 언어로 분석하세요.',
          `3) 아래 신뢰성 체크리스트 5개 항목을 직접 점검하고 각 항목에 대해 "예", "아니오", "확인 필요" 중 하나와 쉬운 이유(aiReason)를 checklistEvaluations에 모두 채워 주세요:\n${checklistPromptSection}`,
          '4) 동시에 aiDetection 항목도 함께 점검하세요: 화면의 AI 도구 로고/워터마크(aiLogos), 손가락·글자·움직임·입모양·TTS 음성 이상 단서(visualAndAudioClues, 반드시 분:초 시점 포함), 실제 촬영 단서(realFootageClues)를 실제 관찰한 내용만 적고 단서가 없으면 빈 배열로 두세요.',
          linkContextLines,
        ]
          .filter(Boolean)
          .join('\n\n');
      } else if (isYouTubeVideo) {
        promptText = [
          '첨부된 유튜브 영상을 직접 보고 들은 뒤, 중학생도 이해하기 쉬운 말로 분석해 주세요.',
          '중요 원칙: 만약 영상을 실제로 불러오지 못하거나 비공개·오류 등으로 내용을 확인할 수 없다면, 절대 내용을 지어내지 말고 videoAccessible을 false로 설정하세요.',
          '영상을 정상적으로 불러왔다면:',
          '1) whatVideoIsAbout에 이 영상이 어떤 영상인지 쉬운 말로 설명하고, threeLineSummary(무슨 영상인지 / 주의할 점 / 이렇게 확인해 보세요)를 채워 주세요.',
          '2) 핵심 주장과 수치, 과장·오해 유발 표현, 출처 제시 여부, AI 생성/합성 가능성을 쉬운 일상 언어로 분석하세요.',
          `3) 아래 신뢰성 체크리스트 5개 항목을 직접 점검하고 각 항목에 대해 "예", "아니오", "확인 필요" 중 하나와 쉬운 이유(aiReason)를 checklistEvaluations에 모두 채워 주세요:\n${checklistPromptSection}`,
          '4) 동시에 aiDetection 항목도 함께 점검하세요: 화면의 AI 도구 로고/워터마크(aiLogos), 손가락·글자·움직임·입모양·TTS 음성 이상 단서(visualAndAudioClues, 반드시 분:초 시점 포함), 실제 촬영 단서(realFootageClues)를 실제 관찰한 내용만 적고 단서가 없으면 빈 배열로 두세요.',
          transcriptOrNotes ? `\n[사용자가 추가로 적은 메모]\n${transcriptOrNotes}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');
      } else if (inputMode === 'image') {
        const contextText = [
          contentTitle ? `[콘텐츠 제목]\n${contentTitle}` : '',
          textContent ? `[함께 입력된 설명]\n${textContent}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');
        promptText = [
          '첨부된 이미지를 중학생도 이해하기 쉬운 말로 분석해 주세요. whatVideoIsAbout에는 어떤 이미지인지 설명하고, threeLineSummary(무슨 콘텐츠인지 / 주의할 점 / 이렇게 확인해 보세요)와 이미지 속 글자(extractedImageText)를 정리하세요.',
          `또한 아래 신뢰성 체크리스트 5개 항목을 직접 점검하여 checklistEvaluations에 판정("예", "아니오", "확인 필요")과 쉬운 이유를 모두 채워 주세요:\n${checklistPromptSection}`,
          '이미지 입력이므로 aiDetection의 aiLogos/visualAndAudioClues/realFootageClues는 빈 배열([])로 두고 summaryNote에만 간단한 안내를 적으세요.',
          contextText,
        ]
          .filter(Boolean)
          .join('\n\n');
      } else {
        const contextText = [
          contentTitle ? `[콘텐츠 제목]\n${contentTitle}` : '',
          textContent ? `[본문 텍스트]\n${textContent}` : '',
          transcriptOrNotes ? `[영상 자막/내용]\n${transcriptOrNotes}` : '',
        ]
          .filter(Boolean)
          .join('\n\n');
        promptText = [
          '다음 콘텐츠를 중학생도 이해하기 쉬운 말로 분석해 주세요. whatVideoIsAbout에는 어떤 내용의 글인지 설명하고, threeLineSummary(무슨 콘텐츠인지 / 주의할 점 / 이렇게 확인해 보세요)를 채워 주세요.',
          `또한 아래 신뢰성 체크리스트 5개 항목을 직접 점검하여 checklistEvaluations에 판정("예", "아니오", "확인 필요")과 쉬운 이유를 모두 채워 주세요:\n${checklistPromptSection}`,
          '텍스트 입력이므로 aiDetection의 aiLogos/visualAndAudioClues/realFootageClues는 빈 배열([])로 두고 summaryNote에만 간단한 안내를 적으세요.',
          contextText,
        ].join('\n\n');
      }

      parts.push({ text: promptText });

      const todayDateInstruction = buildTodayDateInstruction();

      const systemInstruction = `${todayDateInstruction}

당신은 'AI Content Checker'의 친절하고 쉬운 콘텐츠 신뢰도 안내 도우미입니다.
모든 답변은 반드시 **중학생도 한 번에 읽고 이해할 수 있는 쉬운 한국어**로 작성하세요.

말투 및 작성 원칙:
1. 어려운 전문 용어나 딱딱한 한자어(예: "임상시험", "동료 심사", "인과관계 단정", "포렌식", "메타데이터", "프레임을 조장하다") 대신 누구나 쓰는 쉬운 말(예: "사람을 대상으로 한 실제 실험", "다른 전문가들이 검증한 연구", "원인과 결과를 성급하게 연결함", "컴퓨터로 만든 흔적")로 풀어서 쓰세요.
2. 문장은 짧고 분명하게 쓰고, "~해요" 또는 "~입니다" 체로 읽기 편하게 작성하세요.
3. 영상을 불러오지 못했을 때는 절대 내용을 지어내지 마세요.
   - videoAccessible 필드를 정확히 판단하세요. 영상 내용을 실제로 보거나 듣지 못했다면 videoAccessible = false로 반환하세요.
4. 어떤 영상인지와 3줄 요약(무슨 영상인지 / 주의할 점 / 이렇게 확인해 보세요)을 꼭 알기 쉽게 채워 주세요.
5. 신뢰성 체크리스트 5개 항목(id 포함)은 당신(AI)이 직접 점검해 각각 "예", "아니오", "확인 필요" 중 하나와 쉬운 이유를 적어 주세요.
6. coreClaims의 각 주장은 반드시 사실 주장("fact": 수치, 사건, 제품 사양, 발표처럼 객관적 확인이 가능한 것)과 의견 주장("opinion": 사용 후기, 평가, 느낌, 추천)으로 나누어 claimType에 기록하세요.
7. 1차 분석(내용 분석)에서는 주장이 사실인지 아닌지 절대 판단하지 말고 주장만 정리하세요. "잘못된 정보", "사실이 아님", "거짓 정보", "허위 사실", "무조건 거짓", "100% 사실" 같은 표현은 절대 쓰지 마세요.
8. 사실 확인은 이 단계 뒤의 별도 Google 검색 단계에서만 진행합니다. 이 1차 분석에서는 주장과 근거 구조를 정리하고, 사용자가 추가로 확인해 볼 공식 자료와 검색어를 안내해 주세요.
9. 영상 입력이 있을 때는 aiDetection에 화면·소리에서 실제로 관찰한 AI 생성·합성 단서와 실제 촬영 단서만 시점(분:초)과 함께 적고, 단서가 없으면 빈 배열로 두며, 절대 "100% AI 영상이다"라고 단정 짓지 마세요.`;

      const buildMainPartsWithCurrentVideo = (): GeminiPart[] => {
        if (!uploadedVideoPart) return parts;
        return [
          { ...uploadedVideoPart, videoMetadata: { fps: sampledFps } },
          ...parts.slice(1),
        ];
      };

      const shouldApplyLowMediaResolution = Boolean(hasDirectVideoInput || imageDataUrl);

      const invokeAnalysisCall = async (modelName: string) => {
        const currentParts = buildMainPartsWithCurrentVideo();
        try {
          return await ai.models.generateContent({
            model: modelName,
            contents: { parts: currentParts },
            config: {
              systemInstruction,
              responseMimeType: 'application/json',
              responseSchema: analysisResponseSchema,
              thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
              ...(shouldApplyLowMediaResolution
                ? { mediaResolution: MediaResolution.MEDIA_RESOLUTION_LOW }
                : {}),
              abortSignal: serverAbortController.signal,
            },
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (
            shouldApplyLowMediaResolution &&
            /400|INVALID_ARGUMENT/i.test(msg) &&
            /media_?resolution/i.test(msg)
          ) {
            console.warn(
              `[api/analyze] ${modelName} rejected mediaResolution=LOW (${msg}); retrying without mediaResolution.`
            );
            return await ai.models.generateContent({
              model: modelName,
              contents: { parts: currentParts },
              config: {
                systemInstruction,
                responseMimeType: 'application/json',
                responseSchema: analysisResponseSchema,
                thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
                abortSignal: serverAbortController.signal,
              },
            });
          }
          throw err;
        }
      };

      let usedFallbackModel = false;

      const runMainAnalysisWithFallback = async () => {
        try {
          return await generateWithRetry(
            () => invokeAnalysisCall(GEMINI_MODELS.primaryAnalysis),
            1,
            serverAbortController.signal
          );
        } catch (primaryErr) {
          if (serverAbortController.signal.aborted || isAbortLikeError(primaryErr)) {
            throw primaryErr;
          }
          const primaryMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
          const primaryStatus = extractErrorStatus(primaryErr);
          console.error('[api/analyze] primary analysis model failed:', {
            model: GEMINI_MODELS.primaryAnalysis,
            status: primaryStatus ?? null,
            message: primaryMsg,
          });

          if (
            uploadedVideoPart &&
            'inlineData' in uploadedVideoPart &&
            /413|payload|entity too large|request size|too large/i.test(primaryMsg)
          ) {
            uploadedVideoPart = await uploadVideoViaFileApi();
            return await invokeAnalysisCall(GEMINI_MODELS.primaryAnalysis);
          }

          if (
            isQuotaExhaustedError(primaryErr) ||
            /503|UNAVAILABLE|high demand/i.test(primaryMsg)
          ) {
            usedFallbackModel = true;
            try {
              return await generateWithRetry(
                () => invokeAnalysisCall(GEMINI_MODELS.fallbackAnalysis),
                1,
                serverAbortController.signal
              );
            } catch (fallbackErr) {
              const fallbackMsg =
                fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
              console.error('[api/analyze] fallback analysis model failed:', {
                model: GEMINI_MODELS.fallbackAnalysis,
                status: extractErrorStatus(fallbackErr) ?? null,
                message: fallbackMsg,
              });
              throw fallbackErr;
            }
          }
          throw primaryErr;
        }
      };

      interface RawAiDetectionResult {
        aiLogos?: Array<{ toolName?: string; timestamp?: string; description?: string }>;
        visualAndAudioClues?: Array<{
          category?: string;
          timestamp?: string;
          description?: string;
        }>;
        realFootageClues?: Array<{ timestamp?: string; description?: string }>;
        summaryNote?: string;
      }

      // Single combined Call 1 (content analysis + AI generation clues)
      emitStageProgress('analyzing_content');
      const response = await runMainAnalysisWithFallback();

      if (serverAbortController.signal.aborted || res.writableEnded) {
        return;
      }

      const rawText = response.text?.trim();
      if (!rawText) {
        if (hasDirectVideoInput) {
          return sendErrorResponse(
            422,
            '영상을 불러올 수 없어요. 영상 파일이나 링크 상태를 확인해 주세요.'
          );
        }
        return sendErrorResponse(502, 'AI 분석 응답이 비어 있습니다. 잠시 후 다시 시도해 주세요.');
      }

      let parsed: {
        videoAccessible?: boolean;
        contentTitle?: string;
        whatVideoIsAbout?: string;
        threeLineSummary?: Partial<ThreeLineSummary>;
        inputSummary?: string;
        extractedImageText?: string;
        overallSummary?: string;
        coreClaims?: CoreClaim[];
        exaggeratedExpressions?: ExaggeratedExpression[];
        sourceAssessment?: SourceAssessment;
        aiGenerationAssessment?: AiGenerationAssessment;
        checklistEvaluations?: Array<{
          id?: string;
          question?: string;
          aiVerdict?: string;
          aiReason?: string;
        }>;
        additionalVerificationSteps?: string[];
        aiDetection?: RawAiDetectionResult;
      };

      parsed = JSON.parse(rawText);

      if (hasDirectVideoInput && parsed.videoAccessible === false) {
        return sendErrorResponse(
          422,
          isYouTubeVideo
            ? '영상을 불러올 수 없어요. 비공개·삭제된 영상이거나 접근할 수 없는 유튜브 링크인지 확인해 주세요.'
            : '영상을 불러올 수 없어요. 업로드한 영상 파일이 손상되지 않았는지 확인해 주세요.'
        );
      }

      if (serverAbortController.signal.aborted || res.writableEnded) {
        return;
      }

      const coreClaims: CoreClaim[] = Array.isArray(parsed.coreClaims)
        ? parsed.coreClaims.map((item, idx) => ({
            id: item.id || `claim-${idx + 1}`,
            claimType: item.claimType === 'opinion' ? 'opinion' : 'fact',
            claim: item.claim || '',
            specificFiguresAndFacts: Array.isArray(item.specificFiguresAndFacts)
              ? item.specificFiguresAndFacts.filter(Boolean)
              : [],
            evidenceNeeds: item.evidenceNeeds || '믿을 수 있는 기관의 자료로 확인이 필요해요.',
          }))
        : [];

      const exaggeratedExpressions: ExaggeratedExpression[] = Array.isArray(
        parsed.exaggeratedExpressions
      )
        ? parsed.exaggeratedExpressions.map((item, idx) => ({
            id: item.id || `expr-${idx + 1}`,
            phrase: item.phrase || '',
            category: VALID_EXAGGERATION_CATEGORIES.has(item.category)
              ? item.category
              : '과장 표현',
            reason: item.reason || '',
          }))
        : [];

      const sourceAssessment: SourceAssessment = {
        hasCitedSources: Boolean(parsed.sourceAssessment?.hasCitedSources),
        citedSourcesSummary:
          parsed.sourceAssessment?.citedSourcesSummary ||
          '콘텐츠 안에 어디서 나온 정보인지 구체적인 출처가 잘 보이지 않아요.',
        claimsRequiringStatisticsOrStudies: Array.isArray(
          parsed.sourceAssessment?.claimsRequiringStatisticsOrStudies
        )
          ? parsed.sourceAssessment.claimsRequiringStatisticsOrStudies.filter(Boolean)
          : [],
        unverifiedWarning:
          parsed.sourceAssessment?.unverifiedWarning ||
          '핵심 주장 최대 3개는 Google 검색 자료와 함께 대조했지만, 모든 세부 내용을 최종 판정한 것은 아니에요. 검색된 출처 링크와 추천 검색어로 직접 한 번 더 확인해 보세요.',
        recommendedOfficialSources: Array.isArray(
          parsed.sourceAssessment?.recommendedOfficialSources
        )
          ? parsed.sourceAssessment.recommendedOfficialSources.filter(Boolean)
          : ['국가 기관 공식 발표 자료 및 믿을 수 있는 뉴스·백과사전'],
        recommendedSearchQueries: Array.isArray(parsed.sourceAssessment?.recommendedSearchQueries)
          ? parsed.sourceAssessment.recommendedSearchQueries.filter(Boolean)
          : [],
      };

      const rawAiLevel = parsed.aiGenerationAssessment?.likelihoodLevel || '판별 불확실';
      const aiGenerationAssessment: AiGenerationAssessment = {
        likelihoodLevel: VALID_AI_LEVELS.has(rawAiLevel)
          ? (rawAiLevel as AiGenerationAssessment['likelihoodLevel'])
          : '판별 불확실',
        observedIndicators: Array.isArray(parsed.aiGenerationAssessment?.observedIndicators)
          ? parsed.aiGenerationAssessment.observedIndicators.filter(Boolean)
          : [],
        audioOrSynthesisNotes:
          parsed.aiGenerationAssessment?.audioOrSynthesisNotes ||
          'AI 목소리나 합성 여부를 지금 정보만으로 딱 잘라 말하기는 어려워요.',
        uncertaintyExplanation:
          parsed.aiGenerationAssessment?.uncertaintyExplanation ||
          'AI가 만든 것인지 100% 정확히 가려내는 기술은 아직 완벽하지 않아서 참고 의견으로만 봐야 해요.',
      };

      const aiChecklistMap = new Map(
        (parsed.checklistEvaluations ?? []).map((item) => [item.id || '', item])
      );

      const checklist: ChecklistItem[] = CORE_CHECKLIST_QUESTIONS.map((q, idx) => {
        const matched =
          aiChecklistMap.get(q.id) || (parsed.checklistEvaluations ?? [])[idx];
        const aiVerdict = sanitizeChecklistVerdict(matched?.aiVerdict);
        return {
          id: q.id,
          question: q.question,
          category: '기본 검증',
          hint: q.hint,
          aiVerdict,
          aiReason:
            matched?.aiReason?.trim() ||
            '제시된 콘텐츠 내용을 바탕으로 해당 항목을 확인했어요.',
          checked: aiVerdict === '예',
        };
      });

      coreClaims.slice(0, 2).forEach((claim, idx) => {
        checklist.push({
          id: `chk-claim-${idx + 1}`,
          question: `핵심 주장 "${claim.claim}"에 충분한 근거가 있나요?`,
          category: '주장별 검증',
          hint: claim.evidenceNeeds,
          aiVerdict: '확인 필요',
          aiReason: claim.evidenceNeeds || '믿을 수 있는 다른 자료와 비교해 확인해 보는 게 좋아요.',
          checked: false,
        });
      });

      // Build AI suspicion clues & deterministic score from combined Call 1 response
      const rawDetection = hasDirectVideoInput ? parsed.aiDetection ?? null : null;
      const aiLogos: AiLogoClue[] = Array.isArray(rawDetection?.aiLogos)
        ? rawDetection.aiLogos
            .filter((logo) => Boolean(logo?.toolName?.trim() || logo?.description?.trim()))
            .map((logo) => ({
              toolName: logo.toolName?.trim() || 'AI 도구',
              timestamp: logo.timestamp?.trim() || '화면 내 확인',
              description: logo.description?.trim() || '화면에서 AI 도구 로고가 관찰되었어요.',
            }))
        : [];

      const visualAndAudioClues: AiTimestampClue[] = Array.isArray(
        rawDetection?.visualAndAudioClues
      )
        ? rawDetection.visualAndAudioClues
            .filter(
              (clue) =>
                Boolean(clue?.description?.trim()) && hasValidVideoTimestamp(clue?.timestamp)
            )
            .map((clue, idx) => ({
              id: `ai-clue-${idx + 1}`,
              category: clue.category?.trim() || '화면·소리 단서',
              timestamp: clue.timestamp!.trim(),
              description: clue.description!.trim(),
            }))
        : [];

      const realFootageClues: RealFootageClue[] = Array.isArray(rawDetection?.realFootageClues)
        ? rawDetection.realFootageClues
            .filter((clue) => Boolean(clue?.description?.trim()))
            .map((clue) => ({
              timestamp: clue.timestamp?.trim() || undefined,
              description: clue.description!.trim(),
            }))
        : [];

      const metadataKeywords = detectAiMetadataKeywords({
        title: youtubeMeta.title || resolvedLinkTitle || parsed.contentTitle || uploadedFile?.originalname,
        description: ytData?.description || resolvedLinkDescription,
        tags: ytData?.tags,
        extraText: transcriptOrNotes,
      });

      const detectionAvailable = Boolean(hasDirectVideoInput);
      const suspicionBreakdown = calculateAiSuspicionScore({
        available: detectionAvailable,
        aiLogos,
        visualAndAudioClues,
        metadataKeywords,
      });

      const aiSuspicion: AiSuspicionReport = {
        available: detectionAvailable,
        score: suspicionBreakdown.totalScore,
        level: suspicionBreakdown.level,
        breakdown: suspicionBreakdown,
        creatorDisclosedSyntheticMedia: Boolean(ytData?.containsSyntheticMedia),
        youtubeCreatorCheckStatus: isYouTubeVideo ? ytCheckStatus : undefined,
        aiLogos,
        visualAndAudioClues,
        metadataKeywords,
        realFootageClues,
        summaryNote:
          rawDetection?.summaryNote?.trim() ||
          (detectionAvailable
            ? suspicionBreakdown.totalCluesDetected === 0
              ? '영상 화면과 소리에서 뚜렷한 AI 합성 단서가 적게 관찰되었어요. 다만 최신 AI 영상은 단서가 거의 남지 않을 수도 있어 참고용으로만 봐 주세요.'
              : `영상과 정보에서 총 ${suspicionBreakdown.totalCluesDetected}개의 AI 관련 단서가 관찰되었어요. 단서의 양일 뿐 AI 영상이라는 확정 판정은 아니에요.`
            : '이 링크는 영상 프레임을 직접 불러올 수 없어 AI 생성 의심도 화면·소리 점검을 건너뛰었어요.'),
        sampledFps: hasDirectVideoInput ? sampledFps : undefined,
        agenticVideoEnabled: false,
      };

      // Calculate reliability score deterministically by code rules (100-point max)
      // using AI suspicion score for the 10-point AI slot, and derive overallStatus from it.
      const scoreBreakdown = calculateReliabilityScore({
        checklist,
        exaggeratedCount: exaggeratedExpressions.length,
        aiLikelihoodLevel: aiGenerationAssessment.likelihoodLevel,
        aiSuspicionScore: suspicionBreakdown.totalScore,
        aiSuspicionLevel: suspicionBreakdown.level,
      });
      const reliabilityScore = scoreBreakdown.totalScore;
      const overallStatus = determineOverallStatusFromScore(reliabilityScore);

      const resolvedTitle =
        youtubeMeta.title ||
        resolvedLinkTitle ||
        parsed.contentTitle ||
        uploadedFile?.originalname ||
        '콘텐츠 신뢰도 분석 결과';

      const analyzedVideoInfo: AnalyzedVideoInfo = {
        title:
          youtubeMeta.title ||
          resolvedLinkTitle ||
          parsed.contentTitle ||
          uploadedFile?.originalname ||
          undefined,
        author: youtubeMeta.author,
        thumbnailUrl: youtubeMeta.thumbnailUrl,
        normalizedUrl,
        uploadedFileName: uploadedFile?.originalname,
        whatVideoIsAbout: sanitizeInitialAnalysisText(
          parsed.whatVideoIsAbout || parsed.inputSummary || ''
        ),
        durationSeconds: resolvedDurationSeconds ?? undefined,
      };

      let finalOverallSummary = sanitizeInitialAnalysisText(parsed.overallSummary || '');
      const threeLineSummary: ThreeLineSummary = {
        whatItIs:
          sanitizeInitialAnalysisText(parsed.threeLineSummary?.whatItIs || '') ||
          analyzedVideoInfo.whatVideoIsAbout ||
          sanitizeInitialAnalysisText(parsed.inputSummary || '') ||
          '입력한 콘텐츠의 내용을 정리했어요.',
        watchOutFor:
          sanitizeInitialAnalysisText(parsed.threeLineSummary?.watchOutFor || '') ||
          (exaggeratedExpressions.length > 0
            ? `과장되거나 오해하기 쉬운 표현이 ${exaggeratedExpressions.length}개 보여서 조심해서 봐야 해요.`
            : '출처와 근거가 충분한지 한 번 더 살펴보는 게 좋아요.'),
        howToVerify:
          parsed.threeLineSummary?.howToVerify?.trim() ||
          (parsed.additionalVerificationSteps?.[0] ??
            '아래 추천 검색어로 믿을 수 있는 공식 자료나 뉴스를 찾아 비교해 보세요.'),
      };

      const { toCheck: claimsToFactCheck, remaining: remainingUncheckedClaims } =
        selectClaimsForFactCheck(coreClaims);

      const currentYear = new Date().getFullYear();

      const runFactCheckBatchWithGoogleSearch = async (
        claims: CoreClaim[]
      ): Promise<ClaimFactCheck[]> => {
        if (claims.length === 0) return [];

        const claimBlocksPrompt = claims
          .map((item, idx) => {
            const num = idx + 1;
            const typeLabel = item.claimType === 'opinion' ? '의견 주장' : '사실 주장';
            const factsNote =
              item.specificFiguresAndFacts.length > 0
                ? ` (언급된 수치·내용: ${item.specificFiguresAndFacts.join(', ')})`
                : '';
            return `${num}. [${typeLabel}] ${item.claim}${factsNote}`;
          })
          .join('\n');

        const factPrompt = [
          `아래 핵심 주장(최대 3개, 사실 주장 우선 선별)을 각각 Google 검색 도구(google_search)로 검색해 최신 자료를 기준으로 판정해 주세요.`,
          `검색 전략: 반드시 제품명·사건명·인물명과 **${currentYear}년**(올해 연도)을 검색어에 함께 넣어 최신 공식 자료·언론 보도·리뷰를 우선 찾으세요.`,
          resolvedTitle ? `[콘텐츠 제목 맥락]\n${resolvedTitle}` : '',
          `[확인할 핵심 주장 목록]\n${claimBlocksPrompt}`,
          '출력 형식 규칙 (반드시 아래 태그와 항목 이름을 각 주장 번호에 맞춰 정확히 지켜 주세요):',
          claims
            .map((item, idx) => {
              const allowedVerdicts =
                item.claimType === 'opinion'
                  ? '다른 리뷰·기사에도 비슷한 평가가 있음 | 비슷한 평가를 찾지 못함 | 확인 불가'
                  : '사실과 일치 | 사실과 다름 | 확인 불가';
              return [
                `[CLAIM ${idx + 1}]`,
                `판정: (${allowedVerdicts} 중 정확히 하나만 적기)`,
                '이유: (검색된 자료를 바탕으로 판정 이유를 중학생도 이해할 수 있는 쉬운 한국어 한 문장으로 적기. 자료를 못 찾았으면: 확인된 자료 없음)',
                '출처날짜: (검색으로 확인한 출처들의 작성·수정일. 예: 2026-10-15 | 2025-03-01, 날짜를 알 수 없으면: 날짜 미상)',
                `[/CLAIM ${idx + 1}]`,
              ].join('\n');
            })
            .join('\n\n'),
          '판정 원칙:',
          '1. [사실 주장]은 검색된 최신 자료와 비교해 반드시 "사실과 일치", "사실과 다름", "확인 불가" 중 하나로 판정하세요.',
          '2. [의견 주장]은 다른 최신 리뷰·기사를 찾아보고 "다른 리뷰·기사에도 비슷한 평가가 있음", "비슷한 평가를 찾지 못함", 또는 자료가 전혀 없으면 "확인 불가"로 표시하세요.',
          '3. 검색 자료를 찾지 못했거나 근거가 불충분하면 추측하지 말고 반드시 판정을 "확인 불가"로 적고 이유에 "확인된 자료 없음"을 적어 주세요.',
          '4. 오래된 기억이 아니라 방금 검색한 최신 웹 자료와 출처 날짜를 기준으로 판단하세요.',
        ]
          .filter(Boolean)
          .join('\n\n');

        try {
          const searchResponse = await ai.models.generateContent({
            model: GEMINI_MODELS.factCheck,
            contents: factPrompt,
            config: {
              systemInstruction: `${todayDateInstruction}\n\n당신은 Google 검색 최신 자료를 바탕으로 주장을 대조·판정하는 팩트체크 도우미입니다. 검색 시 제품명·사건명과 올해 연도(${currentYear}년)를 포함해 최신 자료를 우선 찾고, 근거가 없으면 반드시 "확인 불가"로 표시하세요. 중학생도 이해하기 쉬운 한국어 한 문장으로 이유를 적으세요.`,
              tools: [{ googleSearch: {} }],
              thinkingConfig: { thinkingBudget: 0 },
              abortSignal: serverAbortController.signal,
            },
          });

          const responseText = searchResponse.text?.trim();
          if (!responseText) {
            return claims.map((claimItem) => ({
              claimId: claimItem.id,
              claim: claimItem.claim,
              claimType: claimItem.claimType === 'opinion' ? 'opinion' : 'fact',
              status: 'search_error',
              verdict: '확인 불가',
              summary: '검색 중 오류가 났어요',
              sources: [],
              searchQueries: [],
            }));
          }

          const groundingMeta = searchResponse.candidates?.[0]?.groundingMetadata;
          return parseMultiClaimFactCheckResponse(claims, responseText, groundingMeta);
        } catch (err) {
          if (serverAbortController.signal.aborted || isAbortLikeError(err)) {
            throw err;
          }
          const errStatus = extractErrorStatus(err);
          const errMessage = err instanceof Error ? err.message : String(err);
          console.error('[api/analyze] fact-check model failed:', {
            model: GEMINI_MODELS.factCheck,
            status: errStatus ?? null,
            message: errMessage,
          });
          const quotaHit = isQuotaExhaustedError(err);
          return claims.map((claimItem) => ({
            claimId: claimItem.id,
            claim: claimItem.claim,
            claimType: claimItem.claimType === 'opinion' ? 'opinion' : 'fact',
            status: 'search_error',
            verdict: '확인 불가',
            summary: quotaHit ? QUOTA_EXHAUSTED_USER_MESSAGE : '검색 중 오류가 났어요',
            sources: [],
            searchQueries: [],
          }));
        }
      };

      emitStageProgress('fact_checking');
      const checkedClaimResults = await runFactCheckBatchWithGoogleSearch(claimsToFactCheck);
      const factCheck: FactCheckReport = buildFactCheckReport(
        checkedClaimResults,
        remainingUncheckedClaims
      );

      if (serverAbortController.signal.aborted || res.writableEnded) {
        return;
      }

      const mergedSummaries = applyFactCheckVerdictsToSummaries({
        overallSummary: finalOverallSummary,
        threeLineSummary,
        factCheck,
      });
      finalOverallSummary = mergedSummaries.overallSummary;
      threeLineSummary.whatItIs = mergedSummaries.threeLineSummary.whatItIs;
      threeLineSummary.watchOutFor = mergedSummaries.threeLineSummary.watchOutFor;
      threeLineSummary.howToVerify = mergedSummaries.threeLineSummary.howToVerify;
      const reorganizedByLatestSearch = mergedSummaries.reorganizedByLatestSearch;

      return sendSuccessResponse({
        contentTitle: resolvedTitle,
        analyzedVideoInfo,
        inputSummary: sanitizeInitialAnalysisText(parsed.inputSummary || ''),
        extractedImageText: parsed.extractedImageText || '',
        reliabilityScore,
        scoreBreakdown,
        aiSuspicion,
        factCheck,
        reorganizedByLatestSearch,
        usedFallbackModel,
        c2paMetadata: clientC2paMetadata,
        compressionSummary: clientCompressionSummary,
        overallStatus,
        overallSummary: finalOverallSummary,
        threeLineSummary,
        disclaimer:
          '이 점수와 분석은 사실일 확률이 아니라, 믿을 만한 콘텐츠가 갖추는 요소를 얼마나 갖췄는지 보여주는 참고 정보예요.',
        coreClaims,
        exaggeratedExpressions,
        sourceAssessment,
        aiGenerationAssessment,
        checklist,
        additionalVerificationSteps: Array.isArray(parsed.additionalVerificationSteps)
          ? parsed.additionalVerificationSteps.filter(Boolean)
          : [],
        platform,
        normalizedUrl,
      });
    } catch (err) {
      if (serverAbortController.signal.aborted || res.writableEnded) {
        return;
      }
      const classified = classifyAnalyzeError(err, { isYouTubeVideo: isYouTubeVideo || Boolean(uploadedFile) });
      if (classified.isAborted) {
        return;
      }
      console.error('[api/analyze] request failed:', {
        status: classified.status,
        rawStatus: extractErrorStatus(err) ?? null,
        message: err instanceof Error ? err.message : String(err),
      });
      return sendErrorResponse(classified.status, classified.error);
    } finally {
      res.off('close', handleClientClose);
      if (localUploadedFilePath) {
        await fs.promises.unlink(localUploadedFilePath).catch(() => undefined);
      }
      if (remoteGeminiFileName && aiClientForCleanup) {
        await aiClientForCleanup.files.delete({ name: remoteGeminiFileName }).catch(() => undefined);
      }
    }
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AI Content Checker server listening on http://localhost:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
