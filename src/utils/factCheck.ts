import type {
  ClaimFactCheck,
  ClaimFactCheckVerdict,
  ClaimType,
  CoreClaim,
  FactCheckReport,
  FactCheckSource,
  FactCheckStatus,
  FactClaimVerdict,
  OpinionClaimVerdict,
  OverallFactCheckVerdict,
  ThreeLineSummary,
} from '../types/analysis.ts';

export const MAX_FACT_CHECK_CLAIMS = 3;

export function buildTodayDateInstruction(now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return `오늘 날짜는 ${year}년 ${month}월 ${day}일(${iso})입니다. 너의 지식은 오래됐을 수 있으니 최근 사건·제품·인물의 현재 상황을 기억으로 판단하지 마.`;
}

const CALL_A_FORBIDDEN_PHRASES: Array<[RegExp, string]> = [
  [/명백한\s*잘못된\s*정보(?:입니다|이에요)?/g, '추가 확인이 필요한 정보'],
  [/잘못된\s*정보(?:입니다|이에요)?/g, '사실 확인이 필요한 주장'],
  [/명백한\s*허위\s*사실(?:입니다|이에요)?/g, '사실 확인이 필요한 주장'],
  [/허위\s*사실(?:입니다|이에요)?/g, '확인이 필요한 주장'],
  [/사실이\s*아닙니다/g, '공식 자료로 확인이 필요합니다'],
  [/사실이\s*아니에요/g, '공식 자료로 확인이 필요해요'],
  [/사실이\s*아닌/g, '확인되지 않은'],
  [/사실이\s*아님/g, '확인 필요'],
  [/거짓\s*정보(?:입니다|이에요)?/g, '확인이 필요한 주장'],
];

export function sanitizeInitialAnalysisText(rawText: string): string {
  if (!rawText || typeof rawText !== 'string') return '';
  let result = rawText;
  for (const [pattern, replacement] of CALL_A_FORBIDDEN_PHRASES) {
    result = result.replace(pattern, replacement);
  }
  return result.replace(/\s+/g, ' ').trim();
}

export function selectClaimsForFactCheck(coreClaims: CoreClaim[]): {
  toCheck: CoreClaim[];
  remaining: CoreClaim[];
} {
  const validClaims = coreClaims.filter((c) => Boolean(c?.claim?.trim()));
  const factClaims = validClaims.filter((c) => c.claimType !== 'opinion');
  const opinionClaims = validClaims.filter((c) => c.claimType === 'opinion');
  const prioritized = [...factClaims, ...opinionClaims];

  return {
    toCheck: prioritized.slice(0, MAX_FACT_CHECK_CLAIMS),
    remaining: prioritized.slice(MAX_FACT_CHECK_CLAIMS),
  };
}

