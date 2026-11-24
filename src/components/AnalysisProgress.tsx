import React from 'react';
import { CheckCircle2, Clock, Loader2 } from 'lucide-react';
import type { AnalysisStageId } from '../types/analysis';
import { formatEstimatedRemainingMessage } from '../utils/durationEstimator';

interface AnalysisProgressProps {
  contentLabel: string;
  currentStage: AnalysisStageId;
  remainingSeconds: number;
  onCancel: () => void;
}

const PIPELINE_STEPS: Array<{
  id: AnalysisStageId;
  title: string;
  description: string;
}> = [
  {
    id: 'loading_video',
    title: '01. 영상 불러오기',
    description: '영상 링크 정보 또는 업로드된 영상 파일과 기본 정보를 준비합니다.',
  },
  {
    id: 'analyzing_content',
    title: '02. 내용 · AI 단서 분석',
    description: '핵심 주장·수치·근거 구조와 AI 생성·합성 단서를 한 번에 점검합니다.',
  },
  {
    id: 'fact_checking',
    title: '03. 사실 확인 · 결과 정리',
    description: '핵심 주장(최대 3개)을 Google 검색으로 확인하고 판정 결과를 요약에 정리합니다.',
  },
];

export const AnalysisProgress: React.FC<AnalysisProgressProps> = ({
  contentLabel,
  currentStage,
  remainingSeconds,
  onCancel,
}) => {
  const activeIndex = Math.max(
    0,
    PIPELINE_STEPS.findIndex((step) => step.id === currentStage)
  );
  const etaText = formatEstimatedRemainingMessage(remainingSeconds);

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6">
      <div
        aria-live="polite"
        className="rounded-2xl border border-slate-200 bg-white p-6 sm:p-8"
      >
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2.5">
              <p className="text-xs font-medium text-blue-700">AI 신뢰도 분석 진행 중</p>
              <span
                data-testid="estimated-remaining-time"
                className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-2.5 py-0.5 text-xs font-semibold text-blue-900 font-mono tabular-nums"
              >
                <Clock className="h-3.5 w-3.5 text-blue-700 shrink-0" aria-hidden="true" />
                {etaText}
              </span>
            </div>
            <h2 className="mt-2 text-xl font-bold text-slate-950 sm:text-2xl">
              콘텐츠의 주장과 근거 구조를 점검하고 있습니다
            </h2>
            <p className="mt-1 text-sm text-slate-600 truncate max-w-xl">{contentLabel}</p>
          </div>
          <Loader2 className="h-6 w-6 animate-spin text-blue-700 shrink-0" aria-hidden="true" />
        </div>

        <ol className="mt-8 space-y-4">
          {PIPELINE_STEPS.map((step, index) => {
            const isCompleted = index < activeIndex;
            const isCurrent = index === activeIndex;

            return (
              <li
                key={step.id}
                data-stage-id={step.id}
                data-stage-status={isCompleted ? 'completed' : isCurrent ? 'current' : 'pending'}
                className={`flex items-start gap-3.5 rounded-xl border p-4 transition-colors ${
                  isCurrent
                    ? 'border-blue-200 bg-blue-50/70'
                    : isCompleted
                      ? 'border-emerald-200 bg-emerald-50/40'
                      : 'border-slate-200 bg-slate-50/50'
                }`}
              >
                <div className="mt-0.5 shrink-0">
                  {isCompleted ? (
                    <CheckCircle2 className="h-5 w-5 text-emerald-700" aria-hidden="true" />
                  ) : isCurrent ? (
                    <Loader2 className="h-5 w-5 animate-spin text-blue-700" aria-hidden="true" />
                  ) : (
                    <span className="flex h-5 w-5 items-center justify-center rounded-full border border-slate-300 text-xs font-mono text-slate-500 tabular-nums">
                      {index + 1}
                    </span>
                  )}
                </div>
                <div>
                  <p
                    className={`text-sm font-semibold ${
                      isCurrent || isCompleted ? 'text-slate-950' : 'text-slate-500'
                    }`}
                  >
                    {step.title}
                  </p>
                  <p className="mt-0.5 text-xs leading-relaxed text-slate-600">
                    {step.description}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>

        <div className="mt-6 flex justify-end border-t border-slate-100 pt-4">
          <button
            type="button"
            onClick={onCancel}
            className="rounded-lg border border-slate-300 px-4 py-2 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
          >
            분석 취소
          </button>
        </div>
      </div>
    </div>
  );
};
