import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFactCheckVerdictsToSummaries,
  buildFactCheckReport,
  buildTodayDateInstruction,
  determineOverallFactCheckVerdict,
  extractGroundingWebSources,
  isSourceOlderThanOneYear,
  parseMultiClaimFactCheckResponse,
  sanitizeInitialAnalysisText,
  selectClaimsForFactCheck,
  utf8ByteOffsetToCharIndex,
} from './factCheck.ts';
import type { ClaimFactCheck, CoreClaim } from '../types/analysis.ts';

function makeClaim(
  idx: number,
  text: string,
  claimType: 'fact' | 'opinion' = 'fact'
): CoreClaim {
  return {
    id: `claim-${idx}`,
    claimType,
    claim: text,
    specificFiguresAndFacts: [],
    evidenceNeeds: '공식 자료 확인 필요',
  };
}

test('selectClaimsForFactCheck prioritizes fact claims over opinion claims up to 3', () => {
  const claims = [
    makeClaim(1, '디자인이 깔끔하고 예쁘다.', 'opinion'),
    makeClaim(2, '배터리 용량이 5,000mAh이다.', 'fact'),
    makeClaim(3, '사용감이 매우 부드럽다.', 'opinion'),
    makeClaim(4, '2026년 10월에 출시되었다.', 'fact'),
  ];
  const { toCheck, remaining } = selectClaimsForFactCheck(claims);
  assert.equal(toCheck.length, 3);
  assert.deepEqual(
    toCheck.map((c) => c.id),
    ['claim-2', 'claim-4', 'claim-1']
  );
  assert.deepEqual(
    remaining.map((c) => c.id),
    ['claim-3']
  );
});

test('extractGroundingWebSources keeps safe URLs, attaches dates, and flags >1 year old sources', () => {
  const now = new Date('2026-11-23T09:00:00Z');
  const sources = extractGroundingWebSources(
    [
      { web: { uri: 'https://www.kdca.go.kr/2026/info', title: '질병관리청 2026-10-01 안내' } },
      { web: { uri: 'https://www.kdca.go.kr/2026/info', title: '중복 링크' } },
      { web: { uri: 'javascript:alert(1)', title: '악성 링크' } },
      { web: { uri: 'https://www.example.com/2024/03/15/old', domain: 'example.com' } },
    ],
    5,
    ['2026-10-01', '2024-03-15'],
    now
  );

  assert.equal(sources.length, 2);
  assert.deepEqual(sources[0], {
    title: '질병관리청 2026-10-01 안내',
    url: 'https://www.kdca.go.kr/2026/info',
    publishedDate: '2026-10-01',
    isOutdated: false,
  });
  assert.deepEqual(sources[1], {
    title: 'example.com',
    url: 'https://www.example.com/2024/03/15/old',
    publishedDate: '2024-03-15',
    isOutdated: true,
  });
});

test('isSourceOlderThanOneYear identifies outdated vs recent dates cleanly', () => {
  const now = new Date('2026-11-23T09:00:00Z');
  assert.equal(isSourceOlderThanOneYear('2025-11-22', now), true);
  assert.equal(isSourceOlderThanOneYear('2025-11-23', now), false);
  assert.equal(isSourceOlderThanOneYear('2026-01-10', now), false);
  assert.equal(isSourceOlderThanOneYear('2024-05', now), true);
  assert.equal(isSourceOlderThanOneYear('2024', now), true);
  assert.equal(isSourceOlderThanOneYear('날짜 미상', now), false);
});

