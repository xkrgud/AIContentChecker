import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Bot,
  Camera,
  CheckSquare,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  FileSearch,
  Film,
  Info,
  Search,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import type {
  AiSuspicionReport,
  AnalysisReport,
  ClaimFactCheckVerdict,
  OverallFactCheckVerdict,
} from '../types/analysis';
import {
  buildSearchUrl,
  calculateChecklistProgress,
  calculateReliabilityScore,
  determineOverallStatusFromScore,
  getChecklistVerdictMeta,
  getOverallStatusMeta,
} from '../utils/analysisHelpers';
import { calculateAiSuspicionScore, getAiSuspicionMeta } from '../utils/aiSuspicion';
import { determineOverallFactCheckVerdict } from '../utils/factCheck';
import { getPlatformLabel } from '../utils/urlParser';
import { formatFileSizeLabel } from '../utils/videoUpload';

interface AnalysisReportViewProps {
  report: AnalysisReport;
  onOpenChecklist: () => void;
  onStartNew: () => void;
}

const CORE_ITEM_SHORT_LABELS: Record<string, string> = {
  'chk-evidence': '1. 실험·공식 근거',
  'chk-source': '2. 출처 명확성',
  'chk-stats': '3. 수치·연구 확인',
  'chk-exaggeration': '4. 차분한 표현',
  'chk-cross-check': '5. 균형 있는 설명',
};

function getOverallFactCheckBannerMeta(verdict: OverallFactCheckVerdict) {
  switch (verdict) {
    case '사실과 다른 내용이 있어요':
      return {
        containerClass: 'border-rose-300 bg-rose-50 text-rose-950',
        iconClass: 'text-rose-700',
        labelClass: 'text-rose-800',
        Icon: ShieldAlert,
      };
    case '확인된 자료와 일치해요':
      return {
        containerClass: 'border-emerald-300 bg-emerald-50 text-emerald-950',
        iconClass: 'text-emerald-700',
        labelClass: 'text-emerald-800',
        Icon: ShieldCheck,
      };
    case '일부 내용은 확인되지 않았어요':
    default:
      return {
        containerClass: 'border-amber-300 bg-amber-50 text-amber-950',
        iconClass: 'text-amber-700',
        labelClass: 'text-amber-800',
        Icon: AlertTriangle,
      };
  }
}

function getClaimVerdictBadgeClass(verdict?: ClaimFactCheckVerdict): string {
  switch (verdict) {
    case '사실과 일치':
      return 'border-emerald-300 bg-emerald-100 text-emerald-950';
    case '사실과 다름':
      return 'border-rose-300 bg-rose-100 text-rose-950';
    case '다른 리뷰·기사에도 비슷한 평가가 있음':
      return 'border-blue-300 bg-blue-100 text-blue-950';
    case '비슷한 평가를 찾지 못함':
      return 'border-amber-300 bg-amber-100 text-amber-950';
    case '확인 불가':
    default:
      return 'border-slate-300 bg-white text-slate-700';
  }
}

