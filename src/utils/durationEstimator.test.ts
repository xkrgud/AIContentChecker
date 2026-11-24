import test from 'node:test';
import assert from 'node:assert/strict';
import {
  calculateBaseEstimateSeconds,
  estimateAnalysisSeconds,
  formatEstimatedRemainingMessage,
  loadRecentAnalysisDurations,
  MAX_RECENT_DURATIONS,
  RECENT_DURATIONS_STORAGE_KEY,
  recordElapsedAnalysisSeconds,
} from './durationEstimator.ts';

function createMemoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

test('calculateBaseEstimateSeconds sums stages and scales proportionally with video duration', () => {
  const textOnly = calculateBaseEstimateSeconds({ hasDirectVideo: false });
  const shortVideo = calculateBaseEstimateSeconds({ hasDirectVideo: true, videoDurationSeconds: 15 });
  const longVideo = calculateBaseEstimateSeconds({ hasDirectVideo: true, videoDurationSeconds: 180 });

  assert.equal(textOnly, 14);
  assert.ok(shortVideo > textOnly);
  assert.ok(longVideo > shortVideo);
});

test('recordElapsedAnalysisSeconds keeps only the latest 5 durations in storage and blends estimate', () => {
  const storage = createMemoryStorage();

  [10, 12, 14, 20, 30, 40].forEach((sec) => {
    recordElapsedAnalysisSeconds(sec, storage);
  });

  const saved = loadRecentAnalysisDurations(storage);
  assert.equal(saved.length, MAX_RECENT_DURATIONS);
  assert.deepEqual(saved, [12, 14, 20, 30, 40]);

  const rawSaved = storage.getItem(RECENT_DURATIONS_STORAGE_KEY);
  assert.ok(rawSaved);

  const withoutHistory = estimateAnalysisSeconds({
    hasDirectVideo: true,
    videoDurationSeconds: 10,
    recentDurations: [],
  });
  const withSlowerHistory = estimateAnalysisSeconds({
    hasDirectVideo: true,
    videoDurationSeconds: 10,
    recentDurations: [45, 45, 45, 45, 45],
  });

  assert.ok(withSlowerHistory > withoutHistory);
});

test('formatEstimatedRemainingMessage displays countdown above 0 and friendly message at <= 0', () => {
  assert.equal(formatEstimatedRemainingMessage(18), '약 18초 소요 예상');
  assert.equal(formatEstimatedRemainingMessage(1), '약 1초 소요 예상');
  assert.equal(formatEstimatedRemainingMessage(0), '거의 다 됐어요, 조금만 기다려 주세요');
  assert.equal(formatEstimatedRemainingMessage(-5), '거의 다 됐어요, 조금만 기다려 주세요');
});