export function isSafeHttpUrl(rawUrl?: string): boolean {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  try {
    const parsed = new URL(rawUrl.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function utf8ByteOffsetToCharIndex(text: string, byteOffset: number): number {
  if (!text || byteOffset <= 0) return 0;

  let accumulatedBytes = 0;
  let charIndex = 0;

  while (charIndex < text.length) {
    if (accumulatedBytes >= byteOffset) {
      return charIndex;
    }

    const codePoint = text.codePointAt(charIndex);
    if (codePoint === undefined) break;

    let cpBytes = 1;
    if (codePoint <= 0x7f) {
      cpBytes = 1;
    } else if (codePoint <= 0x7ff) {
      cpBytes = 2;
    } else if (codePoint <= 0xffff) {
      cpBytes = 3;
    } else {
      cpBytes = 4;
    }

    const charStep = codePoint > 0xffff ? 2 : 1;
    if (accumulatedBytes + cpBytes > byteOffset) {
      return charIndex;
    }

    accumulatedBytes += cpBytes;
    charIndex += charStep;
  }

  return text.length;
}

export function utf8ByteRangeToCharRange(
  text: string,
  byteStart: number,
  byteEnd: number
): { start: number; end: number } {
  const start = utf8ByteOffsetToCharIndex(text, Math.max(0, byteStart));
  const end = utf8ByteOffsetToCharIndex(text, Math.max(byteStart, byteEnd));
  return { start, end: Math.max(start, end) };
}

export function normalizePublishedDate(raw?: string): string | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const text = raw.trim();
  if (!text || /날짜\s*미상|미상|알\s*수\s*없|unknown/i.test(text)) {
    return undefined;
  }

  const fullIsoMatch = text.match(/((?:19|20)\d{2})[-./](\d{1,2})[-./](\d{1,2})/);
  if (fullIsoMatch) {
    const y = Number(fullIsoMatch[1]);
    const m = Number(fullIsoMatch[2]);
    const d = Number(fullIsoMatch[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  const krFullMatch = text.match(/((?:19|20)\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일/);
  if (krFullMatch) {
    const y = Number(krFullMatch[1]);
    const m = Number(krFullMatch[2]);
    const d = Number(krFullMatch[3]);
    if (m >= 1 && m <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    }
  }

  const compactYmdMatch = text.match(/(?:^|[^\d])((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:[^\d]|$)/);
  if (compactYmdMatch) {
    return `${compactYmdMatch[1]}-${compactYmdMatch[2]}-${compactYmdMatch[3]}`;
  }

  const ymMatch = text.match(/((?:19|20)\d{2})[-./](\d{1,2})(?!\d)/);
  if (ymMatch) {
    const y = Number(ymMatch[1]);
    const m = Number(ymMatch[2]);
    if (m >= 1 && m <= 12) {
      return `${y}-${String(m).padStart(2, '0')}`;
    }
  }

  const krYmMatch = text.match(/((?:19|20)\d{2})\s*년\s*(\d{1,2})\s*월/);
  if (krYmMatch) {
    const y = Number(krYmMatch[1]);
    const m = Number(krYmMatch[2]);
    if (m >= 1 && m <= 12) {
      return `${y}-${String(m).padStart(2, '0')}`;
    }
  }

  const yearMatch = text.match(/\b((?:19|20)\d{2})\b/);
  if (yearMatch) {
    return yearMatch[1];
  }

  return undefined;
}

export function extractDateFromTextOrUrl(title?: string, url?: string): string | undefined {
  return normalizePublishedDate(title) ?? normalizePublishedDate(url);
}

export function isSourceOlderThanOneYear(
  publishedDate?: string,
  now: Date = new Date()
): boolean {
  const normalized = normalizePublishedDate(publishedDate);
  if (!normalized) return false;

  const oneYearAgoMs = Date.UTC(now.getFullYear() - 1, now.getMonth(), now.getDate());
  const ymd = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (ymd) {
    const srcMs = Date.UTC(Number(ymd[1]), Number(ymd[2]) - 1, Number(ymd[3]));
    return srcMs < oneYearAgoMs;
  }

  const ym = normalized.match(/^(\d{4})-(\d{2})$/);
  if (ym) {
    const y = Number(ym[1]);
    const m = Number(ym[2]);
    return y < now.getFullYear() - 1 || (y === now.getFullYear() - 1 && m < now.getMonth() + 1);
  }

  const yOnly = normalized.match(/^(\d{4})$/);
  if (yOnly) {
    return Number(yOnly[1]) < now.getFullYear() - 1;
  }

  return false;
}

export function extractGroundingWebSources(
  groundingChunks?: Array<{
    web?: {
      uri?: string;
      title?: string;
      domain?: string;
    };
  }>,
  maxSources = 5,
  sourceDates: Array<string | undefined> = [],
  now: Date = new Date()
): FactCheckSource[] {
  if (!Array.isArray(groundingChunks)) return [];

  const seenUrls = new Set<string>();
  const sources: FactCheckSource[] = [];

  for (const chunk of groundingChunks) {
    const rawUri = chunk?.web?.uri?.trim();
    if (!rawUri || !isSafeHttpUrl(rawUri) || seenUrls.has(rawUri)) {
      continue;
    }

    let fallbackTitle = chunk?.web?.domain?.trim() || '';
    if (!fallbackTitle) {
      try {
        fallbackTitle = new URL(rawUri).hostname.replace(/^www\./, '');
      } catch {
        fallbackTitle = '참고 출처';
      }
    }

    const title = chunk?.web?.title?.trim() || fallbackTitle;
    const explicitDate = normalizePublishedDate(sourceDates[sources.length]);
    const inferredDate = explicitDate ?? extractDateFromTextOrUrl(title, rawUri);
    const publishedDate = inferredDate ?? '날짜 미상';
    const isOutdated = inferredDate ? isSourceOlderThanOneYear(inferredDate, now) : false;

    seenUrls.add(rawUri);
    sources.push({
      title,
      url: rawUri,
      publishedDate,
      isOutdated,
    });

    if (sources.length >= maxSources) {
      break;
    }
  }

  return sources;
}

const NOT_FOUND_PATTERNS = [
  /^확인된\s*자료\s*없음[.!]?$/i,
  /확인된\s*자료(?:가|를)?\s*없(?:음|습니다|어요)/i,
  /검색된\s*자료(?:가|를)?\s*(?:찾을\s*수\s*없|없습니다|없어요)/i,
  /관련\s*(?:공식\s*)?자료를?\s*찾지\s*못/i,
  /근거\s*자료를?\s*찾을\s*수\s*없/i,
];

const ABSOLUTE_VERDICT_REPLACEMENTS: Array<[RegExp, string]> = [
  [/100%\s*사실입니다/g, '관련 자료에서 언급된 내용입니다'],
  [/무조건\s*사실(?:입니다|이에요)/g, '자료에 나타난 내용입니다'],
  [/완전한\s*거짓(?:입니다|이에요)/g, '자료의 내용과 다른 부분이 있습니다'],
  [/명백한\s*허위(?:입니다|이에요)/g, '확인된 자료의 수치·사실과 차이가 있습니다'],
  [/사실로\s*판명(?:되었습니다|됐습니다|됨)/g, '관련 자료에서 비슷한 내용이 확인됩니다'],
  [/거짓으로\s*판명(?:되었습니다|됐습니다|됨)/g, '검색된 자료와는 다른 내용이 확인됩니다'],
  [/따라서\s*(?:이\s*주장은\s*)?(?:참|사실)(?:입니다|이에요)[.]?/g, ''],
  [/따라서\s*(?:이\s*주장은\s*)?(?:거짓|허위)(?:입니다|이에요)[.]?/g, ''],
  [/결론적으로\s*(?:참|사실|거짓|허위)(?:입니다|이에요)[.]?/g, ''],
];

export function sanitizeNonJudgmentalFactSummary(
  rawText: string,
  hasSources: boolean
): { status: FactCheckStatus; summary: string } {
  const cleaned = rawText
    .replace(/\*\*/g, '')
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!hasSources || !cleaned || NOT_FOUND_PATTERNS.some((pat) => pat.test(cleaned))) {
    return {
      status: 'not_found',
      summary: '확인된 자료 없음',
    };
  }

  let normalized = cleaned;
  for (const [pattern, replacement] of ABSOLUTE_VERDICT_REPLACEMENTS) {
    normalized = normalized.replace(pattern, replacement);
  }
  normalized = normalized.replace(/\s+/g, ' ').trim();

  if (!normalized || NOT_FOUND_PATTERNS.some((pat) => pat.test(normalized))) {
    return {
      status: 'not_found',
      summary: '확인된 자료 없음',
    };
  }

  if (!normalized.startsWith('검색된 자료에 따르면')) {
    normalized = normalized.replace(/^검색\s*결과(?:에\s*따르면)?[,:]?\s*/i, '');
    normalized = `검색된 자료에 따르면 ${normalized}`;
  }

  return {
    status: 'sources_found',
    summary: normalized,
  };
}

function normalizeFactVerdict(raw?: string): FactClaimVerdict {
  const text = (raw || '').replace(/\s+/g, ' ').trim();
  if (/사실과\s*다름|일치하지\s*않|틀림|다릅니다/.test(text)) {
    return '사실과 다름';
  }
  if (/사실과\s*일치|일치함|맞습니다/.test(text)) {
    return '사실과 일치';
  }
  return '확인 불가';
}

function normalizeOpinionVerdict(raw?: string): OpinionClaimVerdict {
  const text = (raw || '').replace(/\s+/g, ' ').trim();
  if (/비슷한\s*평가를\s*찾지\s*못함|찾지\s*못|엇갈|상반/.test(text)) {
    return '비슷한 평가를 찾지 못함';
  }
  if (/다른\s*리뷰|비슷한\s*평가가\s*있음|비슷한\s*의견/.test(text)) {
    return '다른 리뷰·기사에도 비슷한 평가가 있음';
  }
  return '확인 불가';
}

function parseSourceDateList(rawDateLine?: string): Array<string | undefined> {
  if (!rawDateLine) return [];
  const parts = rawDateLine
    .split(/[|,\n]/)
    .map((part) => part.replace(/^출처\s*\d*\s*[:：-]?\s*/i, '').trim())
    .filter(Boolean);
  return parts.map((part) => normalizePublishedDate(part));
}

function parseStructuredClaimBlock(
  blockText: string,
  claimType: ClaimType,
  hasSources: boolean
): {
  status: FactCheckStatus;
  verdict: ClaimFactCheckVerdict;
  summary: string;
  sourceDates: Array<string | undefined>;
} {
  const cleanedRaw = blockText
    .replace(/\*\*/g, '')
    .replace(/^#+\s*/gm, '')
    .trim();

  const verdictMatch = cleanedRaw.match(/(?:^|\n)\s*판정\s*[:：]\s*(.+)/);
  const reasonMatch = cleanedRaw.match(/(?:^|\n)\s*이유\s*[:：]\s*(.+)/);
  const dateMatch = cleanedRaw.match(/(?:^|\n)\s*출처날짜\s*[:：]\s*(.+)/);

  const rawVerdict = verdictMatch?.[1]?.trim() || '';
  const rawReason = (reasonMatch?.[1] || cleanedRaw)
    .replace(/(?:^|\n)\s*(?:판정|출처날짜|유형)\s*[:：].*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sourceDates = parseSourceDateList(dateMatch?.[1]);

  if (!hasSources || !cleanedRaw || NOT_FOUND_PATTERNS.some((pat) => pat.test(rawReason))) {
    return {
      status: 'not_found',
      verdict: '확인 불가',
      summary: '확인된 자료 없음',
      sourceDates: [],
    };
  }

  const verdict: ClaimFactCheckVerdict =
    claimType === 'opinion'
      ? normalizeOpinionVerdict(rawVerdict || rawReason)
      : normalizeFactVerdict(rawVerdict || rawReason);

  const summary = rawReason || '검색된 출처 내용을 확인해 주세요.';
  return {
    status: 'sources_found',
    verdict,
    summary,
    sourceDates,
  };
}

export function determineOverallFactCheckVerdict(
  items: ClaimFactCheck[]
): OverallFactCheckVerdict {
  if (items.some((item) => item.verdict === '사실과 다름')) {
    return '사실과 다른 내용이 있어요';
  }

  const factItems = items.filter((item) => item.claimType !== 'opinion');
  if (
    factItems.length > 0 &&
    factItems.every(
      (item) => item.status === 'sources_found' && item.verdict === '사실과 일치'
    )
  ) {
    return '확인된 자료와 일치해요';
  }

  return '일부 내용은 확인되지 않았어요';
}

export function buildFactCheckReport(
  checkedItems: ClaimFactCheck[],
  remainingClaims: CoreClaim[]
): FactCheckReport {
  const verifiedCount = checkedItems.filter((item) => item.status === 'sources_found').length;
  const notFoundCount = checkedItems.filter((item) => item.status === 'not_found').length;
  const searchErrorCount = checkedItems.filter((item) => item.status === 'search_error').length;
  const overallVerdict = determineOverallFactCheckVerdict(checkedItems);

  return {
    checkedCount: checkedItems.length,
    verifiedCount,
    notFoundCount,
    searchErrorCount,
    overallVerdict,
    items: checkedItems,
    uncheckedClaims: remainingClaims,
  };
}

export interface GroundingMetadataInput {
  groundingChunks?: Array<{
    web?: {
      uri?: string;
      title?: string;
      domain?: string;
    };
  }>;
  groundingSupports?: Array<{
    groundingChunkIndices?: number[];
    segment?: {
      startIndex?: number;
      endIndex?: number;
      text?: string;
    };
  }>;
  webSearchQueries?: string[];
}

export function parseMultiClaimFactCheckResponse(
  claims: CoreClaim[],
  responseText: string,
  groundingMeta?: GroundingMetadataInput,
  now: Date = new Date()
): ClaimFactCheck[] {
  const allChunks = Array.isArray(groundingMeta?.groundingChunks)
    ? groundingMeta.groundingChunks
    : [];
  const supports = Array.isArray(groundingMeta?.groundingSupports)
    ? groundingMeta.groundingSupports
    : [];
  const allSearchQueries = Array.isArray(groundingMeta?.webSearchQueries)
    ? groundingMeta.webSearchQueries.filter((q): q is string => Boolean(q?.trim()))
    : [];

  const text = responseText || '';

  return claims.map((claimItem, idx) => {
    const num = idx + 1;
    const claimType: ClaimType = claimItem.claimType === 'opinion' ? 'opinion' : 'fact';
    const tagRegex = new RegExp(
      `\\[CLAIM\\s*${num}\\]([\\s\\S]*?)\\[\\/CLAIM\\s*${num}\\]`,
      'i'
    );
    const match = tagRegex.exec(text);

    let blockText = '';
    let blockStart = -1;
    let blockEnd = -1;

    if (match) {
      blockText = (match[1] || '').trim();
      blockStart = match.index;
      blockEnd = match.index + match[0].length;
    } else if (claims.length === 1 && text.trim()) {
      blockText = text.trim();
      blockStart = 0;
      blockEnd = text.length;
    }

    // Match groundingChunks attributed to this claim's text span via groundingSupports.
    // Gemini returns segment.startIndex/endIndex in UTF-8 bytes; convert them to JS UTF-16 char indices.
    let matchedIndices: number[] = [];
    if (blockStart >= 0 && supports.length > 0) {
      const indexSet = new Set<number>();
      for (const support of supports) {
        const segStartBytes = support?.segment?.startIndex;
        const segEndBytes = support?.segment?.endIndex;
        const segText = support?.segment?.text?.trim();

        let overlapsBySpan = false;
        if (typeof segStartBytes === 'number' && typeof segEndBytes === 'number') {
          const { start: charStart, end: charEnd } = utf8ByteRangeToCharRange(
            text,
            segStartBytes,
            segEndBytes
          );
          overlapsBySpan = charEnd > blockStart && charStart < blockEnd;
        }
        const overlapsByText = Boolean(segText && blockText.includes(segText));

        if ((overlapsBySpan || overlapsByText) && Array.isArray(support.groundingChunkIndices)) {
          for (const chunkIdx of support.groundingChunkIndices) {
            if (typeof chunkIdx === 'number' && chunkIdx >= 0 && chunkIdx < allChunks.length) {
              indexSet.add(chunkIdx);
            }
          }
        }
      }
      matchedIndices = Array.from(indexSet);
    }

    const scopedChunks =
      matchedIndices.length > 0
        ? matchedIndices.map((chunkIdx) => allChunks[chunkIdx])
        : supports.length === 0
          ? allChunks
          : [];

    const preliminaryParsed = parseStructuredClaimBlock(blockText, claimType, scopedChunks.length > 0);
    const sources = extractGroundingWebSources(
      scopedChunks,
      5,
      preliminaryParsed.sourceDates,
      now
    );

    const { status, verdict, summary } = parseStructuredClaimBlock(
      blockText,
      claimType,
      sources.length > 0
    );

    return {
      claimId: claimItem.id,
      claim: claimItem.claim,
      claimType,
      status,
      verdict,
      summary,
      sources: status === 'sources_found' ? sources : [],
      searchQueries: allSearchQueries,
    };
  });
}

function truncateClaimSnippet(claim: string, maxLen = 48): string {
  const cleaned = claim.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return `${cleaned.slice(0, maxLen).trimEnd()}…`;
}

export function applyFactCheckVerdictsToSummaries(params: {
  overallSummary: string;
  threeLineSummary: ThreeLineSummary;
  factCheck: FactCheckReport;
}): {
  overallSummary: string;
  threeLineSummary: ThreeLineSummary;
  reorganizedByLatestSearch: boolean;
} {
  const { factCheck } = params;
  const items = factCheck.items ?? [];
  const baseSummary = params.overallSummary.trim();
  const baseThreeLine: ThreeLineSummary = { ...params.threeLineSummary };

  if (items.length === 0 || (factCheck.searchErrorCount ?? 0) >= items.length) {
    return {
      overallSummary: baseSummary,
      threeLineSummary: baseThreeLine,
      reorganizedByLatestSearch: false,
    };
  }

  const overallVerdict = factCheck.overallVerdict ?? determineOverallFactCheckVerdict(items);
  const contradicted = items.filter((item) => item.verdict === '사실과 다름');
  const matchedFacts = items.filter(
    (item) => item.claimType !== 'opinion' && item.verdict === '사실과 일치'
  );
  const unverified = items.filter(
    (item) => item.status === 'not_found' || item.verdict === '확인 불가'
  );
  const hasOutdatedSource = items.some((item) =>
    item.sources.some((source) => Boolean(source.isOutdated))
  );

  const verdictDetails: string[] = [`[Google 검색 판정] ${overallVerdict}.`];
  if (contradicted.length > 0) {
    const first = contradicted[0];
    verdictDetails.push(
      `검색 자료와 다른 주장(${contradicted.length}건): "${truncateClaimSnippet(first.claim)}" — ${first.summary}`
    );
  }
  if (matchedFacts.length > 0) {
    verdictDetails.push(`사실과 일치하는 주장 ${matchedFacts.length}건이 검색으로 확인되었습니다.`);
  }
  if (unverified.length > 0) {
    verdictDetails.push(`확인 불가 주장 ${unverified.length}건은 추가 확인이 필요합니다.`);
  }
  if (hasOutdatedSource) {
    verdictDetails.push('1년이 지난 오래된 출처가 포함되어 있어 최신 자료를 함께 확인하세요.');
  }

  const combinedOverallSummary = [baseSummary, verdictDetails.join(' ')].filter(Boolean).join(' ');

  const watchNotes: string[] = [];
  if (contradicted.length > 0) {
    watchNotes.push(
      `Google 검색 결과 "${truncateClaimSnippet(contradicted[0].claim)}" 주장이 실제 자료와 달라 주의가 필요해요.`
    );
  } else if (unverified.length > 0) {
    watchNotes.push('검색으로 확인되지 않은 주장이 있어 공식 자료로 한 번 더 확인해 보세요.');
  } else if (matchedFacts.length > 0) {
    watchNotes.push('검색으로 확인한 핵심 사실 주장은 최신 자료와 일치했어요.');
  }
  if (hasOutdatedSource) {
    watchNotes.push('1년이 넘은 오래된 자료가 포함되어 있어 최신 발표도 살펴보세요.');
  }

  const updatedWatchOutFor = [baseThreeLine.watchOutFor.trim(), ...watchNotes]
    .filter(Boolean)
    .join(' ');

  return {
    overallSummary: combinedOverallSummary,
    threeLineSummary: {
      ...baseThreeLine,
      watchOutFor: updatedWatchOutFor,
    },
    reorganizedByLatestSearch: factCheck.verifiedCount > 0 || contradicted.length > 0,
  };
}
