import React, { useRef, useState } from 'react';
import {
  AlertCircle,
  Film,
  Info,
  Link2,
  Loader2,
  Search,
  Share2,
  Upload,
  X,
} from 'lucide-react';
import type {
  C2paMetadataSummary,
  UrlInspectionResult,
  VideoCompressionSummary,
} from '../types/analysis';
import { readSafeJsonResponse } from '../utils/httpResponse';
import { getPlatformLabel, isInstagramUrl, validateAndNormalizeUrl } from '../utils/urlParser';
import { formatFileSizeLabel, validateVideoFileMeta } from '../utils/videoUpload';

interface InputWorkbenchProps {
  urlInput: string;
  onChangeUrlInput: (value: string) => void;
  contentTitle: string;
  onChangeContentTitle: (value: string) => void;
  transcriptInput: string;
  onChangeTranscriptInput: (value: string) => void;
  uploadedVideoFile: File | null;
  onSelectVideoFile: (file: File | null) => void;
  isCompressingVideo?: boolean;
  compressionProgress?: number;
  compressingFileName?: string | null;
  compressionSummary?: VideoCompressionSummary | null;
  c2paMetadata?: C2paMetadataSummary | null;
  onCancelCompression?: () => void;
  inspectionResult: UrlInspectionResult | null;
  onSetInspectionResult: (res: UrlInspectionResult | null) => void;
  sharedNotice: string | null;
  onDismissSharedNotice: () => void;
  errorMessage: string | null;
  onClearError: () => void;
  onStartAnalysis: () => void;
  isAnalyzing: boolean;
}

