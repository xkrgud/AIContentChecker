import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDefaultChecklist,
  buildSearchUrl,
  calculateChecklistProgress,
  calculateReliabilityScore,
  determineOverallStatusFromScore,
  getAiGenerationScore,
  getChecklistItemScore,
  getChecklistVerdictMeta,
  getExaggerationCountScore,
  getOverallStatusMeta,
} from './analysisHelpers';
import type { ChecklistItem } from '../types/analysis';

function makeFiveCoreItems(verdicts: Array<'예' | '확인 필요' | '아니오'>): ChecklistItem[] {
  return verdicts.map((aiVerdict, idx) => ({
    id: `chk-${idx + 1}`,
    question: `항목 ${idx + 1}`,
    category: '기본 검증',
    hint: '',
    aiVerdict,
    aiReason: '',
    checked: aiVerdict === '예',
  }));
}

test('scoring rule helpers compute exact points for checklist, exaggerations, and AI likelihood', () => {
  assert.equal(getChecklistItemScore('예'), 15);
  assert.equal(getChecklistItemScore('확인 필요'), 8);
  assert.equal(getChecklistItemScore('아니오'), 0);

  assert.equal(getExaggerationCountScore(0), 15);
  assert.equal(getExaggerationCountScore(1), 8);
  assert.equal(getExaggerationCountScore(2), 8);
  assert.equal(getExaggerationCountScore(3), 0);
  assert.equal(getExaggerationCountScore(7), 0);

  assert.equal(getAiGenerationScore('가능성 낮음'), 10);
  assert.equal(getAiGenerationScore('판별 불확실'), 5);
  assert.equal(getAiGenerationScore('일부 AI 활용 가능성'), 5);
  assert.equal(getAiGenerationScore('AI 생성·합성 의심 요소 발견'), 0);
});

test('calculateReliabilityScore sums max 100 points and ignores extra claim-specific items', () => {
  const coreItems = makeFiveCoreItems(['예', '예', '예', '예', '예']);
  const extraClaimItem: ChecklistItem = {
    id: 'chk-claim-1',
    question: '추가 주장',
    category: '주장별 검증',
    hint: '',
    aiVerdict: '아니오',
    aiReason: '',
    checked: false,
  };

  const perfect = calculateReliabilityScore({
    checklist: [...coreItems, extraClaimItem],
    exaggeratedCount: 0,
    aiLikelihoodLevel: '가능성 낮음',
  });

  assert.equal(perfect.checklistScore, 75);
  assert.equal(perfect.exaggerationScore, 15);
  assert.equal(perfect.aiGenerationScore, 10);
  assert.equal(perfect.totalScore, 100);
  assert.equal(perfect.checklistItemsBreakdown.length, 5);
});

test('calculateReliabilityScore computes mixed and zero-score scenarios accurately', () => {
  // 2*15 + 2*8 + 1*0 = 46 (checklist) + 8 (2 exaggerations) + 5 (판별 불확실) = 59
  const mixed = calculateReliabilityScore({
    checklist: makeFiveCoreItems(['예', '예', '확인 필요', '확인 필요', '아니오']),
    exaggeratedCount: 2,
    aiLikelihoodLevel: '판별 불확실',
  });
  assert.equal(mixed.checklistScore, 46);
  assert.equal(mixed.exaggerationScore, 8);
  assert.equal(mixed.aiGenerationScore, 5);
  assert.equal(mixed.totalScore, 59);

  const lowest = calculateReliabilityScore({
    checklist: makeFiveCoreItems(['아니오', '아니오', '아니오', '아니오', '아니오']),
    exaggeratedCount: 4,
    aiLikelihoodLevel: 'AI 생성·합성 의심 요소 발견',
  });
  assert.equal(lowest.totalScore, 0);

  // Boundary: negative exaggeration count clamps to 0 -> 15 points; 3 예 (45) + 2 아니오 (0) + 15 + 10 = 70 (low_risk_observed)
  const boundary70 = calculateReliabilityScore({
    checklist: makeFiveCoreItems(['예', '예', '예', '아니오', '아니오']),
    exaggeratedCount: -2,
    aiLikelihoodLevel: '가능성 낮음',
  });
  assert.equal(boundary70.exaggerationCount, 0);
  assert.equal(boundary70.totalScore, 70);
  assert.equal(determineOverallStatusFromScore(boundary70.totalScore), 'low_risk_observed');
});