export const AnalysisReportView: React.FC<AnalysisReportViewProps> = ({
  report,
  onOpenChecklist,
  onStartNew,
}) => {
  const [detailsExpanded, setDetailsExpanded] = useState(false);

  useEffect(() => {
    setDetailsExpanded(false);
  }, [report.id]);

  const fallbackSuspicionBreakdown = calculateAiSuspicionScore({
    available: false,
    aiLogos: [],
    visualAndAudioClues: [],
    metadataKeywords: [],
  });

  const aiSuspicion: AiSuspicionReport = report.aiSuspicion ?? {
    available: false,
    score: null,
    level: '판별 불가',
    breakdown: fallbackSuspicionBreakdown,
    creatorDisclosedSyntheticMedia: false,
    aiLogos: [],
    visualAndAudioClues: [],
    metadataKeywords: [],
    realFootageClues: [],
    summaryNote: '이전 분석 기록에는 별도의 AI 생성 단서 점검 정보가 포함되어 있지 않아요.',
  };

  const scoreBreakdown =
    report.scoreBreakdown ??
    calculateReliabilityScore({
      checklist: report.checklist,
      exaggeratedCount: report.exaggeratedExpressions.length,
      aiLikelihoodLevel: report.aiGenerationAssessment.likelihoodLevel,
    });

  const reliabilityScore = report.reliabilityScore ?? scoreBreakdown.totalScore;
  const computedStatus = determineOverallStatusFromScore(reliabilityScore);
  const statusMeta = getOverallStatusMeta(computedStatus);
  const suspicionMeta = getAiSuspicionMeta(aiSuspicion.level);
  const checklistProgress = calculateChecklistProgress(report.checklist);

  const threeLineSummary = report.threeLineSummary ?? {
    whatItIs: report.analyzedVideoInfo?.whatVideoIsAbout || report.inputSummary,
    watchOutFor:
      report.exaggeratedExpressions.length > 0
        ? `과장되거나 오해하기 쉬운 표현이 ${report.exaggeratedExpressions.length}개 보여서 조심해서 봐야 해요.`
        : statusMeta.description,
    howToVerify:
      report.additionalVerificationSteps[0] ||
      '추천 검색어로 믿을 수 있는 공식 자료나 뉴스를 직접 찾아 비교해 보세요.',
  };

  const StatusIcon =
    statusMeta.iconName === 'shield-alert'
      ? ShieldAlert
      : statusMeta.iconName === 'alert-triangle'
        ? AlertTriangle
        : ShieldCheck;

  const formattedTime = new Date(report.createdAt).toLocaleString('ko-KR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

  const videoInfo = report.analyzedVideoInfo;

  // Semicircular SVG gauge math (arc radius 72, half circle circumference = PI * 72 ≈ 226.19)
  const radius = 72;
  const arcLength = Math.PI * radius;
  const clampedReliabilityRatio = Math.max(0, Math.min(1, reliabilityScore / 100));
  const reliabilityDashoffset = arcLength * (1 - clampedReliabilityRatio);

  const suspicionNumericScore = aiSuspicion.score ?? 0;
  const clampedSuspicionRatio =
    aiSuspicion.score != null ? Math.max(0, Math.min(1, suspicionNumericScore / 100)) : 0;
  const suspicionDashoffset = arcLength * (1 - clampedSuspicionRatio);

  const totalCluesDetected = aiSuspicion.breakdown.totalCluesDetected;
  const hasSuspicionInBreakdown =
    scoreBreakdown.aiSuspicionLevel !== undefined || Boolean(report.aiSuspicion);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8 space-y-5">
      {/* Top Action & Meta Bar */}
      <div className="flex flex-col gap-3 border-b border-slate-200 pb-5 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 font-mono tabular-nums">
            <span>
              {report.inputMode === 'url'
                ? getPlatformLabel(report.platform)
                : report.inputMode === 'image'
                  ? '이미지 분석'
                  : '텍스트 분석'}
            </span>
            <span aria-hidden="true">·</span>
            <span>{formattedTime}</span>
            <span aria-hidden="true">·</span>
            <span>신뢰성 {reliabilityScore}점 / 100점</span>
            <span aria-hidden="true">·</span>
            <span>
              {aiSuspicion.score != null
                ? `AI 의심 ${aiSuspicion.score}점 / 100점`
                : 'AI 의심 판별 불가'}
            </span>
            {report.elapsedSeconds != null && (
              <>
                <span aria-hidden="true">·</span>
                <span data-testid="report-elapsed-seconds">{report.elapsedSeconds}초 소요</span>
              </>
            )}
            {report.usedFallbackModel && (
              <span
                data-testid="fallback-model-notice"
                className="rounded border border-slate-200 bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700"
              >
                가벼운 모델로 분석했어요
              </span>
            )}
          </div>
          <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
            {report.contentTitle}
          </h1>
          {report.sourceUrl && (
            <p className="mt-1 text-xs font-mono text-slate-500 break-all">{report.sourceUrl}</p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={onOpenChecklist}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <CheckSquare className="h-4 w-4 text-blue-700" aria-hidden="true" />
            AI 체크리스트 보기
          </button>
          <button
            type="button"
            onClick={onStartNew}
            className="rounded-lg bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
          >
            다른 콘텐츠 분석
          </button>
        </div>
      </div>

      {/* 0. 결과 화면 맨 위: 종합 사실 확인 판정 배너 */}
      {report.factCheck && (() => {
        const resolvedOverallVerdict =
          report.factCheck.overallVerdict ??
          determineOverallFactCheckVerdict(report.factCheck.items);
        const bannerMeta = getOverallFactCheckBannerMeta(resolvedOverallVerdict);
        const BannerIcon = bannerMeta.Icon;
        const factCount = report.factCheck.items.filter(
          (item) => item.claimType !== 'opinion'
        ).length;
        const opinionCount = report.factCheck.items.filter(
          (item) => item.claimType === 'opinion'
        ).length;
        const errorCount = report.factCheck.searchErrorCount ?? 0;

        return (
          <section
            data-testid="overall-fact-check-verdict"
            aria-label="종합 사실 확인 판정"
            className={`rounded-2xl border-2 p-5 sm:p-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between ${bannerMeta.containerClass}`}
          >
            <div className="flex items-start gap-3.5">
              <BannerIcon
                className={`h-7 w-7 shrink-0 mt-0.5 ${bannerMeta.iconClass}`}
                aria-hidden="true"
              />
              <div className="space-y-1">
                <p className={`text-xs font-bold ${bannerMeta.labelClass}`}>
                  최신 검색 자료 기준 종합 판정
                </p>
                <p className="text-xl font-extrabold tracking-tight sm:text-2xl">
                  {resolvedOverallVerdict}
                </p>
              </div>
            </div>
            <div className="text-xs font-medium opacity-85 sm:text-right space-y-0.5 pl-10 sm:pl-0 font-mono tabular-nums">
              <p>
                사실 주장 {factCount}개 · 의견 주장 {opinionCount}개 확인
              </p>
              {errorCount > 0 && <p>검색 오류 {errorCount}개 발생</p>}
            </div>
          </section>
        );
      })()}

      {/* 제작자 AI 합성 콘텐츠 표시 (YouTube Data API containsSyntheticMedia === true 일 때만 최상단 표시) */}
      {aiSuspicion.creatorDisclosedSyntheticMedia && (
        <section
          aria-label="제작자 AI 합성 표기 안내"
          className="rounded-2xl border-2 border-amber-400 bg-amber-50 p-4 sm:p-5 flex items-start gap-3.5"
        >
          <AlertTriangle className="h-6 w-6 text-amber-800 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="space-y-1">
            <p className="text-base font-bold text-amber-950 sm:text-lg">
              제작자가 AI 합성 콘텐츠라고 밝힘
            </p>
            <p className="text-sm leading-relaxed text-amber-900">
              유튜브 공식 영상 정보에 제작자가 AI로 만들었거나 변형·합성한 콘텐츠라는 표시가
              등록되어 있어요. 이 표시는 아래 점수와 별도로 확인된 공식 정보예요.
            </p>
          </div>
        </section>
      )}

      {/* 1. 맨 위: 신뢰성 점검 점수 & AI 생성 의심도 나란히 표시 */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 lg:items-stretch">
        {/* Left Card: 신뢰성 점검 점수 */}
        <section
          aria-labelledby="reliability-score-heading"
          className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 space-y-5"
        >
          <div className="flex flex-col items-center text-center border-b border-slate-100 pb-5">
            <div className="relative flex flex-col items-center justify-center">
              <svg
                viewBox="0 0 180 105"
                className="w-44 h-auto overflow-visible"
                role="img"
                aria-label={`신뢰성 점검 점수 ${reliabilityScore}점 (100점 만점)`}
              >
                <path
                  d="M 18 90 A 72 72 0 0 1 162 90"
                  fill="none"
                  stroke="#E2E8F0"
                  strokeWidth="14"
                  strokeLinecap="round"
                />
                <path
                  d="M 18 90 A 72 72 0 0 1 162 90"
                  fill="none"
                  stroke={statusMeta.gaugeStrokeColor}
                  strokeWidth="14"
                  strokeLinecap="round"
                  strokeDasharray={arcLength}
                  strokeDashoffset={reliabilityDashoffset}
                />
              </svg>
              <div className="-mt-11 flex flex-col items-center">
                <span className="font-mono text-4xl font-extrabold tracking-tight text-slate-950 tabular-nums">
                  {reliabilityScore}
                  <span className="text-lg font-semibold text-slate-500">점</span>
                </span>
              </div>
            </div>

            <h2
              id="reliability-score-heading"
              className="mt-2.5 text-xl font-bold text-slate-950 sm:text-2xl tabular-nums"
            >
              신뢰성 점검 점수 {reliabilityScore}점
            </h2>

            <div
              className={`mt-2 inline-flex items-center gap-2 rounded-lg border px-3.5 py-1.5 text-sm font-bold ${statusMeta.containerClass}`}
            >
              <StatusIcon
                className={`h-4 w-4 shrink-0 ${statusMeta.badgeTextClass}`}
                aria-hidden="true"
              />
              <span>{statusMeta.label}</span>
            </div>

            <p className="mt-2.5 text-xs leading-relaxed text-slate-600 max-w-md">
              사실일 확률이 아니라, 믿을 만한 콘텐츠가 갖추는 요소를 얼마나 갖췄는지 나타낸
              점수예요
            </p>
          </div>

          {/* Calculation Breakdown */}
          <div className="flex-1 space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-bold text-slate-950">점수 계산 내역 (100점 만점)</h3>
              <p className="text-[11px] font-mono text-slate-500 tabular-nums">
                70점↑ 위험 적음 · 40~69 주의 · 39점↓ 확인 필요
              </p>
            </div>

            <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-slate-50 px-4">
              {/* 1. Checklist 5 items */}
              <div className="py-3 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-semibold text-slate-900">체크리스트 기본 5개 항목</span>
                  <span className="font-mono font-bold text-slate-950 tabular-nums">
                    {scoreBreakdown.checklistScore}점 / 75점
                  </span>
                </div>
                <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2 text-xs text-slate-700">
                  {scoreBreakdown.checklistItemsBreakdown.map((item, idx) => (
                    <div
                      key={item.id}
                      className="flex items-center justify-between gap-2 rounded-md bg-white border border-slate-200 px-2.5 py-1.5"
                    >
                      <span className="truncate">
                        {CORE_ITEM_SHORT_LABELS[item.id] ?? `항목 ${idx + 1}`} ({item.verdict})
                      </span>
                      <span className="font-mono font-semibold text-slate-900 tabular-nums shrink-0">
                        +{item.score}점
                      </span>
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-slate-500">
                  기준: 예 15점 · 확인 필요 8점 · 아니오 0점
                </p>
              </div>

              {/* 2. Exaggeration count */}
              <div className="py-2.5 flex items-center justify-between gap-4 text-sm">
                <div>
                  <p className="font-semibold text-slate-900">
                    과장·오해 유발 표현 ({scoreBreakdown.exaggerationCount}개 발견)
                  </p>
                  <p className="text-[11px] text-slate-500">
                    기준: 0개 15점 · 1~2개 8점 · 3개 이상 0점
                  </p>
                </div>
                <span className="font-mono font-bold text-slate-950 tabular-nums shrink-0">
                  {scoreBreakdown.exaggerationScore}점 / 15점
                </span>
              </div>

              {/* 3. AI generation suspicion integration */}
              <div className="py-2.5 flex items-center justify-between gap-4 text-sm">
                <div>
                  <p className="font-semibold text-slate-900">
                    {hasSuspicionInBreakdown
                      ? `AI 생성 의심도 반영 (${scoreBreakdown.aiSuspicionLevel ?? aiSuspicion.level})`
                      : `AI 생성 가능성 (${scoreBreakdown.aiLikelihoodLevel})`}
                  </p>
                  <p className="text-[11px] text-slate-500">
                    {hasSuspicionInBreakdown
                      ? '기준: 0~29점 10점 · 30~59점 또는 판별 불가 5점 · 60점 이상 0점'
                      : '기준: 낮음 10점 · 불확실/일부 활용 5점 · 의심 0점'}
                  </p>
                </div>
                <span className="font-mono font-bold text-slate-950 tabular-nums shrink-0">
                  {scoreBreakdown.aiGenerationScore}점 / 10점
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Right Card: AI 생성 의심도 */}
        <section
          aria-labelledby="ai-suspicion-score-heading"
          className="flex flex-col rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 space-y-5"
        >
          <div className="flex flex-col items-center text-center border-b border-slate-100 pb-5">
            <div className="relative flex flex-col items-center justify-center">
              <svg
                viewBox="0 0 180 105"
                className="w-44 h-auto overflow-visible"
                role="img"
                aria-label={
                  aiSuspicion.score != null
                    ? `AI 생성 의심도 ${aiSuspicion.score}점 (100점 만점)`
                    : 'AI 생성 의심도 판별 불가'
                }
              >
                <path
                  d="M 18 90 A 72 72 0 0 1 162 90"
                  fill="none"
                  stroke="#E2E8F0"
                  strokeWidth="14"
                  strokeLinecap="round"
                />
                {aiSuspicion.score != null && (
                  <path
                    d="M 18 90 A 72 72 0 0 1 162 90"
                    fill="none"
                    stroke={suspicionMeta.gaugeStrokeColor}
                    strokeWidth="14"
                    strokeLinecap="round"
                    strokeDasharray={arcLength}
                    strokeDashoffset={suspicionDashoffset}
                  />
                )}
              </svg>
              <div className="-mt-11 flex flex-col items-center">
                {aiSuspicion.score != null ? (
                  <span className="font-mono text-4xl font-extrabold tracking-tight text-slate-950 tabular-nums">
                    {aiSuspicion.score}
                    <span className="text-lg font-semibold text-slate-500">점</span>
                  </span>
                ) : (
                  <span className="text-2xl font-extrabold tracking-tight text-slate-600">
                    불가
                  </span>
                )}
              </div>
            </div>

            <h2
              id="ai-suspicion-score-heading"
              className="mt-2.5 text-xl font-bold text-slate-950 sm:text-2xl tabular-nums"
            >
              {aiSuspicion.score != null
                ? `AI 생성 의심도 ${aiSuspicion.score}점`
                : 'AI 생성 의심도 판별 불가'}
            </h2>

            <div
              className={`mt-2 inline-flex items-center gap-2 rounded-lg border px-3.5 py-1.5 text-sm font-bold ${suspicionMeta.badgeClass}`}
            >
              <Bot className="h-4 w-4 shrink-0" aria-hidden="true" />
              <span>{suspicionMeta.label}</span>
            </div>

            <p className="mt-2.5 text-xs leading-relaxed text-slate-600 max-w-lg text-pretty">
              AI일 확률이 아니라 발견된 단서의 양을 나타낸 점수예요. 최신 AI 영상은 단서가 거의
              없을 수 있어요
            </p>
          </div>

          {/* AI Suspicion Breakdown */}
          <div className="flex-1 flex flex-col space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h3 className="text-sm font-bold text-slate-950 tabular-nums">
                발견된 단서 {totalCluesDetected}개 · 계산 내역 (100점 만점)
              </h3>
              <p className="text-[11px] font-mono text-slate-500 tabular-nums">
                0~29 적음 · 30~59 일부 · 60점↑ 많음
              </p>
            </div>

            <div className="divide-y divide-slate-100 rounded-xl border border-slate-200 bg-slate-50 px-4">
              <div className="py-2.5 flex items-center justify-between gap-4 text-sm">
                <div>
                  <p className="font-semibold text-slate-900">
                    화면 속 AI 도구 로고·워터마크 (
                    {aiSuspicion.aiLogos.length > 0
                      ? `${aiSuspicion.aiLogos.length}개 발견`
                      : '발견 안 됨'}
                    )
                  </p>
                  <p className="text-[11px] text-slate-500">
                    Sora, Veo, Kling 등 도구 로고·워터마크 확인 시 +40점
                  </p>
                </div>
                <span className="font-mono font-bold text-slate-950 tabular-nums shrink-0">
                  +{aiSuspicion.breakdown.logoScore}점 / 40점
                </span>
              </div>

              <div className="py-2.5 flex items-center justify-between gap-4 text-sm">
                <div>
                  <p className="font-semibold text-slate-900">
                    시점이 확인된 화면·소리 단서 ({aiSuspicion.breakdown.timestampedClueCount}개
                    발견)
                  </p>
                  <p className="text-[11px] text-slate-500">
                    분:초 시점이 적힌 단서만 반영 (1개당 +10점, 최대 40점)
                  </p>
                </div>
                <span className="font-mono font-bold text-slate-950 tabular-nums shrink-0">
                  +{aiSuspicion.breakdown.timestampCluesScore}점 / 40점
                </span>
              </div>

              <div className="py-2.5 flex items-center justify-between gap-4 text-sm">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-900 truncate">
                    제목·설명·해시태그 AI 관련 단어 (
                    {aiSuspicion.metadataKeywords.length > 0
                      ? aiSuspicion.metadataKeywords.join(', ')
                      : '발견 안 됨'}
                    )
                  </p>
                  <p className="text-[11px] text-slate-500">
                    AI, Sora, Veo, Kling, Runway 등 단어 포함 시 +20점
                  </p>
                </div>
                <span className="font-mono font-bold text-slate-950 tabular-nums shrink-0">
                  +{aiSuspicion.breakdown.metadataKeywordScore}점 / 20점
                </span>
              </div>

              <div className="py-2.5 flex items-center justify-between gap-4 text-xs text-slate-700">
                <span>실제 촬영처럼 보이는 단서</span>
                <span className="font-mono font-semibold text-slate-900 tabular-nums shrink-0">
                  {aiSuspicion.realFootageClues.length}개 확인
                </span>
              </div>
            </div>

            <div className="mt-auto space-y-2.5">
              <div className="rounded-xl border border-slate-200 bg-slate-50 px-3.5 py-2.5 text-xs leading-relaxed text-slate-700 space-y-1">
                <p>{aiSuspicion.summaryNote}</p>
                {aiSuspicion.sampledFps != null && (
                  <p className="text-[11px] font-mono text-slate-500 tabular-nums">
                    영상 점검 설정: 초당 {aiSuspicion.sampledFps}프레임(fps) 샘플링
                    {aiSuspicion.agenticVideoEnabled ? ' · 코드 기반 정밀 프레임 확인 사용' : ''}
                  </p>
                )}
              </div>

              <a
                href="https://synthid.com"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex w-full items-center justify-between gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-xs font-semibold text-slate-900 transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-900"
              >
                <span>SynthID Detector(https://synthid.com)에서 원본 파일로 추가 확인하기</span>
                <ExternalLink className="h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
              </a>

              {aiSuspicion.youtubeCreatorCheckStatus && (
                <p
                  data-testid="youtube-creator-check-status"
                  className="flex items-center justify-between gap-2 px-1 pt-0.5 text-[11px] text-slate-500"
                >
                  <span>YouTube 제작자 표시 확인</span>
                  <span className="font-medium text-slate-700">
                    {aiSuspicion.youtubeCreatorCheckStatus === 'checked'
                      ? '확인함'
                      : aiSuspicion.youtubeCreatorCheckStatus === 'no_api_key'
                        ? '키 없음(건너뜀)'
                        : '조회 실패'}
                  </span>
                </p>
              )}
            </div>
          </div>
        </section>
      </div>

      {/* 2. 점수 아래: 3줄 요약 카드 */}
      <section aria-labelledby="three-line-summary-heading">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3.5">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 pb-3.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <h2 id="three-line-summary-heading" className="text-lg font-bold text-slate-950">
                한눈에 보는 3줄 요약
              </h2>
              {report.reorganizedByLatestSearch && (
                <span
                  data-testid="latest-search-reorganized-badge"
                  className="inline-flex items-center rounded-md border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-900"
                >
                  최신 검색 자료를 기준으로 다시 정리했어요
                </span>
              )}
            </div>
            {videoInfo?.thumbnailUrl && (
              <span className="text-xs text-slate-500 truncate max-w-xs">
                {videoInfo.title || report.contentTitle}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-1.5">
              <p className="text-xs font-bold text-blue-800">01. 무슨 영상인지</p>
              <p className="text-sm leading-relaxed text-slate-800">
                {threeLineSummary.whatItIs}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-1.5">
              <p className="text-xs font-bold text-amber-800">02. 주의할 점</p>
              <p className="text-sm leading-relaxed text-slate-800">
                {threeLineSummary.watchOutFor}
              </p>
            </div>
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-1.5">
              <p className="text-xs font-bold text-emerald-800">03. 이렇게 확인해 보세요</p>
              <p className="text-sm leading-relaxed text-slate-800">
                {threeLineSummary.howToVerify}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* 2.5. 핵심 주장 Google 검색 자료 확인 */}
      {(() => {
        const factCheck = report.factCheck;
        const verifiedItems = (factCheck?.items ?? []).filter(
          (item) => item.status === 'sources_found'
        );
        const notFoundItems = (factCheck?.items ?? []).filter(
          (item) => item.status === 'not_found'
        );
        const searchErrorItems = (factCheck?.items ?? []).filter(
          (item) => item.status === 'search_error'
        );
        const uncheckedClaims = factCheck?.uncheckedClaims ?? [];
        const unverifiedTotal = notFoundItems.length + uncheckedClaims.length;

        return (
          <section aria-labelledby="fact-check-heading">
            <div className="rounded-2xl border border-slate-200 bg-white p-5 sm:p-6 space-y-4">
              <div className="flex flex-col gap-2 border-b border-slate-100 pb-3.5 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2 id="fact-check-heading" className="text-lg font-bold text-slate-950">
                    핵심 주장 Google 검색 판정 (사실 주장 우선 · 최대 3개)
                  </h2>
                  <p className="mt-0.5 text-xs text-slate-500">
                    사실 주장을 우선 선별해 제품명·사건명과 올해 연도로 최신 자료를 검색해 판정했어요.
                    출처마다 작성·수정 날짜를 함께 보여 드립니다.
                  </p>
                </div>
                {factCheck && factCheck.checkedCount > 0 && (
                  <div className="flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums shrink-0">
                    <span className="rounded-md border border-emerald-200 bg-emerald-50 px-2.5 py-1 font-semibold text-emerald-900">
                      자료 확인 {verifiedItems.length}개
                    </span>
                    <span className="rounded-md border border-slate-200 bg-slate-100 px-2.5 py-1 font-semibold text-slate-700">
                      확인 불가 {unverifiedTotal}개
                    </span>
                    {searchErrorItems.length > 0 && (
                      <span className="rounded-md border border-rose-200 bg-rose-50 px-2.5 py-1 font-semibold text-rose-900">
                        검색 오류 {searchErrorItems.length}개
                      </span>
                    )}
                  </div>
                )}
              </div>

              {!factCheck ? (
                <p className="text-sm text-slate-600">
                  이전 분석 기록에는 Google 검색 자료 확인 정보가 포함되어 있지 않아요.
                </p>
              ) : factCheck.checkedCount === 0 ? (
                <p className="text-sm text-slate-600">
                  검색으로 대조할 구체적인 핵심 주장이 추출되지 않았어요.
                </p>
              ) : (
                <div className="space-y-5">
                  {verifiedItems.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-xs font-bold text-slate-800">
                        검색 자료를 바탕으로 판정한 주장 ({verifiedItems.length}개)
                      </h3>
                      <div className="space-y-3">
                        {verifiedItems.map((item) => {
                          const isOpinion = item.claimType === 'opinion';
                          const verdictLabel = item.verdict || '확인 불가';
                          const cardBorder =
                            verdictLabel === '사실과 다름'
                              ? 'border-rose-200 bg-rose-50/40'
                              : verdictLabel === '사실과 일치'
                                ? 'border-emerald-200 bg-emerald-50/40'
                                : 'border-slate-200 bg-slate-50/60';

                          return (
                            <article
                              key={item.claimId}
                              data-testid="fact-check-claim-card"
                              className={`rounded-xl border p-4 space-y-2.5 ${cardBorder}`}
                            >
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <div className="flex flex-wrap items-center gap-2 min-w-0">
                                  <span
                                    className={`rounded-md border px-2 py-0.5 text-[11px] font-bold shrink-0 ${
                                      isOpinion
                                        ? 'border-indigo-200 bg-indigo-50 text-indigo-900'
                                        : 'border-blue-200 bg-blue-50 text-blue-900'
                                    }`}
                                  >
                                    {isOpinion ? '의견 주장' : '사실 주장'}
                                  </span>
                                  <p className="text-sm font-bold text-slate-950">{item.claim}</p>
                                </div>
                                <span
                                  data-testid="claim-verdict-badge"
                                  className={`rounded-md border px-2.5 py-0.5 text-xs font-bold shrink-0 ${getClaimVerdictBadgeClass(
                                    item.verdict
                                  )}`}
                                >
                                  {verdictLabel}
                                </span>
                              </div>

                              <p className="text-sm leading-relaxed text-slate-800">{item.summary}</p>

                              {item.sources.length > 0 && (
                                <div className="space-y-1.5 pt-1">
                                  <p className="text-xs font-semibold text-slate-700">
                                    출처 링크 및 작성 날짜
                                  </p>
                                  <div className="flex flex-wrap gap-2">
                                    {item.sources.map((src, idx) => (
                                      <a
                                        key={idx}
                                        href={src.url}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-blue-800 transition-colors hover:border-blue-300 hover:bg-blue-50"
                                      >
                                        <span className="max-w-[160px] sm:max-w-[220px] truncate">{src.title}</span>
                                        <span className="font-mono text-[11px] text-slate-500 tabular-nums shrink-0">
                                          · {src.publishedDate || '날짜 미상'}
                                        </span>
                                        {src.isOutdated && (
                                          <span
                                            data-testid="outdated-source-badge"
                                            className="rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 text-[10px] font-bold text-amber-900 shrink-0"
                                          >
                                            오래된 자료
                                          </span>
                                        )}
                                        <ExternalLink
                                          className="h-3 w-3 shrink-0"
                                          aria-hidden="true"
                                        />
                                      </a>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </article>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {searchErrorItems.length > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-xs font-bold text-rose-900">
                        검색 중 오류가 발생한 주장 ({searchErrorItems.length}개)
                      </h3>
                      <div className="space-y-2.5">
                        {searchErrorItems.map((item) => (
                          <article
                            key={item.claimId}
                            data-testid="fact-check-search-error-card"
                            className="rounded-xl border border-rose-200 bg-rose-50/70 p-4 space-y-1.5"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex flex-wrap items-center gap-2 min-w-0">
                                <span className="rounded-md border border-blue-200 bg-white px-2 py-0.5 text-[11px] font-bold text-blue-900 shrink-0">
                                  {item.claimType === 'opinion' ? '의견 주장' : '사실 주장'}
                                </span>
                                <p className="text-sm font-semibold text-slate-950">{item.claim}</p>
                              </div>
                              <span className="rounded-md border border-rose-300 bg-white px-2.5 py-0.5 text-xs font-bold text-rose-900 shrink-0">
                                검색 중 오류가 났어요
                              </span>
                            </div>
                            <p className="text-xs text-rose-900">
                              {item.summary && item.summary !== '검색 중 오류가 났어요'
                                ? item.summary
                                : 'Google 검색 요청 중 일시적인 오류가 발생해 판정하지 못했어요. 잠시 후 다시 시도하거나 아래 추천 검색어로 직접 확인해 주세요.'}
                            </p>
                          </article>
                        ))}
                      </div>
                    </div>
                  )}

                  {unverifiedTotal > 0 && (
                    <div className="space-y-3">
                      <h3 className="text-xs font-bold text-slate-700">
                        자료를 찾지 못했거나 확인되지 않은 주장 ({unverifiedTotal}개)
                      </h3>
                      <div className="space-y-2.5">
                        {notFoundItems.map((item) => (
                          <article
                            key={item.claimId}
                            className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-1.5"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex flex-wrap items-center gap-2 min-w-0">
                                <span className="rounded-md border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-bold text-slate-700 shrink-0">
                                  {item.claimType === 'opinion' ? '의견 주장' : '사실 주장'}
                                </span>
                                <p className="text-sm font-semibold text-slate-900">{item.claim}</p>
                              </div>
                              <span className="rounded-md border border-slate-300 bg-white px-2.5 py-0.5 text-xs font-bold text-slate-700 shrink-0">
                                {item.verdict || '확인 불가'}
                              </span>
                            </div>
                            <p className="text-xs text-slate-600">
                              확인된 자료 없음 — Google 검색에서 이 주장을 대조할 신뢰할 만한 자료를 찾지 못했어요.
                            </p>
                          </article>
                        ))}
                        {uncheckedClaims.map((claimItem, idx) => (
                          <article
                            key={claimItem.id || `unchecked-${idx}`}
                            className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-1.5"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="flex flex-wrap items-center gap-2 min-w-0">
                                <span className="rounded-md border border-slate-300 bg-white px-2 py-0.5 text-[11px] font-bold text-slate-700 shrink-0">
                                  {claimItem.claimType === 'opinion' ? '의견 주장' : '사실 주장'}
                                </span>
                                <p className="text-sm font-semibold text-slate-900">
                                  {claimItem.claim}
                                </p>
                              </div>
                              <span className="rounded-md border border-slate-300 bg-white px-2.5 py-0.5 text-xs font-semibold text-slate-600 shrink-0">
                                검색 대상 외 (사실 주장 우선 · 최대 3개)
                              </span>
                            </div>
                            <p className="text-xs text-slate-600">
                              사실 주장을 우선으로 상위 3개만 자동 검색으로 확인했어요. 아래 추천 검색어로 직접 확인해 보세요.
                            </p>
                          </article>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        );
      })()}

      {/* 3. 상세 분석 섹션 (처음엔 접혀 있고 누르면 펼쳐짐) */}
      <section aria-label="상세 분석 영역" className="space-y-4">
        <button
          type="button"
          aria-expanded={detailsExpanded}
          aria-controls="detailed-analysis-panel"
          onClick={() => setDetailsExpanded((prev) => !prev)}
          className="flex w-full items-center justify-between gap-4 rounded-2xl border border-slate-300 bg-white px-6 py-4 text-left transition-colors hover:bg-slate-50 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
        >
          <div>
            <p className="text-base font-bold text-slate-950">
              {detailsExpanded ? '상세 분석 접기' : '상세 분석 펼쳐 보기'}
            </p>
            <p className="mt-0.5 text-xs text-slate-600">
              영상 정보, 체크리스트 근거, 핵심 주장 {report.coreClaims.length}개, 과장 표현{' '}
              {report.exaggeratedExpressions.length}개, AI 의심 단서·실제 촬영 단서 상세 내용을 볼 수
              있어요
            </p>
          </div>
          {detailsExpanded ? (
            <ChevronUp className="h-5 w-5 text-slate-700 shrink-0" aria-hidden="true" />
          ) : (
            <ChevronDown className="h-5 w-5 text-slate-700 shrink-0" aria-hidden="true" />
          )}
        </button>

        {detailsExpanded && (
          <div id="detailed-analysis-panel" className="space-y-6">
            {/* 분석한 영상 · 콘텐츠 정보 */}
            <section
              aria-labelledby="analyzed-subject-heading"
              className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4"
            >
              <div className="flex items-center gap-2.5 border-b border-slate-100 pb-3.5">
                <Film className="h-5 w-5 text-blue-700 shrink-0" aria-hidden="true" />
                <h2 id="analyzed-subject-heading" className="text-base font-bold text-slate-950">
                  분석한 영상 · 콘텐츠 정보
                </h2>
              </div>

              <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                {videoInfo?.thumbnailUrl && (
                  <img
                    src={videoInfo.thumbnailUrl}
                    alt={videoInfo.title || report.contentTitle}
                    referrerPolicy="no-referrer"
                    className="h-32 w-56 rounded-xl border border-slate-200 object-cover shrink-0 bg-slate-100"
                  />
                )}
                <div className="min-w-0 flex-1 space-y-2">
                  {(videoInfo?.title ||
                    videoInfo?.author ||
                    videoInfo?.uploadedFileName ||
                    report.compressionSummary?.wasCompressed) && (
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                      {videoInfo?.title && (
                        <span className="font-semibold text-slate-950 text-sm">
                          {videoInfo.title}
                        </span>
                      )}
                      {videoInfo?.author && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span>채널/작성자: {videoInfo.author}</span>
                        </>
                      )}
                      {videoInfo?.uploadedFileName && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">업로드 영상: {videoInfo.uploadedFileName}</span>
                        </>
                      )}
                      {report.compressionSummary?.wasCompressed && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono tabular-nums">
                            원본 {formatFileSizeLabel(report.compressionSummary.originalSizeBytes)} →{' '}
                            {formatFileSizeLabel(report.compressionSummary.compressedSizeBytes)}
                          </span>
                        </>
                      )}
                    </div>
                  )}

                  {report.c2paMetadata?.hasManifest && (
                    <div className="rounded-lg border border-blue-200 bg-blue-50/70 px-3 py-2 text-xs text-blue-950">
                      <span className="font-semibold">원본 C2PA 출처 자격 증명 확인됨</span>
                      {report.c2paMetadata.claimGenerator && (
                        <span> · 생성 도구: {report.c2paMetadata.claimGenerator}</span>
                      )}
                      {report.c2paMetadata.issuer && (
                        <span> · 서명 발급: {report.c2paMetadata.issuer}</span>
                      )}
                      {report.c2paMetadata.isAiGeneratedClaim && (
                        <span className="font-semibold text-amber-900"> · AI 생성/합성 표기 포함</span>
                      )}
                    </div>
                  )}

                  <p className="text-sm leading-relaxed text-slate-700">
                    {videoInfo?.whatVideoIsAbout || report.inputSummary}
                  </p>

                  {report.overallSummary && (
                    <div className="space-y-1.5 pt-1">
                      {report.reorganizedByLatestSearch && (
                        <p className="text-xs font-semibold text-blue-800">
                          최신 검색 자료를 기준으로 다시 정리했어요
                        </p>
                      )}
                      <p className="text-sm leading-relaxed text-slate-600">
                        <span className="font-semibold text-slate-800">전체 설명: </span>
                        {report.overallSummary}
                      </p>
                    </div>
                  )}

                  {report.extractedImageText && (
                    <div className="mt-2 rounded-xl border border-slate-200 bg-slate-50 p-4">
                      <p className="text-xs font-semibold text-slate-700">이미지 속 글자</p>
                      <p className="mt-1.5 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">
                        {report.extractedImageText}
                      </p>
                    </div>
                  )}
                </div>
              </div>
            </section>

            {/* AI 신뢰성 체크리스트 점검 결과 */}
            <section
              aria-labelledby="ai-checklist-summary-heading"
              className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4"
            >
              <div className="flex flex-col gap-3 border-b border-slate-100 pb-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <h2
                    id="ai-checklist-summary-heading"
                    className="text-lg font-bold text-slate-950"
                  >
                    AI 신뢰성 체크리스트 점검 결과
                  </h2>
                  <p className="mt-1 text-xs text-slate-500">
                    AI가 콘텐츠 내용을 기준으로 주요 항목을 직접 점검한 결과예요.
                  </p>
                </div>
                <div className="flex items-center gap-3 text-xs font-mono tabular-nums text-slate-700 shrink-0">
                  <span className="text-emerald-800 font-semibold">
                    충족 {checklistProgress.passed}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="text-rose-800 font-semibold">
                    미충족 {checklistProgress.failed}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span className="text-amber-800 font-semibold">
                    확인 필요 {checklistProgress.needsCheck}
                  </span>
                </div>
              </div>

              <div className="divide-y divide-slate-100">
                {report.checklist.map((item) => {
                  const verdictMeta = getChecklistVerdictMeta(item.aiVerdict);
                  return (
                    <div key={item.id} className="py-3.5 first:pt-0 last:pb-0 space-y-1.5">
                      <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
                        <p className="text-sm font-semibold text-slate-950">{item.question}</p>
                        <span
                          className={`inline-flex items-center rounded-md border px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap shrink-0 w-fit ${verdictMeta.badgeClass}`}
                        >
                          {verdictMeta.label}
                        </span>
                      </div>
                      <p className="text-xs leading-relaxed text-slate-600">{item.aiReason}</p>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* 핵심 주장 및 수치 추출 */}
            <section
              aria-labelledby="core-claims-heading"
              className="rounded-2xl border border-slate-200 bg-white p-6 space-y-5"
            >
              <div className="flex items-baseline justify-between gap-4 border-b border-slate-100 pb-4">
                <div>
                  <h2 id="core-claims-heading" className="text-lg font-bold text-slate-950">
                    핵심 주장 및 수치·사실 정보
                  </h2>
                  <p className="mt-1 text-xs text-slate-500">
                    콘텐츠에서 말하고 있는 중요한 주장을 하나씩 나누어 정리했어요.
                  </p>
                </div>
                <span className="font-mono text-xs font-medium text-slate-600 tabular-nums shrink-0">
                  총 {report.coreClaims.length}개 주장
                </span>
              </div>

              {report.coreClaims.length === 0 ? (
                <p className="text-sm text-slate-600">
                  따로 나누어 볼 만한 사실 주장이 발견되지 않았어요.
                </p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {report.coreClaims.map((claim, index) => (
                    <article key={claim.id} className="py-4 first:pt-0 last:pb-0 space-y-2.5">
                      <div className="flex flex-wrap items-baseline gap-2.5">
                        <span className="font-mono text-xs font-semibold text-blue-700 tabular-nums shrink-0">
                          주장 {String(index + 1).padStart(2, '0')}
                        </span>
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[11px] font-semibold shrink-0 ${
                            claim.claimType === 'opinion'
                              ? 'border-indigo-200 bg-indigo-50 text-indigo-900'
                              : 'border-blue-200 bg-blue-50 text-blue-900'
                          }`}
                        >
                          {claim.claimType === 'opinion' ? '의견 주장' : '사실 주장'}
                        </span>
                        <h3 className="text-base font-semibold text-slate-950 leading-snug">
                          {claim.claim}
                        </h3>
                      </div>

                      {claim.specificFiguresAndFacts.length > 0 && (
                        <div className="pl-0 sm:pl-14 text-xs text-slate-700">
                          <span className="font-semibold text-slate-900">나온 숫자·사실: </span>
                          <span>{claim.specificFiguresAndFacts.join(' · ')}</span>
                        </div>
                      )}

                      <div className="pl-0 sm:pl-14 text-xs leading-relaxed text-slate-600">
                        <span className="font-semibold text-slate-800">확인할 근거: </span>
                        <span>{claim.evidenceNeeds}</span>
                      </div>
                    </article>
                  ))}
                </div>
              )}
            </section>

            {/* 과장 및 오해 유발 표현 분석 */}
            <section
              aria-labelledby="exaggeration-heading"
              className="rounded-2xl border border-slate-200 bg-white p-6 space-y-5"
            >
              <div className="flex items-baseline justify-between gap-4 border-b border-slate-100 pb-4">
                <div>
                  <h2 id="exaggeration-heading" className="text-lg font-bold text-slate-950">
                    과장 및 오해 유발 표현 분석
                  </h2>
                  <p className="mt-1 text-xs text-slate-500">
                    너무 과장되었거나 걱정·불안을 부추겨 판단을 흐릴 수 있는 표현이에요.
                  </p>
                </div>
                <span className="font-mono text-xs font-medium text-slate-600 tabular-nums shrink-0">
                  {report.exaggeratedExpressions.length}건 탐지
                </span>
              </div>

              {report.exaggeratedExpressions.length === 0 ? (
                <p className="text-sm text-slate-600">
                  눈에 띄는 과장 표현이나 오해를 부르는 문구가 발견되지 않았어요.
                </p>
              ) : (
                <div className="divide-y divide-slate-100">
                  {report.exaggeratedExpressions.map((expr) => (
                    <div key={expr.id} className="py-4 first:pt-0 last:pb-0 space-y-2">
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                        <span className="font-semibold text-amber-800">{expr.category}</span>
                      </div>
                      <blockquote className="text-sm font-semibold text-slate-950">
                        “{expr.phrase}”
                      </blockquote>
                      <p className="text-sm leading-relaxed text-slate-600">{expr.reason}</p>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* 출처 및 근거 확인 + AI 생성 단서·실제 촬영 단서 상세 */}
            <div className="grid grid-cols-1 gap-6 lg:grid-cols-2 lg:items-stretch">
              <section
                aria-labelledby="sources-heading"
                className="flex flex-col rounded-2xl border border-slate-200 bg-white p-6 space-y-4"
              >
                <div className="flex items-center gap-2.5 border-b border-slate-100 pb-4">
                  <FileSearch className="h-5 w-5 text-blue-700 shrink-0" aria-hidden="true" />
                  <h2 id="sources-heading" className="text-lg font-bold text-slate-950">
                    출처 및 근거 확인
                  </h2>
                </div>

                <div className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs leading-relaxed text-amber-950">
                  <p className="font-semibold">출처 직접 확인 안내</p>
                  <p className="mt-1">{report.sourceAssessment.unverifiedWarning}</p>
                </div>

                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-slate-900">
                    콘텐츠 안 출처 유무:{' '}
                    <span
                      className={
                        report.sourceAssessment.hasCitedSources
                          ? 'text-emerald-800'
                          : 'text-rose-800'
                      }
                    >
                      {report.sourceAssessment.hasCitedSources
                        ? '출처 표기 일부 있음'
                        : '구체적 출처 부족'}
                    </span>
                  </p>
                  <p className="text-sm leading-relaxed text-slate-600">
                    {report.sourceAssessment.citedSourcesSummary}
                  </p>
                </div>

                {report.sourceAssessment.claimsRequiringStatisticsOrStudies.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold text-slate-900">
                      통계·연구 자료 확인이 필요한 부분
                    </p>
                    <ul className="list-disc pl-5 space-y-1 text-sm text-slate-600">
                      {report.sourceAssessment.claimsRequiringStatisticsOrStudies.map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {report.sourceAssessment.recommendedOfficialSources.length > 0 && (
                  <div className="space-y-1.5">
                    <p className="text-xs font-semibold text-slate-900">확인해 볼 공식·믿을 만한 자료</p>
                    <ul className="list-disc pl-5 space-y-1 text-sm text-slate-600">
                      {report.sourceAssessment.recommendedOfficialSources.map((src, i) => (
                        <li key={i}>{src}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {report.sourceAssessment.recommendedSearchQueries.length > 0 && (
                  <div className="mt-auto pt-2 space-y-2">
                    <p className="text-xs font-semibold text-slate-900">직접 찾아볼 추천 검색어</p>
                    <div className="flex flex-col gap-2">
                      {report.sourceAssessment.recommendedSearchQueries.map((query, i) => (
                        <a
                          key={i}
                          href={buildSearchUrl(query)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center justify-between gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-medium text-slate-800 transition-colors hover:border-blue-300 hover:bg-blue-50 hover:text-blue-900"
                        >
                          <span className="inline-flex items-center gap-2 truncate">
                            <Search
                              className="h-3.5 w-3.5 shrink-0 text-slate-500"
                              aria-hidden="true"
                            />
                            <span className="truncate">{query}</span>
                          </span>
                          <ExternalLink
                            className="h-3.5 w-3.5 shrink-0 text-slate-400"
                            aria-hidden="true"
                          />
                        </a>
                      ))}
                    </div>
                  </div>
                )}
              </section>

              <section
                aria-labelledby="ai-gen-heading"
                className="flex flex-col rounded-2xl border border-slate-200 bg-white p-6 space-y-4"
              >
                <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-4">
                  <div className="flex items-center gap-2.5">
                    <Bot className="h-5 w-5 text-blue-700 shrink-0" aria-hidden="true" />
                    <h2 id="ai-gen-heading" className="text-lg font-bold text-slate-950">
                      AI 생성 의심 단서 및 실제 촬영 단서
                    </h2>
                  </div>
                  <span className="font-mono text-xs text-slate-600 tabular-nums shrink-0">
                    {aiSuspicion.score != null ? `${aiSuspicion.score}점` : '판별 불가'}
                  </span>
                </div>

                {/* 1. AI 도구 로고 / 워터마크 */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-900">
                    화면 속 AI 도구 로고·워터마크
                  </p>
                  {aiSuspicion.aiLogos.length === 0 ? (
                    <p className="text-xs text-slate-600">
                      화면에서 Sora, Veo, Kling 같은 AI 도구 로고가 보이지 않았어요.
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {aiSuspicion.aiLogos.map((logo, i) => (
                        <li
                          key={i}
                          className="rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-950 space-y-0.5"
                        >
                          <div className="flex items-center gap-2 font-semibold">
                            <span className="font-mono tabular-nums text-rose-800">
                              [{logo.timestamp}]
                            </span>
                            <span>{logo.toolName}</span>
                          </div>
                          <p className="leading-relaxed text-rose-900">{logo.description}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* 2. 시점별 화면·소리 AI 단서 */}
                <div className="space-y-2">
                  <p className="text-xs font-semibold text-slate-900">
                    시점별 화면·소리 AI 의심 단서 ({aiSuspicion.visualAndAudioClues.length}개)
                  </p>
                  {aiSuspicion.visualAndAudioClues.length === 0 ? (
                    <p className="text-xs text-slate-600">
                      {aiSuspicion.available
                        ? '손가락·글자·경계·움직임·음성 등에서 시점이 확인된 특이 단서가 발견되지 않았어요.'
                        : '영상 프레임을 직접 불러오지 못해 화면·소리 단서를 확인하지 못했어요.'}
                    </p>
                  ) : (
                    <ul className="space-y-2">
                      {aiSuspicion.visualAndAudioClues.map((clue) => (
                        <li
                          key={clue.id}
                          className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950 space-y-0.5"
                        >
                          <div className="flex items-center gap-2 font-semibold">
                            <span className="font-mono tabular-nums text-amber-800">
                              [{clue.timestamp}]
                            </span>
                            <span>{clue.category}</span>
                          </div>
                          <p className="leading-relaxed text-amber-900">{clue.description}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {/* 3. 제목·설명·해시태그 AI 관련 단어 */}
                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-slate-900">
                    제목·설명·해시태그 AI 관련 단어
                  </p>
                  <p className="text-xs text-slate-700">
                    {aiSuspicion.metadataKeywords.length > 0
                      ? `발견된 단어: ${aiSuspicion.metadataKeywords.join(' · ')}`
                      : '제목·설명·해시태그에서 AI·Sora·Veo 같은 관련 단어가 보이지 않았어요.'}
                  </p>
                </div>

                {/* 4. 실제 촬영 영상 단서 */}
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3.5 space-y-2">
                  <div className="flex items-center gap-2">
                    <Camera className="h-4 w-4 text-emerald-800 shrink-0" aria-hidden="true" />
                    <p className="text-xs font-bold text-emerald-950">
                      실제 촬영 영상처럼 보이는 단서 ({aiSuspicion.realFootageClues.length}개)
                    </p>
                  </div>
                  {aiSuspicion.realFootageClues.length === 0 ? (
                    <p className="text-xs text-emerald-900">
                      실제 촬영임을 뒷받침하는 뚜렷한 현장 단서가 따로 기록되지 않았어요.
                    </p>
                  ) : (
                    <ul className="space-y-1.5 text-xs text-emerald-950">
                      {aiSuspicion.realFootageClues.map((clue, i) => (
                        <li key={i} className="leading-relaxed">
                          {clue.timestamp && (
                            <span className="font-mono font-semibold text-emerald-800 mr-1.5 tabular-nums">
                              [{clue.timestamp}]
                            </span>
                          )}
                          <span>{clue.description}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <div className="space-y-1.5">
                  <p className="text-xs font-semibold text-slate-900">목소리·영상 합성 참고 의견</p>
                  <p className="text-sm leading-relaxed text-slate-600">
                    {report.aiGenerationAssessment.audioOrSynthesisNotes}
                  </p>
                </div>

                <div className="mt-auto space-y-2.5">
                  {report.platform === 'instagram' && (
                    <div className="rounded-xl border border-amber-200 bg-amber-50 p-3.5 text-xs leading-relaxed text-amber-950">
                      <p className="font-semibold">인스타그램 게시물 직접 확인</p>
                      <p className="mt-1">
                        인스타그램 게시물 화면에 <strong className="font-semibold">&apos;AI 정보&apos;</strong>{' '}
                        표시가 함께 붙어 있는지도 직접 확인해 보세요.
                      </p>
                    </div>
                  )}

                  <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-xs leading-relaxed text-slate-700">
                    <div className="flex items-start gap-2">
                      <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" aria-hidden="true" />
                      <div>
                        <p className="font-semibold text-slate-900">왜 100% 장담하기 어려울까요?</p>
                        <p className="mt-1">
                          AI일 확률이 아니라 발견된 단서의 양을 나타낸 점수예요. 최신 AI 영상은 단서가
                          거의 없을 수 있어요. {report.aiGenerationAssessment.uncertaintyExplanation}
                        </p>
                      </div>
                    </div>
                  </div>
                </div>
              </section>
            </div>

            {/* 추가 검증이 필요한 사항 */}
            <section
              aria-labelledby="next-steps-heading"
              className="rounded-2xl border border-slate-200 bg-white p-6 space-y-4"
            >
              <div>
                <h2 id="next-steps-heading" className="text-lg font-bold text-slate-950">
                  직접 더 확인해 볼 점
                </h2>
                <p className="mt-1 text-xs text-slate-500">
                  분석 결과를 바탕으로 아래 순서대로 한 번만 더 확인해 보면 좋아요.
                </p>
              </div>

              <ol className="space-y-2.5 pt-1">
                {report.additionalVerificationSteps.map((step, index) => (
                  <li key={index} className="flex items-start gap-3 text-sm text-slate-700">
                    <span className="font-mono text-xs font-semibold text-slate-500 tabular-nums mt-0.5">
                      {String(index + 1).padStart(2, '0')}.
                    </span>
                    <span className="leading-relaxed">{step}</span>
                  </li>
                ))}
              </ol>
            </section>
          </div>
        )}
      </section>
    </div>
  );
};