export const InputWorkbench: React.FC<InputWorkbenchProps> = ({
  urlInput,
  onChangeUrlInput,
  contentTitle,
  onChangeContentTitle,
  transcriptInput,
  onChangeTranscriptInput,
  uploadedVideoFile,
  onSelectVideoFile,
  isCompressingVideo = false,
  compressionProgress = 0,
  compressingFileName = null,
  compressionSummary = null,
  c2paMetadata = null,
  onCancelCompression,
  inspectionResult,
  onSetInspectionResult,
  sharedNotice,
  onDismissSharedNotice,
  errorMessage,
  onClearError,
  onStartAnalysis,
  isAnalyzing,
}) => {
  const [inspectingUrl, setInspectingUrl] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const isInstagramLink =
    isInstagramUrl(urlInput) || inspectionResult?.platform === 'instagram';
  const showInlineVideoUpload =
    isInstagramLink || Boolean(uploadedVideoFile) || isCompressingVideo;

  const handleSelectVideoFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0] ?? null;
    if (!selected) return;

    const validation = validateVideoFileMeta(selected);
    if (!validation.valid) {
      setFileError(validation.error || '지원되는 영상 파일(mp4, mov)을 선택해 주세요.');
      onSelectVideoFile(null);
      e.target.value = '';
      return;
    }

    setFileError(null);
    setUrlError(null);
    onClearError();
    onSelectVideoFile(selected);
    e.target.value = '';
  };

  const handleRemoveUploadedVideo = () => {
    setFileError(null);
    onCancelCompression?.();
    onSelectVideoFile(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleInspectUrl = async (targetUrl?: string) => {
    const candidate = (targetUrl ?? urlInput).trim();
    const validation = validateAndNormalizeUrl(candidate);
    if (!validation.valid || !validation.normalizedUrl) {
      setUrlError(validation.error || '올바른 URL을 입력해 주세요.');
      onSetInspectionResult(null);
      return;
    }

    setUrlError(null);
    onClearError();
    setInspectingUrl(true);

    try {
      const response = await fetch('/api/inspect-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: validation.normalizedUrl }),
      });
      const parsed = await readSafeJsonResponse<UrlInspectionResult>(response, 'inspect');
      if (!parsed.ok) {
        setUrlError(parsed.error);
        onSetInspectionResult(null);
        return;
      }

      const inspected = parsed.data;
      onSetInspectionResult(inspected);
      onChangeUrlInput(inspected.normalizedUrl);

      if (inspected.title && !contentTitle) {
        onChangeContentTitle(inspected.title);
      }
      if (inspected.transcriptText) {
        onChangeTranscriptInput(inspected.transcriptText);
      } else if (inspected.descriptionText && !transcriptInput) {
        onChangeTranscriptInput(inspected.descriptionText);
      }
    } catch {
      setUrlError('네트워크 연결 오류로 링크 정보를 불러오지 못했습니다.');
    } finally {
      setInspectingUrl(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setUrlError(null);
    onStartAnalysis();
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6 sm:py-12">
      <div className="max-w-3xl">
        <p className="text-xs font-medium tracking-normal text-slate-500">
          콘텐츠 신뢰성 검토 · 미디어 리터러시 지원 도구
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950 sm:text-4xl leading-tight">
          영상의 주장과 근거를 스스로 판단할 수 있게 분석합니다
        </h1>
        <p className="mt-3 text-base leading-relaxed text-slate-600">
          영상·내용의 핵심 주장을 사실 주장과 의견 주장으로 나누어 정리하고, 최신 Google 검색
          자료 대조 판정과 AI 생성 의심도 점검 결과까지 한 번에 보여 드립니다.
        </p>
      </div>

      {sharedNotice && (
        <div
          role="status"
          className="mt-6 flex items-start justify-between gap-4 rounded-xl border border-blue-200 bg-blue-50 px-4 py-3.5 text-sm text-blue-950"
        >
          <div className="flex items-start gap-3">
            <Share2 className="mt-0.5 h-4 w-4 shrink-0 text-blue-700" aria-hidden="true" />
            <div>
              <p className="font-semibold">외부 앱 공유 데이터가 등록되었습니다</p>
              <p className="mt-0.5 text-xs leading-relaxed text-blue-900">{sharedNotice}</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onDismissSharedNotice}
            aria-label="공유 알림 닫기"
            className="rounded-md p-1 text-blue-700 hover:bg-blue-100 cursor-pointer shrink-0"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <form
        onSubmit={handleSubmit}
        className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 sm:p-8"
      >
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-100 pb-5">
          <div
            role="tablist"
            aria-label="콘텐츠 입력 방식"
            className="inline-flex rounded-lg bg-slate-100 p-1"
          >
            <button
              type="button"
              role="tab"
              aria-selected={true}
              className="flex items-center gap-2 rounded-md bg-white px-3.5 py-2 text-sm font-medium text-slate-950 shadow-xs whitespace-nowrap shrink-0 cursor-default"
            >
              <Link2 className="h-4 w-4" aria-hidden="true" />
              영상 링크
            </button>
          </div>
        </div>

        <div className="mt-6 space-y-5">
          <div>
            <label htmlFor="url-input" className="block text-sm font-semibold text-slate-900">
              YouTube (일반 · 쇼츠 · youtu.be) · Instagram 릴스 · SNS 영상 링크
            </label>
            <p className="mt-1 text-xs text-slate-500">
              YouTube 쇼츠(/shorts/ID) 및 단축 링크(youtu.be/ID)는 표준 watch 형식으로 변환해
              영상을 직접 불러와 분석합니다.
            </p>
            <div className="mt-2.5 flex flex-col gap-2.5 sm:flex-row">
              <input
                id="url-input"
                type="url"
                value={urlInput}
                onChange={(e) => {
                  onChangeUrlInput(e.target.value);
                  if (urlError) setUrlError(null);
                  onClearError();
                }}
                placeholder="https://www.youtube.com/shorts/... 또는 https://www.instagram.com/reel/..."
                className="w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
              />
              <button
                type="button"
                onClick={() => handleInspectUrl()}
                disabled={inspectingUrl}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-4 py-2.5 text-sm font-medium text-slate-800 transition-colors hover:bg-slate-100 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer"
              >
                {inspectingUrl ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Search className="h-4 w-4" aria-hidden="true" />
                )}
                링크 정보 확인
              </button>
            </div>
          </div>

          {showInlineVideoUpload && (
            <div
              data-testid="inline-video-upload-box"
              className={`rounded-xl border p-4 sm:p-5 space-y-3.5 ${
                isInstagramLink
                  ? 'border-amber-300 bg-amber-50/70'
                  : 'border-blue-200 bg-blue-50/70'
              }`}
            >
              <div className="flex items-start gap-3">
                <Film
                  className={`mt-0.5 h-5 w-5 shrink-0 ${
                    isInstagramLink ? 'text-amber-800' : 'text-blue-700'
                  }`}
                  aria-hidden="true"
                />
                <div className="space-y-1.5 min-w-0 flex-1">
                  {isInstagramLink ? (
                    <>
                      <p className="text-sm font-bold text-slate-950">
                        인스타 릴스는 링크로 영상을 볼 수 없어요. 인스타 공유 버튼 → &apos;다운로드&apos;로
                        저장한 뒤 여기에 올려 주세요
                      </p>
                      <p className="text-xs leading-relaxed text-slate-700 flex items-start gap-1.5">
                        <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-amber-800" aria-hidden="true" />
                        <span>
                          인스타그램 게시물 화면에{' '}
                          <strong className="font-semibold text-slate-950">&apos;AI 정보&apos;</strong>{' '}
                          표시가 붙어 있는지도 함께 직접 확인해 보세요.
                        </span>
                      </p>
                    </>
                  ) : (
                    <>
                      <p className="text-sm font-bold text-slate-950">
                        공유되거나 업로드된 영상 파일과 함께 분석해요
                      </p>
                      <p className="text-xs leading-relaxed text-slate-600">
                        영상 파일(mp4, mov)을 직접 올려 주시면 링크 정보·메모와 함께 AI 생성 단서 및
                        신뢰성 점수를 분석해 드려요.
                      </p>
                    </>
                  )}
                </div>
              </div>

              <input
                ref={fileInputRef}
                id="reel-video-upload-input"
                type="file"
                accept="video/mp4,video/quicktime,.mp4,.mov,video/*"
                onChange={handleSelectVideoFile}
                className="sr-only"
              />

              <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex flex-wrap items-center gap-2.5">
                  <label
                    htmlFor="reel-video-upload-input"
                    className={`inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-900 transition-colors hover:bg-slate-100 whitespace-nowrap shrink-0 ${
                      isCompressingVideo || isAnalyzing
                        ? 'pointer-events-none opacity-60'
                        : 'cursor-pointer'
                    }`}
                  >
                    <Upload className="h-4 w-4 text-blue-700" aria-hidden="true" />
                    {uploadedVideoFile ? '다른 영상 선택 (mp4, mov)' : '영상 올리기 (mp4, mov)'}
                  </label>
                  <span className="text-xs text-slate-600">
                    30MB가 넘으면 자동으로 줄여서 올려요 (원본 최대 300MB · 3분)
                  </span>
                </div>
              </div>

              {isCompressingVideo && (
                <div
                  data-testid="video-compression-progress"
                  role="status"
                  aria-live="polite"
                  className="rounded-lg border border-blue-200 bg-white px-4 py-3 text-xs space-y-2"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2 min-w-0">
                      <Loader2
                        className="h-4 w-4 animate-spin text-blue-700 shrink-0"
                        aria-hidden="true"
                      />
                      <span className="font-semibold text-slate-900 truncate">
                        영상 크기를 줄이는 중이에요 {compressionProgress}%
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={handleRemoveUploadedVideo}
                      className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      취소
                    </button>
                  </div>
                  {compressingFileName && (
                    <p className="text-[11px] text-slate-500 truncate">{compressingFileName}</p>
                  )}
                  <progress
                    value={compressionProgress}
                    max={100}
                    aria-label="영상 크기 축소 진행률"
                    className="h-2 w-full overflow-hidden rounded-full accent-blue-700"
                  />
                </div>
              )}

              {uploadedVideoFile && !isCompressingVideo && (
                <div
                  data-testid="uploaded-video-summary"
                  className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3.5 py-2.5 text-xs"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <p className="font-semibold text-slate-900 truncate">
                      선택된 영상: {uploadedVideoFile.name}
                    </p>
                    {compressionSummary?.wasCompressed ? (
                      <p className="text-slate-700 font-mono tabular-nums">
                        원본 크기 {formatFileSizeLabel(compressionSummary.originalSizeBytes)} → 줄인 크기{' '}
                        {formatFileSizeLabel(compressionSummary.compressedSizeBytes)}
                      </p>
                    ) : (
                      <p className="text-slate-500 font-mono tabular-nums">
                        {formatFileSizeLabel(uploadedVideoFile.size)} · 바로 업로드 (28MB 이하)
                      </p>
                    )}
                    {c2paMetadata?.hasManifest && (
                      <p className="text-[11px] text-blue-900">
                        원본 C2PA 출처 정보 확인됨
                        {c2paMetadata.claimGenerator ? ` (${c2paMetadata.claimGenerator})` : ''}
                        {c2paMetadata.isAiGeneratedClaim ? ' · AI 생성 표기 포함' : ''}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={handleRemoveUploadedVideo}
                    aria-label="올린 영상 파일 지우기"
                    className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-2.5 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                    지우기
                  </button>
                </div>
              )}

              {fileError && (
                <p role="alert" className="text-xs font-medium text-rose-800">
                  {fileError}
                </p>
              )}
            </div>
          )}

          {inspectionResult && (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-start">
                {inspectionResult.thumbnailUrl && (
                  <img
                    src={inspectionResult.thumbnailUrl}
                    alt={inspectionResult.title || '영상 썸네일'}
                    referrerPolicy="no-referrer"
                    className="h-24 w-40 rounded-lg border border-slate-200 object-cover shrink-0"
                  />
                )}
                <div className="min-w-0 flex-1 space-y-1.5">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
                    <span className="font-semibold text-slate-900">
                      {getPlatformLabel(inspectionResult.platform)}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span>
                      {inspectionResult.accessStatus === 'extracted'
                        ? '영상 정보 확인됨'
                        : inspectionResult.accessStatus === 'metadata_only'
                          ? '기본 정보만 확인됨'
                          : '영상 본문 접근 제한'}
                    </span>
                    {inspectionResult.author && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span>{inspectionResult.author}</span>
                      </>
                    )}
                  </div>
                  {inspectionResult.title && (
                    <p className="text-sm font-semibold text-slate-900">
                      {inspectionResult.title}
                    </p>
                  )}
                  <p className="text-xs leading-relaxed text-slate-600">
                    {inspectionResult.accessMessage}
                  </p>
                </div>
              </div>
            </div>
          )}

          <div>
            <label
              htmlFor="url-transcript-input"
              className="block text-sm font-semibold text-slate-900"
            >
              영상 자막 · 핵심 발언 · 추가 메모 (선택 또는 외부 SNS 보완 입력)
            </label>
            <p className="mt-1 text-xs text-slate-500">
              YouTube 영상은 링크만 입력해도 바로 분석할 수 있습니다. 인스타그램 릴스는 저장한
              영상 파일(mp4, mov)을 올리고 필요한 메모나 자막을 함께 적을 수 있어요.
            </p>
            <textarea
              id="url-transcript-input"
              rows={4}
              value={transcriptInput}
              onChange={(e) => {
                onChangeTranscriptInput(e.target.value);
                onClearError();
              }}
              placeholder="참고할 추가 맥락이나, 영상 속 발언·자막을 입력할 수 있습니다."
              className="mt-2.5 w-full rounded-lg border border-slate-300 bg-white px-3.5 py-2.5 text-sm leading-relaxed text-slate-900 placeholder:text-slate-400 focus:border-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-700/20"
            />
          </div>

          {(urlError || errorMessage) && (
            <div
              role="alert"
              className="flex items-start gap-2.5 rounded-lg border border-rose-200 bg-rose-50 px-3.5 py-3 text-sm text-rose-900"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-rose-700" aria-hidden="true" />
              <span>{urlError || errorMessage}</span>
            </div>
          )}

          <div className="flex flex-col gap-3 border-t border-slate-100 pt-5 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-slate-500">
              AI 분석은 참고 정보이며, 최종 사실 판단과 교차 검증은 사용자가 직접 수행합니다.
            </p>
            <button
              type="submit"
              disabled={isAnalyzing || isCompressingVideo}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-blue-700 px-6 py-3 text-sm font-semibold text-white transition-colors hover:bg-blue-800 disabled:opacity-60 whitespace-nowrap shrink-0 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
            >
              {isCompressingVideo ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  영상 크기 줄이는 중 ({compressionProgress}%)
                </>
              ) : isAnalyzing ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                  분석 진행 중
                </>
              ) : (
                '신뢰도 분석 시작'
              )}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
};