test('parseMultiClaimFactCheckResponse converts UTF-8 byte segment offsets accurately for 3 Korean claims', () => {
  const encoder = new TextEncoder();
  const claims = [
    makeClaim(1, '갤럭시 S26 울트라 배터리는 5,000mAh이다.', 'fact'),
    makeClaim(2, '해당 제품 가격은 200만 원이다.', 'fact'),
    makeClaim(3, '야간 사진 색감이 자연스럽고 선명하다.', 'opinion'),
  ];

  const responseText = [
    '[CLAIM 1]',
    '판정: 사실과 일치',
    '이유: 삼성전자 공식 사양표에서 5,000mAh 배터리가 확인되었습니다.',
    '출처날짜: 2026-02-15',
    '[/CLAIM 1]',
    '',
    '[CLAIM 2]',
    '판정: 사실과 다름',
    '이유: 공식 출고가는 169만 원대로 영상에서 말한 200만 원과 다릅니다.',
    '출처날짜: 2024-05-01',
    '[/CLAIM 2]',
    '',
    '[CLAIM 3]',
    '판정: 다른 리뷰·기사에도 비슷한 평가가 있음',
    '이유: 여러 IT 전문 매체 리뷰에서도 야간 화질 개선을 긍정적으로 평가했습니다.',
    '출처날짜: 2026-03-10',
    '[/CLAIM 3]',
  ].join('\n');

  const spanBytes = (needle: string) => {
    const charStart = responseText.indexOf(needle);
    assert.ok(charStart >= 0, `Missing needle: ${needle}`);
    const charEnd = charStart + needle.length;
    const startIndex = encoder.encode(responseText.slice(0, charStart)).length;
    const endIndex = encoder.encode(responseText.slice(0, charEnd)).length;
    // Confirm UTF-8 byte offsets differ substantially from JS char indices for Korean text
    assert.ok(startIndex > charStart);
    assert.equal(utf8ByteOffsetToCharIndex(responseText, startIndex), charStart);
    assert.equal(utf8ByteOffsetToCharIndex(responseText, endIndex), charEnd);
    return { startIndex, endIndex };
  };

  const s1 = spanBytes('삼성전자 공식 사양표에서 5,000mAh 배터리가 확인되었습니다.');
  const s2 = spanBytes('공식 출고가는 169만 원대로 영상에서 말한 200만 원과 다릅니다.');
  const s3 = spanBytes('여러 IT 전문 매체 리뷰에서도 야간 화질 개선을 긍정적으로 평가했습니다.');

  const parsed = parseMultiClaimFactCheckResponse(
    claims,
    responseText,
    {
      groundingChunks: [
        { web: { uri: 'https://www.samsung.com/sec/specs', title: '삼성전자 공식 사양' } },
        { web: { uri: 'https://news.example.kr/price', title: '출고가 보도' } },
        { web: { uri: 'https://review.example.kr/camera', title: '카메라 리뷰' } },
      ],
      groundingSupports: [
        { segment: s1, groundingChunkIndices: [0] },
        { segment: s2, groundingChunkIndices: [1] },
        { segment: s3, groundingChunkIndices: [2] },
      ],
      webSearchQueries: ['갤럭시 S26 울트라 사양 2026'],
    },
    new Date('2026-11-23T09:00:00Z')
  );

  assert.equal(parsed[0].verdict, '사실과 일치');
  assert.deepEqual(parsed[0].sources.map((s) => s.url), ['https://www.samsung.com/sec/specs']);
  assert.equal(parsed[0].sources[0].publishedDate, '2026-02-15');
  assert.equal(parsed[0].sources[0].isOutdated, false);

  assert.equal(parsed[1].verdict, '사실과 다름');
  assert.deepEqual(parsed[1].sources.map((s) => s.url), ['https://news.example.kr/price']);
  assert.equal(parsed[1].sources[0].publishedDate, '2024-05-01');
  assert.equal(parsed[1].sources[0].isOutdated, true);

  assert.equal(parsed[2].verdict, '다른 리뷰·기사에도 비슷한 평가가 있음');
  assert.deepEqual(parsed[2].sources.map((s) => s.url), ['https://review.example.kr/camera']);
  assert.equal(parsed[2].sources[0].isOutdated, false);
});

test('parseMultiClaimFactCheckResponse forces verdict to "확인 불가" whenever sources are missing', () => {
  const claims = [makeClaim(1, '미확인 주장', 'fact'), makeClaim(2, '미확인 의견', 'opinion')];
  const responseText = [
    '[CLAIM 1]',
    '판정: 사실과 일치',
    '이유: 확인된 자료 없음',
    '[/CLAIM 1]',
    '[CLAIM 2]',
    '판정: 다른 리뷰·기사에도 비슷한 평가가 있음',
    '이유: 관련 리뷰를 찾지 못함',
    '[/CLAIM 2]',
  ].join('\n');

  const parsed = parseMultiClaimFactCheckResponse(claims, responseText, {
    groundingChunks: [],
    groundingSupports: [{ segment: { startIndex: 0, endIndex: 10 }, groundingChunkIndices: [] }],
  });

  assert.equal(parsed[0].status, 'not_found');
  assert.equal(parsed[0].verdict, '확인 불가');
  assert.equal(parsed[1].status, 'not_found');
  assert.equal(parsed[1].verdict, '확인 불가');
});

test('determineOverallFactCheckVerdict applies deterministic rules cleanly', () => {
  const mkItem = (
    claimType: 'fact' | 'opinion',
    verdict: ClaimFactCheck['verdict'],
    status: ClaimFactCheck['status'] = 'sources_found'
  ): ClaimFactCheck => ({
    claimId: 'c1',
    claim: '테스트 주장',
    claimType,
    status,
    verdict,
    summary: '이유',
    sources: [],
    searchQueries: [],
  });

  // Any '사실과 다름' -> '사실과 다른 내용이 있어요'
  assert.equal(
    determineOverallFactCheckVerdict([
      mkItem('fact', '사실과 일치'),
      mkItem('fact', '사실과 다름'),
    ]),
    '사실과 다른 내용이 있어요'
  );

  // All fact claims '사실과 일치' (even with an opinion claim) -> '확인된 자료와 일치해요'
  assert.equal(
    determineOverallFactCheckVerdict([
      mkItem('fact', '사실과 일치'),
      mkItem('opinion', '비슷한 평가를 찾지 못함'),
    ]),
    '확인된 자료와 일치해요'
  );

  // Any unverified fact claim or search error or zero fact claims -> '일부 내용은 확인되지 않았어요'
  assert.equal(
    determineOverallFactCheckVerdict([
      mkItem('fact', '사실과 일치'),
      mkItem('fact', '확인 불가', 'not_found'),
    ]),
    '일부 내용은 확인되지 않았어요'
  );
  assert.equal(
    determineOverallFactCheckVerdict([
      mkItem('fact', '확인 불가', 'search_error'),
    ]),
    '일부 내용은 확인되지 않았어요'
  );
  assert.equal(
    determineOverallFactCheckVerdict([mkItem('opinion', '다른 리뷰·기사에도 비슷한 평가가 있음')]),
    '일부 내용은 확인되지 않았어요'
  );
});

