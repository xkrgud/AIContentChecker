import type {
  AiLikelihoodLevel,
  AiSuspicionLevel,
  ChecklistItem,
  ChecklistVerdict,
  CoreClaim,
  OverallStatus,
  ScoreBreakdown,
} from '../types/analysis.ts';
import { getReliabilityScoreFromAiSuspicion } from './aiSuspicion.ts';

export interface OverallStatusMeta {
  label: string;
  description: string;
  containerClass: string;
  badgeTextClass: string;
  gaugeStrokeColor: string;
  iconName: 'shield-alert' | 'alert-triangle' | 'shield-check';
}

export function getChecklistItemScore(verdict: ChecklistVerdict): number {
  switch (verdict) {
    case '예':
      return 15;
    case '확인 필요':
      return 8;
    case '아니오':
      return 0;
  }
}

export function getExaggerationCountScore(count: number): number {
  if (count <= 0) return 15;
  if (count <= 2) return 8;
  return 0;
}

export function getAiGenerationScore(level: AiLikelihoodLevel): number {
  switch (level) {
    case '가능성 낮음':
      return 10;
    case '판별 불확실':
    case '일부 AI 활용 가능성':
      return 5;
    case 'AI 생성·합성 의심 요소 발견':
      return 0;
  }
}

export function calculateReliabilityScore(params: {
  checklist: ChecklistItem[];
  exaggeratedCount: number;
  aiLikelihoodLevel: AiLikelihoodLevel;
  aiSuspicionScore?: number | null;
  aiSuspicionLevel?: AiSuspicionLevel;
}): ScoreBreakdown {
  const coreChecklistItems = params.checklist
    .filter((item) => item.category === '기본 검증')
    .slice(0, 5);

  const checklistItemsBreakdown = coreChecklistItems.map((item) => {
    const score = getChecklistItemScore(item.aiVerdict);
    return {
      id: item.id,
      label: item.question,
      verdict: item.aiVerdict,
      score,
      maxScore: 15 as const,
    };
  });

  const checklistScore = checklistItemsBreakdown.reduce((sum, item) => sum + item.score, 0);
  const exaggerationCount = Math.max(0, params.exaggeratedCount);
  const exaggerationScore = getExaggerationCountScore(exaggerationCount);

  const hasSuspicionInput =
    params.aiSuspicionLevel !== undefined || params.aiSuspicionScore !== undefined;
  const aiGenerationScore = hasSuspicionInput
    ? getReliabilityScoreFromAiSuspicion(params.aiSuspicionScore)
    : getAiGenerationScore(params.aiLikelihoodLevel);
  const totalScore = checklistScore + exaggerationScore + aiGenerationScore;

  return {
    totalScore,
    maxScore: 100,
    checklistScore,
    checklistMaxScore: 75,
    checklistItemsBreakdown,
    exaggerationScore,
    exaggerationMaxScore: 15,
    exaggerationCount,
    aiGenerationScore,
    aiGenerationMaxScore: 10,
    aiLikelihoodLevel: params.aiLikelihoodLevel,
    aiSuspicionScore: params.aiSuspicionScore,
    aiSuspicionLevel: params.aiSuspicionLevel,
  };
}

export function determineOverallStatusFromScore(score: number): OverallStatus {
  if (score >= 70) {
    return 'low_risk_observed';
  }
  if (score >= 40) {
    return 'caution_found';
  }
  return 'needs_verification';
}

export function getOverallStatusMeta(status: OverallStatus): OverallStatusMeta {
  switch (status) {
    case 'needs_verification':
      return {
        label: '추가 검증 필요',
        description:
          '믿을 만한 근거가 부족하거나 과장된 표현이 많아요. 다른 믿을 수 있는 자료로 꼭 다시 확인해 보세요.',
        containerClass: 'bg-rose-50 border-rose-200 text-rose-950',
        badgeTextClass: 'text-rose-800',
        gaugeStrokeColor: '#BE123C',
        iconName: 'shield-alert',
      };
    case 'caution_found':
      return {
        label: '주의할 요소 발견',
        description:
          '과장되거나 출처가 모호한 부분이 일부 보여요. 내용을 그대로 믿기 전에 한 번 더 확인하는 게 좋아요.',
        containerClass: 'bg-amber-50 border-amber-200 text-amber-950',
        badgeTextClass: 'text-amber-800',
        gaugeStrokeColor: '#B45309',
        iconName: 'alert-triangle',
      };
    case 'low_risk_observed':
      return {
        label: '확인할 만한 위험 요소가 적음',
        description:
          '과장된 말이나 의심되는 요소가 적은 편이에요. 그래도 중요한 정보는 공식 자료와 한 번 더 비교해 보세요.',
        containerClass: 'bg-emerald-50 border-emerald-200 text-emerald-950',
        badgeTextClass: 'text-emerald-800',
        gaugeStrokeColor: '#15803D',
        iconName: 'shield-check',
      };
  }
}

