import { useEffect, useRef, useState } from 'react';
import { Header, type ActiveTab } from './components/Header';
import { InputWorkbench } from './components/InputWorkbench';
import { AnalysisProgress } from './components/AnalysisProgress';
import { AnalysisReportView } from './components/AnalysisReportView';
import { ChecklistView } from './components/ChecklistView';
import { ShareGuideView } from './components/ShareGuideView';
import { HistoryView } from './components/HistoryView';
import type {
  AnalysisReport,
  AnalysisStageId,
  C2paMetadataSummary,
  ChecklistItem,
  PlatformType,
  UrlInspectionResult,
  VideoCompressionSummary,
} from './types/analysis';
import { buildDefaultChecklist } from './utils/analysisHelpers';
import { extractC2paMetadataInBrowser } from './utils/c2paReader';
import { getOrCreateBrowserClientId } from './utils/clientIdentity';
import {
  estimateAnalysisSeconds,
  loadRecentAnalysisDurations,
  recordElapsedAnalysisSeconds,
} from './utils/durationEstimator';
import {
  extractErrorMessageFromBody,
  mapHttpStatusToFriendlyError,
  readSafeJsonResponse,
} from './utils/httpResponse';
import { consumeSharedMediaRecord } from './utils/shareStorage';
import { extractShareTargetParams, validateAndNormalizeUrl } from './utils/urlParser';
import { prepareVideoForCloudRunUpload, probeVideoFileInBrowser } from './utils/videoCompressor';
import {
  canStartUrlScreenAnalysis,
  shouldCompressVideo,
  validateVideoFileMeta,
} from './utils/videoUpload';

const HISTORY_STORAGE_KEY = 'ai_content_checker_history_v1';

function loadSavedHistory(): AnalysisReport[] {
  try {
    const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AnalysisReport[]) : [];
  } catch {
    return [];
  }
}