test('buildFactCheckReport counts verified, notFound, searchError, and overallVerdict', () => {
  const report = buildFactCheckReport(
    [
      {
        claimId: 'c1',
        claim: '주장 1',
        claimType: 'fact',
        status: 'sources_found',
        verdict: '사실과 일치',
        summary: '공식 통계에서 일치하는 수치가 확인되었습니다.',
        sources: [{ title: '통계청', url: 'https://kostat.go.kr', publishedDate: '2026-05-01', isOutdated: false }],
        searchQueries: ['주장 1 통계 2026'],
      },
      {
        claimId: 'c2',
        claim: '주장 2',
        claimType: 'fact',
        status: 'search_error',
        verdict: '확인 불가',
        summary: '검색 중 오류가 났어요',
        sources: [],
        searchQueries: [],
      },
    ],
    [makeClaim(4, '추가 주장')]
  );

  assert.equal(report.checkedCount, 2);
  assert.equal(report.verifiedCount, 1);
  assert.equal(report.notFoundCount, 0);
  assert.equal(report.searchErrorCount, 1);
  assert.equal(report.overallVerdict, '일부 내용은 확인되지 않았어요');
  assert.equal(report.uncheckedClaims.length, 1);
});

test('buildTodayDateInstruction includes current date and product/event/person memory warning', () => {
  const instruction = buildTodayDateInstruction(new Date('2026-11-23T09:00:00Z'));
  assert.match(instruction, /2026년 11월 23일/);
  assert.match(
    instruction,
    /너의 지식은 오래됐을 수 있으니 최근 사건·제품·인물의 현재 상황을 기억으로 판단하지 마/
  );
});

test('sanitizeInitialAnalysisText strips premature falsehood phrases from Call A', () => {
  const cleaned = sanitizeInitialAnalysisText(
    '이 영상은 잘못된 정보를 말하고 있으며 현재 사실이 아닙니다.'
  );
  assert.ok(!cleaned.includes('잘못된 정보'));
  assert.ok(!cleaned.includes('사실이 아닙니다'));
});

test('applyFactCheckVerdictsToSummaries appends search verdicts to overallSummary and watchOutFor without LLM call', () => {
  const factCheck = buildFactCheckReport(
    [
      {
        claimId: 'c1',
        claim: '에펠탑 높이는 100미터이다.',
        claimType: 'fact',
        status: 'sources_found',
        verdict: '사실과 다름',
        summary: '에펠탑 실제 높이는 약 330미터입니다.',
        sources: [
          {
            title: '에펠탑 공식 안내',
            url: 'https://www.toureiffel.paris/en',
            publishedDate: '2024-01-10',
            isOutdated: true,
          },
        ],
        searchQueries: ['에펠탑 높이'],
      },
    ],
    []
  );

  const merged = applyFactCheckVerdictsToSummaries({
    overallSummary: '1차 요약 설명입니다.',
    threeLineSummary: {
      whatItIs: '파리 건축물 소개 영상이에요.',
      watchOutFor: '수치 출처가 영상에 적혀 있지 않아요.',
      howToVerify: '공식 사이트를 확인해 보세요.',
    },
    factCheck,
  });

  assert.equal(merged.reorganizedByLatestSearch, true);
  assert.match(merged.overallSummary, /사실과 다른 내용이 있어요/);
  assert.match(merged.overallSummary, /약 330미터/);
  assert.match(merged.threeLineSummary.watchOutFor, /실제 자료와 달라 주의가 필요해요/);
  assert.match(merged.threeLineSummary.watchOutFor, /1년이 넘은 오래된 자료/);
});

test('applyFactCheckVerdictsToSummaries skips modification when all search items errored', () => {
  const factCheck = buildFactCheckReport(
    [
      {
        claimId: 'c1',
        claim: '테스트 주장',
        claimType: 'fact',
        status: 'search_error',
        verdict: '확인 불가',
        summary: '검색 중 오류가 났어요',
        sources: [],
        searchQueries: [],
      },
    ],
    []
  );

  const merged = applyFactCheckVerdictsToSummaries({
    overallSummary: '기존 요약',
    threeLineSummary: {
      whatItIs: '영상 소개',
      watchOutFor: '기존 주의점',
      howToVerify: '확인 방법',
    },
    factCheck,
  });

  assert.equal(merged.reorganizedByLatestSearch, false);
  assert.equal(merged.overallSummary, '기존 요약');
  assert.equal(merged.threeLineSummary.watchOutFor, '기존 주의점');
});
