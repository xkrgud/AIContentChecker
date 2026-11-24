import React, { useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { AnalysisReport } from '../types/analysis';
import {
  calculateChecklistProgress,
  calculateReliabilityScore,
  determineOverallStatusFromScore,
  getOverallStatusMeta,
} from '../utils/analysisHelpers';
import { getPlatformLabel } from '../utils/urlParser';

interface HistoryViewProps {
  reports: AnalysisReport[];
  onSelectReport: (report: AnalysisReport) => void;
  onDeleteReport: (id: string) => void;
  onStartNew: () => void;
}

export const HistoryView: React.FC<HistoryViewProps> = ({
  reports,
  onSelectReport,
  onDeleteReport,
  onStartNew,
}) => {
  const [searchTerm, setSearchTerm] = useState('');

  const filtered = reports.filter((r) => {
    const q = searchTerm.trim().toLowerCase();
    if (!q) return true;
    return (
      r.contentTitle.toLowerCase().includes(q) ||
      r.inputSummary.toLowerCase().includes(q) ||
      (r.sourceUrl?.toLowerCase().includes(q) ?? false)
    );
  });

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 sm:py-10 space-y-6">
      <div className="flex flex-col gap-4 border-b border-slate-200 pb-6 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-xs font-medium text-slate-500">브라우저 로컬 저장 기록</p>
          <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-slate-950 sm:text-3xl">
            이전 콘텐츠 분석 기록
          </h1>
          <p className="mt-1.5 text-sm text-slate-600">
            최근 분석한 콘텐츠와 체크리스트 진행 상태를 다시 열어볼 수 있습니다.
          </p>
        </div>

        <button
          type="button"
          onClick={onStartNew}
          className="rounded-lg bg-blue-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-800 whitespace-nowrap shrink-0 cursor-pointer"
        >
          새 콘텐츠 분석
        </button>
      </div>

      {reports.length === 0 ? (
        <div className="rounded-2xl border border-slate-200 bg-white p-10 text-center space-y-3">
          <p className="text-base font-semibold text-slate-900">저장된 분석 기록이 아직 없습니다</p>
          <p className="text-sm text-slate-600">
            영상 링크를 입력해 첫 번째 신뢰도 분석을 시작해 보세요.
          </p>
          <div className="pt-2">
            <button
              type="button"
              onClick={onStartNew}
              className="rounded-lg border border-slate-300 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-900 hover:bg-slate-100 cursor-pointer"
            >
              분석 입력 화면으로 가기
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <label htmlFor="history-search" className="sr-only">
              분석 기록 검색
            </label>
            <input
              id="history-search"
              type="search"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="제목, 요약 내용, URL로 기록 검색..."
              className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:outline-none"
            />
          </div>

          <div className="rounded-2xl border border-slate-200 bg-white divide-y divide-slate-100">
            {filtered.length === 0 ? (
              <p className="p-6 text-sm text-slate-600">검색어와 일치하는 기록이 없습니다.</p>
            ) : (
              filtered.map((item) => {
                const breakdown =
                  item.scoreBreakdown ??
                  calculateReliabilityScore({
                    checklist: item.checklist,
                    exaggeratedCount: item.exaggeratedExpressions.length,
                    aiLikelihoodLevel: item.aiGenerationAssessment.likelihoodLevel,
                  });
                const score = item.reliabilityScore ?? breakdown.totalScore;
                const statusMeta = getOverallStatusMeta(determineOverallStatusFromScore(score));
                const progress = calculateChecklistProgress(item.checklist);
                const dateLabel = new Date(item.createdAt).toLocaleString('ko-KR', {
                  month: '2-digit',
                  day: '2-digit',
                  hour: '2-digit',
                  minute: '2-digit',
                });

                return (
                  <div
                    key={item.id}
                    className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <button
                      type="button"
                      onClick={() => onSelectReport(item)}
                      className="text-left flex-1 min-w-0 space-y-1 cursor-pointer group"
                    >
                      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500 font-mono tabular-nums">
                        <span className="font-bold text-slate-950">신뢰 {score}점</span>
                        <span aria-hidden="true">·</span>
                        <span className={`font-sans font-semibold ${statusMeta.badgeTextClass}`}>
                          {statusMeta.label}
                        </span>
                        {item.aiSuspicion && (
                          <>
                            <span aria-hidden="true">·</span>
                            <span className="font-sans text-slate-700">
                              {item.aiSuspicion.score != null
                                ? `AI 의심 ${item.aiSuspicion.score}점`
                                : 'AI 의심 판별 불가'}
                            </span>
                          </>
                        )}
                        <span aria-hidden="true">·</span>
                        <span>
                          {item.inputMode === 'url'
                            ? getPlatformLabel(item.platform)
                            : item.inputMode === 'image'
                              ? '이미지'
                              : '텍스트'}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{dateLabel}</span>
                        <span aria-hidden="true">·</span>
                        <span>
                          AI 점검 {progress.passed}/{progress.total} 충족
                        </span>
                      </div>
                      <p className="text-base font-semibold text-slate-950 group-hover:text-blue-700 truncate">
                        {item.contentTitle}
                      </p>
                      <p className="text-xs text-slate-600 line-clamp-1">{item.inputSummary}</p>
                    </button>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => onSelectReport(item)}
                        className="rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-800 hover:bg-slate-50 whitespace-nowrap cursor-pointer"
                      >
                        결과 열기
                      </button>
                      <button
                        type="button"
                        onClick={() => onDeleteReport(item.id)}
                        aria-label={`'${item.contentTitle}' 기록 삭제`}
                        className="rounded-lg border border-slate-200 p-2 text-slate-500 hover:bg-rose-50 hover:text-rose-700 cursor-pointer"
                      >
                        <Trash2 className="h-4 w-4" aria-hidden="true" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
};