test('determineOverallStatusFromScore maps score thresholds strictly', () => {
  assert.equal(determineOverallStatusFromScore(100), 'low_risk_observed');
  assert.equal(determineOverallStatusFromScore(70), 'low_risk_observed');
  assert.equal(determineOverallStatusFromScore(69), 'caution_found');
  assert.equal(determineOverallStatusFromScore(40), 'caution_found');
  assert.equal(determineOverallStatusFromScore(39), 'needs_verification');
  assert.equal(determineOverallStatusFromScore(0), 'needs_verification');
});

test('getOverallStatusMeta and getChecklistVerdictMeta return Korean labels', () => {
  assert.equal(getOverallStatusMeta('needs_verification').label, '추가 검증 필요');
  assert.equal(getOverallStatusMeta('caution_found').label, '주의할 요소 발견');
  assert.equal(getOverallStatusMeta('low_risk_observed').label, '확인할 만한 위험 요소가 적음');

  assert.equal(getChecklistVerdictMeta('예').label, 'AI 판정: 충족 (예)');
  assert.equal(getChecklistVerdictMeta('아니오').label, 'AI 판정: 미충족 (아니오)');
  assert.equal(getChecklistVerdictMeta('확인 필요').label, 'AI 판정: 확인 필요');
});

test('buildDefaultChecklist includes 5 core items plus up to 2 claim-specific items', () => {
  const items = buildDefaultChecklist([
    {
      id: 'c1',
      claim: '하루 한 알로 혈관 나이가 20년 젊어진다',
      specificFiguresAndFacts: ['20년'],
      evidenceNeeds: '임상시험 원문 확인 필요',
    },
    {
      id: 'c2',
      claim: '국내 대학병원 연구진 100% 인증',
      specificFiguresAndFacts: ['100%'],
      evidenceNeeds: '공식 인증 기관 여부 확인',
    },
    {
      id: 'c3',
      claim: '세 번째 주장은 동적 체크리스트 상한을 넘김',
      specificFiguresAndFacts: [],
      evidenceNeeds: '확인 필요',
    },
  ]);

  assert.equal(items.length, 7);
  assert.equal(items[5].category, '주장별 검증');
  assert.equal(items[6].category, '주장별 검증');
});

test('calculateChecklistProgress counts AI verdicts and checked progress accurately', () => {
  const empty = calculateChecklistProgress([]);
  assert.deepEqual(empty, {
    total: 0,
    passed: 0,
    failed: 0,
    needsCheck: 0,
    checked: 0,
    percentage: 0,
  });

  const items = buildDefaultChecklist([]);
  items[0].aiVerdict = '예';
  items[0].checked = true;
  items[1].aiVerdict = '아니오';
  items[1].checked = true;
  const progress = calculateChecklistProgress(items);
  assert.deepEqual(progress, {
    total: 5,
    passed: 1,
    failed: 1,
    needsCheck: 3,
    checked: 2,
    percentage: 40,
  });
});

test('buildSearchUrl encodes Korean search queries properly', () => {
  const url = buildSearchUrl('식약처 건강기능식품 허위과대광고 조회');
  assert.equal(
    url,
    'https://www.google.com/search?q=%EC%8B%9D%EC%95%BD%EC%B2%98%20%EA%B1%B4%EA%B0%95%EA%B8%B0%EB%8A%A5%EC%8B%9D%ED%92%88%20%ED%97%88%EC%9C%84%EA%B3%BC%EB%8C%80%EA%B4%91%EA%B3%A0%20%EC%A1%B0%ED%9A%8C'
  );
});