export function getChecklistVerdictMeta(verdict: ChecklistVerdict): {
  label: string;
  badgeClass: string;
} {
  switch (verdict) {
    case '예':
      return {
        label: 'AI 판정: 충족 (예)',
        badgeClass: 'border-emerald-200 bg-emerald-50 text-emerald-800',
      };
    case '아니오':
      return {
        label: 'AI 판정: 미충족 (아니오)',
        badgeClass: 'border-rose-200 bg-rose-50 text-rose-800',
      };
    case '확인 필요':
      return {
        label: 'AI 판정: 확인 필요',
        badgeClass: 'border-amber-200 bg-amber-50 text-amber-800',
      };
  }
}

export function calculateChecklistProgress(items: ChecklistItem[]): {
  total: number;
  passed: number;
  failed: number;
  needsCheck: number;
  checked: number;
  percentage: number;
} {
  const total = items.length;
  if (total === 0) {
    return { total: 0, passed: 0, failed: 0, needsCheck: 0, checked: 0, percentage: 0 };
  }
  const passed = items.filter((item) => item.aiVerdict === '예').length;
  const failed = items.filter((item) => item.aiVerdict === '아니오').length;
  const needsCheck = items.filter((item) => item.aiVerdict === '확인 필요').length;
  const checked = items.filter((item) => item.checked).length;
  const percentage = Math.round((checked / total) * 100);
  return { total, passed, failed, needsCheck, checked, percentage };
}

export const CORE_CHECKLIST_QUESTIONS: Array<{
  id: string;
  question: string;
  hint: string;
}> = [
  {
    id: 'chk-evidence',
    question: '주장을 뒷받침하는 실험·데이터·공식 기록 같은 근거가 들어 있나요?',
    hint: '단순한 경험담이나 출처 없는 숫자만 말하고 있는지 살펴봅니다.',
  },
  {
    id: 'chk-source',
    question: '누가, 언제, 어디서 발표한 자료인지 출처가 분명한가요?',
    hint: '"전문가들이 그렇대요"처럼 막연하게 말하지 않고 실제 기관이나 자료 이름을 밝혔는지 봅니다.',
  },
  {
    id: 'chk-stats',
    question: '나온 숫자나 연구 결과를 믿을 수 있는 기관에서 찾아볼 수 있나요?',
    hint: '국가 기관이나 학술 자료 등에서 다시 검색해 확인할 수 있는 구체적인 정보인지 봅니다.',
  },
  {
    id: 'chk-exaggeration',
    question: '과장하거나 오해하게 만드는 말 없이 차분하게 설명하고 있나요?',
    hint: '"무조건", "100%", "기적", "안 하면 큰일" 같은 자극적인 표현이 없는지 봅니다.',
  },
  {
    id: 'chk-cross-check',
    question: '한쪽 이야기나 홍보에만 치우치지 않고 균형 있게 설명하나요?',
    hint: '주의할 점이나 반대 의견, 단점도 함께 알려주는지 살펴봅니다.',
  },
];

export function buildDefaultChecklist(coreClaims: CoreClaim[]): ChecklistItem[] {
  const baseItems: ChecklistItem[] = CORE_CHECKLIST_QUESTIONS.map((q) => ({
    id: q.id,
    question: q.question,
    category: '기본 검증',
    hint: q.hint,
    aiVerdict: '확인 필요',
    aiReason: '아직 콘텐츠 분석이 실행되지 않았습니다. 콘텐츠를 분석하면 AI가 항목별로 직접 점검해 드립니다.',
    checked: false,
  }));

  const dynamicItems: ChecklistItem[] = coreClaims.slice(0, 2).map((claim, idx) => ({
    id: `chk-claim-${idx + 1}`,
    question: `핵심 주장 "${claim.claim}"에 충분한 근거가 있나요?`,
    category: '주장별 검증',
    hint: claim.evidenceNeeds || '이 주장을 뒷받침하는 공식 자료가 있는지 살펴봅니다.',
    aiVerdict: '확인 필요',
    aiReason: claim.evidenceNeeds || '추가 확인이 필요합니다.',
    checked: false,
  }));

  return [...baseItems, ...dynamicItems];
}

export function buildSearchUrl(query: string): string {
  const trimmed = query.trim();
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}
