import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateAiSuspicionScore,
  detectAiMetadataKeywords,
  determineAiSuspicionLevel,
  getReliabilityScoreFromAiSuspicion,
  hasValidVideoTimestamp,
  parseIso8601DurationSeconds,
} from './aiSuspicion';
import { calculateReliabilityScore } from './analysisHelpers';
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

test('hasValidVideoTimestamp accepts MM:SS / H:MM:SS and rejects missing/non-timestamp strings', () => {
  assert.equal(hasValidVideoTimestamp('0:04'), true);
  assert.equal(hasValidVideoTimestamp('01:15'), true);
  assert.equal(hasValidVideoTimestamp('1:02:09'), true);
  assert.equal(hasValidVideoTimestamp(''), false);
  assert.equal(hasValidVideoTimestamp('전체 영상'), false);
  assert.equal(hasValidVideoTimestamp('없음'), false);
});

test('detectAiMetadataKeywords detects AI tool names and AI hashtags without false positives', () => {
  assert.deepEqual(
    detectAiMetadataKeywords({
      title: 'Sora로 만든 놀라운 고양이 영상 #AI #Veo',
      description: 'Kling과 Runway를 참고해 테스트했습니다.',
    }),
    ['Sora', 'Veo', 'Kling', 'Runway', '#AI / AI']
  );

  // Substrings like "rain", "chair", "explain", "daily" must NOT false trigger "AI"
  assert.deepEqual(
    detectAiMetadataKeywords({
      title: 'Rainy day daily chair explain video',
      description: 'A real-life vlog filmed outside in the rain.',
    }),
    []
  );
});

test('parseIso8601DurationSeconds parses YouTube ISO 8601 duration strings', () => {
  assert.equal(parseIso8601DurationSeconds('PT45S'), 45);
  assert.equal(parseIso8601DurationSeconds('PT1M30S'), 90);
  assert.equal(parseIso8601DurationSeconds('PT1H2M5S'), 3725);
  assert.equal(parseIso8601DurationSeconds('invalid'), null);
});

test('calculateAiSuspicionScore computes logo (+40), timestamped clues (+10 each max 40), and keywords (+20)', () => {
  const result = calculateAiSuspicionScore({
    available: true,
    aiLogos: [{ toolName: 'Sora', timestamp: '0:02', description: '우측 하단 Sora 로고' }],
    visualAndAudioClues: [
      { id: 'c1', category: '손가락·치아·눈 모양 이상', timestamp: '0:04', description: '손가락이 6개로 보임' },
      { id: 'c2', category: '물체가 갑자기 변하거나 사라짐', timestamp: '0:09', description: '컵이 갑자기 사라짐' },
      { id: 'c3', category: '단조로운 합성 음성', timestamp: '시점 없음', description: '시점이 없는 단서는 제외되어야 함' },
      { id: 'c4', category: '화면 속 AI 도구 로고', timestamp: '0:02', description: '로고 중복 항목 제외' },
    ],
    metadataKeywords: ['Sora', '#AI / AI'],
  });

  // 40 (logo) + 20 (2 valid timestamp clues) + 20 (metadata keyword) = 80
  assert.equal(result.logoScore, 40);
  assert.equal(result.timestampedClueCount, 2);
  assert.equal(result.excludedClueCount, 1);
  assert.equal(result.timestampCluesScore, 20);
  assert.equal(result.metadataKeywordScore, 20);
  assert.equal(result.totalScore, 80);
  assert.equal(result.level, '의심 단서 많음');
});

test('calculateAiSuspicionScore caps timestamp clues at 40 and maps suspicion levels accurately', () => {
  const manyClues = Array.from({ length: 6 }, (_, i) => ({
    id: `c-${i}`,
    category: '부자연스러운 움직임',
    timestamp: `0:0${i + 1}`,
    description: '움직임 이상',
  }));

  const capped = calculateAiSuspicionScore({
    available: true,
    aiLogos: [],
    visualAndAudioClues: manyClues,
    metadataKeywords: [],
  });
  assert.equal(capped.timestampCluesScore, 40);
  assert.equal(capped.totalScore, 40);
  assert.equal(capped.level, '일부 의심');

  assert.equal(determineAiSuspicionLevel(0), '의심 단서 적음');
  assert.equal(determineAiSuspicionLevel(29), '의심 단서 적음');
  assert.equal(determineAiSuspicionLevel(30), '일부 의심');
  assert.equal(determineAiSuspicionLevel(59), '일부 의심');
  assert.equal(determineAiSuspicionLevel(60), '의심 단서 많음');
  assert.equal(determineAiSuspicionLevel(null), '판별 불가');
});

test('getReliabilityScoreFromAiSuspicion and calculateReliabilityScore map suspicion score to 0/5/10 points', () => {
  assert.equal(getReliabilityScoreFromAiSuspicion(0), 10);
  assert.equal(getReliabilityScoreFromAiSuspicion(29), 10);
  assert.equal(getReliabilityScoreFromAiSuspicion(30), 5);
  assert.equal(getReliabilityScoreFromAiSuspicion(59), 5);
  assert.equal(getReliabilityScoreFromAiSuspicion(60), 0);
  assert.equal(getReliabilityScoreFromAiSuspicion(100), 0);
  assert.equal(getReliabilityScoreFromAiSuspicion(null), 5);

  const unavailableSuspicion = calculateAiSuspicionScore({
    available: false,
    aiLogos: [],
    visualAndAudioClues: [],
    metadataKeywords: [],
  });
  assert.equal(unavailableSuspicion.totalScore, null);
  assert.equal(unavailableSuspicion.level, '판별 불가');

  const reliability = calculateReliabilityScore({
    checklist: makeFiveCoreItems(['예', '예', '예', '예', '예']),
    exaggeratedCount: 0,
    aiLikelihoodLevel: '판별 불확실',
    aiSuspicionScore: unavailableSuspicion.totalScore,
    aiSuspicionLevel: unavailableSuspicion.level,
  });
  // 75 + 15 + 5 (unavailable) = 95
  assert.equal(reliability.aiGenerationScore, 5);
  assert.equal(reliability.totalScore, 95);
});
