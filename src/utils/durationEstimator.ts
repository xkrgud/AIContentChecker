import type { AnalysisStageId } from '../types/analysis.ts';

export const RECENT_DURATIONS_STORAGE_KEY = 'ai_content_checker_recent_durations_v1';
export const MAX_RECENT_DURATIONS = 5;

export const STAGE_BASE_SECONDS: Record<AnalysisStageId, number> = {
  loading_video: 2,
  analyzing_content: 7,
  fact_checking: 5,
};

export interface EstimateAnalysisParams {
  hasDirectVideo: boolean;
  videoDurationSeconds?: number | null;
  recentDurations?: number[];
}

export function loadRecentAnalysisDurations(storage?: Pick<Storage, 'getItem'> | null): number[] {
  const targetStorage =
    storage !== undefined
      ? storage
      : typeof window !== 'undefined'
        ? window.localStorage
        : null;
  if (!targetStorage) return [];

  try {
    const raw = targetStorage.getItem(RECENT_DURATIONS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 600)
      .slice(-MAX_RECENT_DURATIONS);
  } catch {
    return [];
  }
}

export function recordElapsedAnalysisSeconds(
  elapsedSeconds: number,
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
): number[] {
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) {
    return loadRecentAnalysisDurations(storage);
  }

  const targetStorage =
    storage !== undefined
      ? storage
      : typeof window !== 'undefined'
        ? window.localStorage
        : null;

  const existing = loadRecentAnalysisDurations(targetStorage);
  const rounded = Math.max(1, Math.round(elapsedSeconds));
  const updated = [...existing, rounded].slice(-MAX_RECENT_DURATIONS);

  if (targetStorage) {
    try {
      targetStorage.setItem(RECENT_DURATIONS_STORAGE_KEY, JSON.stringify(updated));
    } catch {
      // Ignore storage quota errors
    }
  }
  return updated;
}

export function calculateBaseEstimateSeconds(params: {
  hasDirectVideo: boolean;
  videoDurationSeconds?: number | null;
}): number {
  const stageSum =
    STAGE_BASE_SECONDS.loading_video +
    STAGE_BASE_SECONDS.analyzing_content +
    STAGE_BASE_SECONDS.fact_checking +
    (params.hasDirectVideo ? 2 : 0);

  const duration =
    typeof params.videoDurationSeconds === 'number' &&
    Number.isFinite(params.videoDurationSeconds) &&
    params.videoDurationSeconds > 0
      ? Math.min(300, params.videoDurationSeconds)
      : 0;

  // Add proportional processing overhead based on video length (~0.12s per second of video)
  const durationOverhead = duration > 0 ? Math.round(duration * 0.12) : 0;

  return Math.max(8, stageSum + durationOverhead);
}

export function estimateAnalysisSeconds(params: EstimateAnalysisParams): number {
  const ruleEstimate = calculateBaseEstimateSeconds({
    hasDirectVideo: params.hasDirectVideo,
    videoDurationSeconds: params.videoDurationSeconds,
  });

  const history = Array.isArray(params.recentDurations)
    ? params.recentDurations.filter((n) => typeof n === 'number' && Number.isFinite(n) && n > 0)
    : [];

  if (history.length === 0) {
    return ruleEstimate;
  }

  const avgRecent = history.reduce((sum, n) => sum + n, 0) / history.length;
  // Smoothly increase weight on recent real timings as we collect up to 5 samples (max 60% weight)
  const historyWeight = Math.min(0.6, history.length * 0.12);
  const blended = ruleEstimate * (1 - historyWeight) + avgRecent * historyWeight;

  return Math.max(5, Math.round(blended));
}

export function formatEstimatedRemainingMessage(remainingSeconds: number): string {
  if (!Number.isFinite(remainingSeconds) || remainingSeconds <= 0) {
    return '거의 다 됐어요, 조금만 기다려 주세요';
  }
  return `약 ${Math.ceil(remainingSeconds)}초 소요 예상`;
}
