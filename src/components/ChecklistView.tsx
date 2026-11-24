import React from 'react';
import { ArrowLeft, CheckCircle2 } from 'lucide-react';
import type { AnalysisReport, ChecklistItem } from '../types/analysis';
import {
  calculateChecklistProgress,
  getChecklistItemScore,
  getChecklistVerdictMeta,
} from '../utils/analysisHelpers';

interface ChecklistViewProps {
  report: AnalysisReport | null;
  items: ChecklistItem[];
  onBackToReport: () => void;
  onStartNew: () => void;
}

export const ChecklistView: React.FC<ChecklistViewProps> = ({
  report,
  items,
  onBackToReport,
  onStartNew,
}) => {
  const progress = calculateChecklistProgress(items);
  const unresolvedItems = items.filter((i) => i.aiVerdict !== '예');

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-10 space-y-6">
      <div className="flex flex-col gap-4 border-b border-slate-200 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium text-slate-500">
            AI 자동 점검 결과 · Reliability Checklist
          </p>
          <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
            콘텐츠 신뢰성 체크리스트
          </h1>
          <p className="mt-1.5 text-sm text-slate-600">
            {report
              ? `대상 콘텐츠: ${report.contentTitle}`
              : '콘텐츠를 분석하면 AI가 아래 신뢰성 검증 항목을 직접 점검하여 점수와 이유를 채워 드립니다.'}
          </p>
        </div>

        <div className="flex items-center gap-2.5 shrink-0">
          {report ? (
            <button
              type="button"
              onClick={onBackToReport}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3.5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <ArrowLeft className="h-4 w-4" aria-hidden="true" />
              분석 결과 보기
            </button>
          ) : (
            <button
              type="button"
              onClick={onStartNew}
              className="rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 whitespace-nowrap shrink-0 cursor-pointer"
            >
              콘텐츠 분석하러 가기
            </button>
          )}
        </div>
      </div>

      {/* AI Evaluation Summary */}
      <div className="rounded-2xl border border-slate-200 bg-white p-6 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-2">
            <CheckCircle2
              className={`h-5 w-5 ${
                progress.passed === progress.total && progress.total > 0
                  ? 'text-emerald-700'
                  : 'text-blue-700'
              }`}
              aria-hidden="true"
            />
            <span className="text-sm font-bold text-slate-950">AI 항목별 신뢰성 점검 요약</span>
          </div>
          <div className="flex items-center gap-3 font-mono text-xs font-semibold tabular-nums">
            <span className="text-emerald-800">충족 {progress.passed}</span>
            <span aria-hidden="true" className="text-slate-300">·</span>
            <span className="text-rose-800">미충족 {progress.failed}</span>
            <span aria-hidden="true" className="text-slate-300">·</span>
            <span className="text-amber-800">확인 필요 {progress.needsCheck}</span>
          </div>
        </div>

        <div
          role="progressbar"
          aria-valuenow={progress.total > 0 ? Math.round((progress.passed / progress.total) * 100) : 0}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="AI 신뢰성 체크리스트 충족 비율"
          className="h-2.5 w-full overflow-hidden rounded-full bg-slate-100"
        >
          <div
            className={`h-full transition-all duration-200 ${
              progress.passed === progress.total && progress.total > 0
                ? 'bg-emerald-600'
                : 'bg-blue-700'
            }`}
            style={{
              width: `${progress.total > 0 ? Math.round((progress.passed / progress.total) * 100) : 0}%`,
            }}
          />
        </div>

        <p className="text-xs text-slate-600">
          {report
            ? `총 ${progress.total}개 항목 중 ${progress.passed}개가 충족되었고, ${unresolvedItems.length}개 항목에서 부족하거나 추가 확인이 필요한 요소가 확인되었어요.`
            : '아직 분석된 콘텐츠가 없어 기본 검증 항목만 표시됩니다.'}
        </p>
      </div>

      {/* Checklist Items */}
      <div className="rounded-2xl border border-slate-200 bg-white divide-y divide-slate-100">
        {items.map((item, idx) => {
          const verdictMeta = getChecklistVerdictMeta(item.aiVerdict);
          const itemScore = item.category === '기본 검증' ? getChecklistItemScore(item.aiVerdict) : null;
          return (
            <div key={item.id} className="p-5 sm:p-6 space-y-2.5">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
                    <span className="font-mono tabular-nums">
                      항목 {String(idx + 1).padStart(2, '0')}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>{item.category}</span>
                    {itemScore !== null && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono font-semibold text-slate-700 tabular-nums">
                          {itemScore}점 / 15점
                        </span>
                      </>
                    )}
                  </div>
                  <p className="text-sm font-semibold leading-snug text-slate-950 sm:text-base">
                    {item.question}
                  </p>
                </div>

                <span
                  className={`inline-flex items-center rounded-md border px-3 py-1 text-xs font-semibold whitespace-nowrap shrink-0 w-fit ${verdictMeta.badgeClass}`}
                >
                  {verdictMeta.label}
                </span>
              </div>

              <div className="rounded-xl border border-slate-200 bg-slate-50 p-3.5 text-sm leading-relaxed text-slate-800">
                <span className="font-semibold text-slate-900">AI 점검 근거: </span>
                <span>{item.aiReason}</span>
              </div>

              <p className="text-xs leading-relaxed text-slate-500">{item.hint}</p>
            </div>
          );
        })}
      </div>

      {report && unresolvedItems.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-slate-50 p-6 space-y-2.5">
          <h2 className="text-sm font-bold text-slate-950">AI가 주의를 권고한 미충족·확인 필요 항목</h2>
          <ul className="list-disc pl-5 space-y-1 text-xs leading-relaxed text-slate-700">
            {unresolvedItems.map((item) => (
              <li key={item.id}>{item.question}</li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
};