export default function App() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('analyze');
  const [urlInput, setUrlInput] = useState('');
  const [shortVideoNormalizedUrl, setShortVideoNormalizedUrl] = useState<string | null>(null);
  const [contentTitle, setContentTitle] = useState('');
  const [transcriptInput, setTranscriptInput] = useState('');
  const [uploadedVideoFile, setUploadedVideoFile] = useState<File | null>(null);
  const [uploadedVideoDuration, setUploadedVideoDuration] = useState<number | null>(null);
  const [isCompressingVideo, setIsCompressingVideo] = useState(false);
  const [compressionProgress, setCompressionProgress] = useState(0);
  const [compressingFileName, setCompressingFileName] = useState<string | null>(null);
  const [compressionSummary, setCompressionSummary] = useState<VideoCompressionSummary | null>(null);
  const [c2paMetadata, setC2paMetadata] = useState<C2paMetadataSummary | null>(null);

  const [inspectionResult, setInspectionResult] = useState<UrlInspectionResult | null>(null);

  const [sharedNotice, setSharedNotice] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [currentStage, setCurrentStage] = useState<AnalysisStageId>('loading_video');
  const [estimatedRemainingSeconds, setEstimatedRemainingSeconds] = useState<number>(0);

  const [currentReport, setCurrentReport] = useState<AnalysisReport | null>(null);
  const [standaloneChecklist] = useState<ChecklistItem[]>(() => buildDefaultChecklist([]));
  const [history, setHistory] = useState<AnalysisReport[]>(() => loadSavedHistory());

  const analyzeAbortRef = useRef<AbortController | null>(null);
  const activeRequestIdRef = useRef<number>(0);
  const compressionAbortRef = useRef<AbortController | null>(null);
  const compressionRunIdRef = useRef<number>(0);
  const etaIntervalRef = useRef<number | null>(null);

  useEffect(() => {
    try {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(0, 20)));
    } catch {
      // Ignore storage quota errors
    }
  }, [history]);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => undefined);
    }
  }, []);

  const clearEtaInterval = () => {
    if (etaIntervalRef.current !== null) {
      window.clearInterval(etaIntervalRef.current);
      etaIntervalRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      clearEtaInterval();
      analyzeAbortRef.current?.abort();
      compressionAbortRef.current?.abort();
    };
  }, []);

  const handleCancelCompression = () => {
    compressionRunIdRef.current += 1;
    if (compressionAbortRef.current) {
      compressionAbortRef.current.abort();
      compressionAbortRef.current = null;
    }
    setIsCompressingVideo(false);
    setCompressionProgress(0);
    setCompressingFileName(null);
  };

  const handleVideoFileSelected = async (rawFile: File | null) => {
    handleCancelCompression();
    setUploadedVideoFile(null);
    setUploadedVideoDuration(null);
    setCompressionSummary(null);
    setC2paMetadata(null);

    if (!rawFile) {
      return;
    }

    const validation = validateVideoFileMeta(rawFile);
    if (!validation.valid) {
      setErrorMessage(validation.error || '지원되는 영상 파일(mp4, mov)을 선택해 주세요.');
      return;
    }

    setErrorMessage(null);
    const runId = ++compressionRunIdRef.current;
    const needsCompression = shouldCompressVideo(rawFile.size);
    const controller = new AbortController();
    compressionAbortRef.current = controller;

    if (needsCompression) {
      setIsCompressingVideo(true);
      setCompressionProgress(1);
      setCompressingFileName(rawFile.name);
    }

    try {
      // Read duration and original C2PA credentials BEFORE WebCodecs re-encoding removes them
      const [probe, extractedC2pa] = await Promise.all([
        probeVideoFileInBrowser(rawFile),
        extractC2paMetadataInBrowser(rawFile).catch(() => null),
      ]);

      if (controller.signal.aborted || runId !== compressionRunIdRef.current) {
        return;
      }

      const prepared = await prepareVideoForCloudRunUpload(rawFile, {
        durationHintSeconds: probe.durationSeconds,
        onProgress: (pct) => {
          if (runId === compressionRunIdRef.current) {
            setCompressionProgress(pct);
          }
        },
        signal: controller.signal,
      });

      if (controller.signal.aborted || runId !== compressionRunIdRef.current) {
        return;
      }

      setUploadedVideoFile(prepared.file);
      setCompressionSummary(prepared.summary);
      setUploadedVideoDuration(prepared.summary.durationSeconds ?? probe.durationSeconds);
      setC2paMetadata(extractedC2pa);
    } catch (err) {
      if (
        (err instanceof DOMException && err.name === 'AbortError') ||
        controller.signal.aborted ||
        runId !== compressionRunIdRef.current
      ) {
        return;
      }
      setErrorMessage(
        err instanceof Error
          ? err.message
          : '영상이 너무 커요. 앞뒤를 잘라 짧게 만든 뒤 다시 올려 주세요'
      );
      setUploadedVideoFile(null);
      setCompressionSummary(null);
      setC2paMetadata(null);
    } finally {
      if (compressionAbortRef.current === controller) {
        compressionAbortRef.current = null;
      }
      if (runId === compressionRunIdRef.current) {
        setIsCompressingVideo(false);
        setCompressionProgress(0);
        setCompressingFileName(null);
      }
    }
  };

  const applySharedUrl = async (
    sharedUrl: string,
    sharedTitle?: string,
    sharedText?: string,
    sharedFileNotice?: string
  ) => {
    setActiveTab('analyze');
    setCurrentReport(null);
    setUrlInput(sharedUrl);
    if (sharedTitle) setContentTitle(sharedTitle);
    if (sharedText && sharedText !== sharedUrl) {
      setTranscriptInput(sharedText);
    }

    const validation = validateAndNormalizeUrl(sharedUrl);
    if (!validation.valid || !validation.normalizedUrl) {
      setSharedNotice(
        sharedFileNotice ||
          '외부 앱에서 공유 데이터가 전달되었으나 유효한 링크 형식을 찾지 못했습니다. 링크를 확인해 주세요.'
      );
      return;
    }

    setUrlInput(validation.normalizedUrl);
    setShortVideoNormalizedUrl(validation.isShortVideo ? validation.normalizedUrl : null);
    setSharedNotice(
      sharedFileNotice
        ? `${sharedFileNotice} 공유된 링크(${validation.normalizedUrl})도 함께 입력창에 등록했습니다.`
        : `공유된 링크(${validation.normalizedUrl})를 입력창에 자동 등록했습니다.`
    );

    try {
      const res = await fetch('/api/inspect-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: validation.normalizedUrl }),
      });
      const parsedInspect = await readSafeJsonResponse<UrlInspectionResult>(res, 'inspect');
      if (parsedInspect.ok) {
        const data = parsedInspect.data;
        setInspectionResult(data);
        if (data.title && !sharedTitle) setContentTitle(data.title);
        if (data.transcriptText) {
          setTranscriptInput(data.transcriptText);
        } else if (data.descriptionText && !sharedText) {
          setTranscriptInput(data.descriptionText);
        }
      }
    } catch {
      // Keep registered URL even if metadata inspection fails
    }
  };

  useEffect(() => {
    let cancelled = false;

    const handleInitialShareParams = async () => {
      const searchParams = new URLSearchParams(window.location.search);
      const shareId = searchParams.get('shareId')?.trim() || undefined;
      const shared = extractShareTargetParams(window.location.search);

      let idbPayload = null;
      if (shareId) {
        idbPayload = await consumeSharedMediaRecord(shareId);
      }

      if (cancelled) return;

      const resolvedUrl = idbPayload?.url || shared.url;
      const resolvedTitle = idbPayload?.title || shared.title;
      const resolvedText = idbPayload?.text || shared.text;

      let fileNotice: string | undefined;
      if (idbPayload?.file) {
        const fileCheck = validateVideoFileMeta(idbPayload.file);
        if (fileCheck.valid) {
          setActiveTab('analyze');
          setCurrentReport(null);
          void handleVideoFileSelected(idbPayload.file);
          fileNotice = `공유된 영상 파일(${idbPayload.file.name})을 업로드 칸에 바로 등록했습니다.`;
        } else {
          setErrorMessage(
            fileCheck.error || '공유된 영상 파일 형식이 지원되지 않습니다. MP4·MOV 파일을 사용해 주세요.'
          );
        }
      }

      if (resolvedUrl) {
        await applySharedUrl(resolvedUrl, resolvedTitle, resolvedText, fileNotice);
      } else if (fileNotice) {
        if (resolvedTitle) setContentTitle(resolvedTitle);
        if (resolvedText) setTranscriptInput(resolvedText);
        setSharedNotice(
          `${fileNotice} 바로 '신뢰도 분석 시작'을 누르거나 추가 링크·메모를 적을 수 있어요.`
        );
      } else if (shared.hasSharedParams && (resolvedText || resolvedTitle)) {
        if (resolvedTitle) setContentTitle(resolvedTitle);
        if (resolvedText) setTranscriptInput(resolvedText);
        setSharedNotice(
          '외부 앱에서 전달된 내용을 영상 자막·메모 입력창에 등록했습니다. 영상 링크를 입력해 주세요.'
        );
      }

      if ((shareId || shared.hasSharedParams) && window.history?.replaceState) {
        window.history.replaceState({}, document.title, window.location.pathname);
      }
    };

    void handleInitialShareParams();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleSimulateVideoShare = () => {
    // Minimal valid-header MP4 blob for gallery video share target preview
    const sampleMp4Bytes = new Uint8Array([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
      0x00, 0x00, 0x00, 0x00, 0x6d, 0x70, 0x34, 0x32, 0x69, 0x73, 0x6f, 0x6d,
    ]);
    const sampleFile = new File([sampleMp4Bytes], 'gallery-shared-reel.mp4', {
      type: 'video/mp4',
    });
    setActiveTab('analyze');
    setCurrentReport(null);
    setErrorMessage(null);
    void handleVideoFileSelected(sampleFile);
    setSharedNotice(
      `안드로이드 갤러리 공유 시뮬레이션으로 영상(${sampleFile.name})이 업로드 칸에 등록되었습니다.`
    );
  };

  const handleCancelAnalysis = () => {
    activeRequestIdRef.current += 1;
    clearEtaInterval();
    if (analyzeAbortRef.current) {
      analyzeAbortRef.current.abort();
      analyzeAbortRef.current = null;
    }
    setIsAnalyzing(false);
    setCurrentStage('loading_video');
    setErrorMessage(null);
  };

  const handleStartAnalysis = async () => {
    if (isCompressingVideo) return;
    setErrorMessage(null);

    const gate = canStartUrlScreenAnalysis({
      urlInput,
      hasUploadedVideo: Boolean(uploadedVideoFile),
      transcriptInput,
    });
    if (!gate.allowed) {
      setErrorMessage(gate.error || '분석할 영상 링크 또는 영상 파일을 확인해 주세요.');
      return;
    }

    const trimmedUrl = urlInput.trim();
    let normalizedUrl: string | undefined;
    let detectedPlatform: PlatformType = 'web';
    let isShortVideo = true;

    if (trimmedUrl) {
      const validation = validateAndNormalizeUrl(trimmedUrl);
      if (!validation.valid || !validation.normalizedUrl || !validation.platform) {
        setErrorMessage(validation.error || '올바른 영상 또는 게시물 링크를 입력해 주세요.');
        return;
      }
      normalizedUrl = validation.normalizedUrl;
      detectedPlatform = validation.platform;
      isShortVideo = Boolean(
        validation.isShortVideo ||
          shortVideoNormalizedUrl === normalizedUrl ||
          detectedPlatform === 'instagram'
      );
      if (isShortVideo) {
        setShortVideoNormalizedUrl(normalizedUrl);
      }
      setUrlInput(normalizedUrl);
    }

    if (uploadedVideoFile) {
      const fileCheck = validateVideoFileMeta(uploadedVideoFile);
      if (!fileCheck.valid) {
        setErrorMessage(fileCheck.error || '지원되는 영상 파일(mp4, mov)을 선택해 주세요.');
        return;
      }
    }

    // Abort any previous in-flight analysis before starting a new one
    if (analyzeAbortRef.current) {
      analyzeAbortRef.current.abort();
    }
    clearEtaInterval();

    const controller = new AbortController();
    analyzeAbortRef.current = controller;
    const requestId = ++activeRequestIdRef.current;

    const recentDurations = loadRecentAnalysisDurations();
    const hasInitialDirectVideo = Boolean(
      uploadedVideoFile || (normalizedUrl && detectedPlatform === 'youtube')
    );
    const initialEtaSeconds = estimateAnalysisSeconds({
      hasDirectVideo: hasInitialDirectVideo,
      videoDurationSeconds: uploadedVideoDuration,
      recentDurations,
    });

    const startedAtMs = Date.now();
    setCurrentStage('loading_video');
    setEstimatedRemainingSeconds(initialEtaSeconds);
    setIsAnalyzing(true);

    etaIntervalRef.current = window.setInterval(() => {
      setEstimatedRemainingSeconds((prev) => Math.max(0, prev - 1));
    }, 1000);

    try {
      let response: Response;
      const effectiveTitle = contentTitle.trim() || inspectionResult?.title || '';
      const effectiveNotes = transcriptInput.trim();
      const browserClientId = getOrCreateBrowserClientId();

      if (uploadedVideoFile) {
        const formData = new FormData();
        formData.append('videoFile', uploadedVideoFile);
        formData.append('inputMode', 'url');
        if (normalizedUrl) {
          formData.append('sourceUrl', normalizedUrl);
          formData.append('platform', detectedPlatform);
        }
        formData.append('isShortVideo', String(isShortVideo));
        if (effectiveTitle) {
          formData.append('contentTitle', effectiveTitle);
        }
        if (effectiveNotes) {
          formData.append('transcriptOrNotes', effectiveNotes);
        }
        if (uploadedVideoDuration != null && Number.isFinite(uploadedVideoDuration)) {
          formData.append('videoDurationSeconds', String(Math.round(uploadedVideoDuration)));
        }
        if (c2paMetadata) {
          formData.append('c2paMetadata', JSON.stringify(c2paMetadata));
        }
        if (compressionSummary) {
          formData.append('compressionSummary', JSON.stringify(compressionSummary));
        }

        response = await fetch('/api/analyze', {
          method: 'POST',
          headers: {
            Accept: 'application/x-ndjson',
            'X-Client-Id': browserClientId,
          },
          signal: controller.signal,
          body: formData,
        });
      } else {
        response = await fetch('/api/analyze', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/x-ndjson',
            'X-Client-Id': browserClientId,
          },
          signal: controller.signal,
          body: JSON.stringify({
            inputMode: 'url',
            sourceUrl: normalizedUrl,
            platform: detectedPlatform,
            isShortVideo,
            contentTitle: effectiveTitle || undefined,
            transcriptOrNotes: effectiveNotes || undefined,
            videoDurationSeconds:
              uploadedVideoDuration != null ? Math.round(uploadedVideoDuration) : undefined,
            c2paMetadata: c2paMetadata || undefined,
            compressionSummary: compressionSummary || undefined,
          }),
        });
      }

      if (controller.signal.aborted || requestId !== activeRequestIdRef.current) {
        return;
      }

      if (!response.ok) {
        const errorBodyText = await response.text().catch(() => '');
        setErrorMessage(extractErrorMessageFromBody(errorBodyText, response.status, 'analyze'));
        return;
      }

      const contentType = response.headers.get('content-type') || '';
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let finalPayload: any = null;

      if (contentType.includes('application/x-ndjson') && response.body) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        const handleStreamLine = (line: string) => {
          const trimmed = line.trim();
          if (!trimmed) return;
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let event: any;
          try {
            event = JSON.parse(trimmed);
          } catch {
            return;
          }

          if (event.type === 'progress' && event.stage) {
            setCurrentStage(event.stage as AnalysisStageId);
          } else if (event.type === 'meta') {
            const elapsedSec = Math.floor((Date.now() - startedAtMs) / 1000);
            const updatedTotal = estimateAnalysisSeconds({
              hasDirectVideo: Boolean(event.hasDirectVideo ?? hasInitialDirectVideo),
              videoDurationSeconds:
                typeof event.videoDurationSeconds === 'number'
                  ? event.videoDurationSeconds
                  : uploadedVideoDuration,
              recentDurations,
            });
            setEstimatedRemainingSeconds(Math.max(0, updatedTotal - elapsedSec));
          } else if (event.type === 'result' && event.data) {
            finalPayload = event.data;
          } else if (event.type === 'error') {
            throw new Error(event.error || '콘텐츠 분석 중 오류가 발생했습니다.');
          }
        };

        while (true) {
          const { value, done } = await reader.read();
          if (controller.signal.aborted || requestId !== activeRequestIdRef.current) {
            await reader.cancel().catch(() => undefined);
            return;
          }
          if (value) {
            buffer += decoder.decode(value, { stream: !done });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
              handleStreamLine(line);
            }
          }
          if (done) {
            if (buffer.trim()) {
              handleStreamLine(buffer);
            }
            break;
          }
        }
      } else {
        const parsedJson = await readSafeJsonResponse(response, 'analyze');
        if (!parsedJson.ok) {
          setErrorMessage(parsedJson.error);
          return;
        }
        finalPayload = parsedJson.data;
      }

      if (controller.signal.aborted || requestId !== activeRequestIdRef.current) {
        return;
      }

      if (!finalPayload) {
        setErrorMessage('분석 결과를 전달받지 못했습니다. 잠시 후 다시 시도해 주세요.');
        return;
      }

      const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAtMs) / 1000));
      recordElapsedAnalysisSeconds(elapsedSeconds);

      const checklist: ChecklistItem[] = Array.isArray(finalPayload.checklist)
        ? finalPayload.checklist
        : buildDefaultChecklist(finalPayload.coreClaims || []);

      const report: AnalysisReport = {
        id: `rep-${Date.now()}`,
        createdAt: new Date().toISOString(),
        inputMode: 'url',
        sourceUrl: finalPayload.normalizedUrl || normalizedUrl,
        platform: finalPayload.platform || detectedPlatform,
        contentTitle: finalPayload.contentTitle,
        analyzedVideoInfo: finalPayload.analyzedVideoInfo,
        inputSummary: finalPayload.inputSummary,
        extractedImageText: finalPayload.extractedImageText,
        reliabilityScore: finalPayload.reliabilityScore,
        scoreBreakdown: finalPayload.scoreBreakdown,
        aiSuspicion: finalPayload.aiSuspicion,
        factCheck: finalPayload.factCheck,
        reorganizedByLatestSearch: Boolean(finalPayload.reorganizedByLatestSearch),
        usedFallbackModel: Boolean(finalPayload.usedFallbackModel),
        c2paMetadata: finalPayload.c2paMetadata ?? c2paMetadata ?? undefined,
        compressionSummary: finalPayload.compressionSummary ?? compressionSummary ?? undefined,
        elapsedSeconds,
        overallStatus: finalPayload.overallStatus,
        overallSummary: finalPayload.overallSummary,
        threeLineSummary: finalPayload.threeLineSummary,
        disclaimer: finalPayload.disclaimer,
        coreClaims: finalPayload.coreClaims,
        exaggeratedExpressions: finalPayload.exaggeratedExpressions,
        sourceAssessment: finalPayload.sourceAssessment,
        aiGenerationAssessment: finalPayload.aiGenerationAssessment,
        additionalVerificationSteps: finalPayload.additionalVerificationSteps,
        checklist,
      };

      setCurrentReport(report);
      setHistory((prev) => [report, ...prev].slice(0, 20));
      setActiveTab('analyze');
    } catch (err) {
      if (
        (err instanceof DOMException && err.name === 'AbortError') ||
        controller.signal.aborted ||
        requestId !== activeRequestIdRef.current
      ) {
        return;
      }
      if (err instanceof SyntaxError) {
        setErrorMessage(mapHttpStatusToFriendlyError(502, 'analyze'));
      } else if (err instanceof TypeError) {
        setErrorMessage('서버와 통신하지 못했습니다. 네트워크 연결 상태를 확인해 주세요.');
      } else {
        setErrorMessage(
          err instanceof Error && err.message
            ? err.message
            : '서버와 통신하지 못했습니다. 네트워크 연결 상태를 확인해 주세요.'
        );
      }
    } finally {
      clearEtaInterval();
      if (analyzeAbortRef.current === controller) {
        analyzeAbortRef.current = null;
      }
      if (requestId === activeRequestIdRef.current) {
        setIsAnalyzing(false);
        setCurrentStage('loading_video');
      }
    }
  };

  const handleResetToNew = () => {
    handleCancelAnalysis();
    handleCancelCompression();
    setCurrentReport(null);
    setUploadedVideoFile(null);
    setUploadedVideoDuration(null);
    setCompressionSummary(null);
    setC2paMetadata(null);
    setErrorMessage(null);
    setActiveTab('analyze');
  };

  const activeChecklistItems = currentReport ? currentReport.checklist : standaloneChecklist;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 text-slate-900">
      <Header
        activeTab={activeTab}
        hasReport={Boolean(currentReport)}
        historyCount={history.length}
        onSelectTab={setActiveTab}
        onResetToNew={handleResetToNew}
      />

      <main className="flex-1">
        {isAnalyzing ? (
          <AnalysisProgress
            contentLabel={
              contentTitle || urlInput || uploadedVideoFile?.name || '영상 콘텐츠'
            }
            currentStage={currentStage}
            remainingSeconds={estimatedRemainingSeconds}
            onCancel={handleCancelAnalysis}
          />
        ) : activeTab === 'analyze' ? (
          currentReport ? (
            <AnalysisReportView
              report={currentReport}
              onOpenChecklist={() => setActiveTab('checklist')}
              onStartNew={handleResetToNew}
            />
          ) : (
            <InputWorkbench
              urlInput={urlInput}
              onChangeUrlInput={setUrlInput}
              contentTitle={contentTitle}
              onChangeContentTitle={setContentTitle}
              transcriptInput={transcriptInput}
              onChangeTranscriptInput={setTranscriptInput}
              uploadedVideoFile={uploadedVideoFile}
              onSelectVideoFile={(file) => {
                void handleVideoFileSelected(file);
              }}
              isCompressingVideo={isCompressingVideo}
              compressionProgress={compressionProgress}
              compressingFileName={compressingFileName}
              compressionSummary={compressionSummary}
              c2paMetadata={c2paMetadata}
              onCancelCompression={handleCancelCompression}
              inspectionResult={inspectionResult}
              onSetInspectionResult={setInspectionResult}
              sharedNotice={sharedNotice}
              onDismissSharedNotice={() => setSharedNotice(null)}
              errorMessage={errorMessage}
              onClearError={() => setErrorMessage(null)}
              onStartAnalysis={handleStartAnalysis}
              isAnalyzing={isAnalyzing}
            />
          )
        ) : activeTab === 'checklist' ? (
          <ChecklistView
            report={currentReport}
            items={activeChecklistItems}
            onBackToReport={() => setActiveTab('analyze')}
            onStartNew={handleResetToNew}
          />
        ) : activeTab === 'history' ? (
          <HistoryView
            reports={history}
            onSelectReport={(rep) => {
              setCurrentReport(rep);
              setActiveTab('analyze');
            }}
            onDeleteReport={(id) => {
              setHistory((prev) => prev.filter((r) => r.id !== id));
              if (currentReport?.id === id) {
                setCurrentReport(null);
              }
            }}
            onStartNew={handleResetToNew}
          />
        ) : (
          <ShareGuideView
            onSimulateShareTarget={(url, title) => {
              void applySharedUrl(url, title);
            }}
            onSimulateVideoShare={handleSimulateVideoShare}
          />
        )}
      </main>

      <footer className="border-t border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-5 text-xs text-slate-500 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <span>AI Content Checker · 미디어 리터러시 지원 분석 도구</span>
          <span>
            AI 분석은 참고 정보이며, 출처 확인과 최종 사실 판단은 사용자가 직접 진행합니다.
          </span>
        </div>
      </footer>
    </div>
  );
}
