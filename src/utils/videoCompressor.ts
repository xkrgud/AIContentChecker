import type { VideoCompressionSummary } from '../types/analysis.ts';
import {
  calculateScaledDimensions,
  calculateTargetVideoBitrate,
  CLOUD_RUN_SAFE_UPLOAD_BYTES,
  MAX_VIDEO_LONG_SIDE_PX,
  ORIGINAL_VIDEO_LIMIT_ERROR,
  shouldCompressVideo,
  validateOriginalVideoDuration,
  VIDEO_TOO_LARGE_CUT_ERROR,
} from './videoUpload.ts';

export interface VideoMediaProbe {
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
}

export async function probeVideoFileInBrowser(file: File): Promise<VideoMediaProbe> {
  if (typeof document === 'undefined' || typeof URL === 'undefined') {
    return { durationSeconds: null, width: null, height: null };
  }

  return new Promise((resolve) => {
    const video = document.createElement('video');
    const objectUrl = URL.createObjectURL(file);
    let settled = false;

    const cleanup = () => {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
    };

    const finish = (probe: VideoMediaProbe) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeoutId);
      cleanup();
      resolve(probe);
    };

    const timeoutId = window.setTimeout(() => {
      finish({ durationSeconds: null, width: null, height: null });
    }, 5000);

    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    video.onloadedmetadata = () => {
      const duration =
        Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
      const width = video.videoWidth > 0 ? video.videoWidth : null;
      const height = video.videoHeight > 0 ? video.videoHeight : null;
      finish({ durationSeconds: duration, width, height });
    };
    video.onerror = () => {
      finish({ durationSeconds: null, width: null, height: null });
    };
    video.src = objectUrl;
  });
}

export function isWebCodecsSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.VideoEncoder === 'function' &&
    typeof window.VideoDecoder === 'function'
  );
}

export interface CompressVideoResult {
  file: File;
  summary: VideoCompressionSummary;
}

/**
 * Checks original video duration (<= 3 min) and size (<= 300MB).
 * If > 28MB, re-encodes via Mediabunny (WebCodecs) to <= 28MB with long side capped at 1280px,
 * bitrate auto-fitted to duration, and audio copied without recompression whenever possible.
 */
export async function prepareVideoForCloudRunUpload(
  file: File,
  options: {
    durationHintSeconds?: number | null;
    onProgress?: (percent: number) => void;
    signal?: AbortSignal;
    forceCompressThresholdBytes?: number;
  } = {}
): Promise<CompressVideoResult> {
  const thresholdBytes = options.forceCompressThresholdBytes ?? CLOUD_RUN_SAFE_UPLOAD_BYTES;
  const probe =
    options.durationHintSeconds != null
      ? { durationSeconds: options.durationHintSeconds, width: null, height: null }
      : await probeVideoFileInBrowser(file);

  const durationCheck = validateOriginalVideoDuration(probe.durationSeconds);
  if (!durationCheck.valid) {
    throw new Error(durationCheck.error || ORIGINAL_VIDEO_LIMIT_ERROR);
  }

  if (file.size <= thresholdBytes) {
    return {
      file,
      summary: {
        wasCompressed: false,
        originalSizeBytes: file.size,
        compressedSizeBytes: file.size,
        durationSeconds: probe.durationSeconds ?? undefined,
      },
    };
  }

  if (!isWebCodecsSupported()) {
    throw new Error(VIDEO_TOO_LARGE_CUT_ERROR);
  }

  const {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    Conversion,
    Input,
    Mp4OutputFormat,
    Output,
    Quality,
  } = await import('mediabunny');

  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(file),
  });

  try {
    const canRead = await input.canRead();
    if (!canRead) {
      throw new Error(VIDEO_TOO_LARGE_CUT_ERROR);
    }

    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      throw new Error('영상 트랙을 찾을 수 없어요. 다른 MP4/MOV 파일로 다시 시도해 주세요.');
    }

    const trackDuration =
      probe.durationSeconds ??
      (await input.getDurationFromMetadata(undefined, { skipLiveWait: true })) ??
      (await videoTrack.computeDurationOrNull({ skipLiveWait: true })) ??
      60;

    const postDurationCheck = validateOriginalVideoDuration(trackDuration);
    if (!postDurationCheck.valid) {
      throw new Error(postDurationCheck.error || ORIGINAL_VIDEO_LIMIT_ERROR);
    }

    const srcWidth = (await videoTrack.getDisplayWidth()) || probe.width || 1280;
    const srcHeight = (await videoTrack.getDisplayHeight()) || probe.height || 720;
    const scaled = calculateScaledDimensions({
      width: srcWidth,
      height: srcHeight,
      maxLongSide: MAX_VIDEO_LONG_SIDE_PX,
    });

    const audioTrack = await input.getPrimaryAudioTrack();
    const audioBitrate = audioTrack
      ? Math.min(256_000, Math.max(64_000, (await audioTrack.getAverageBitrate()) || 128_000))
      : 0;

    let lastReportedProgress = 1;

    const runConversionPass = async (targetBytes: number): Promise<ArrayBuffer> => {
      const targetVideoBitrate = calculateTargetVideoBitrate({
        durationSeconds: trackDuration,
        targetBytes,
        audioBitrateBps: audioBitrate,
      });

      const buildConversion = async (forceAudioTranscode: boolean) => {
        const target = new BufferTarget();
        const output = new Output({
          format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
          target,
        });

        const conversion = await Conversion.init({
          input,
          output,
          tracks: 'primary',
          copy: { mode: 'preferred' },
          showWarnings: false,
          video: {
            width: scaled.width,
            height: scaled.height,
            fit: 'contain',
            codec: 'avc',
            forceTranscode: true,
            quality: new Quality({
              bitrate: targetVideoBitrate,
              bitrateMode: 'variable',
            }),
          },
          audio: !audioTrack
            ? { discard: true }
            : forceAudioTranscode
              ? { codec: 'aac', forceTranscode: true }
              : {},
        });
        return { conversion, target };
      };

      let { conversion, target } = await buildConversion(false);
      if (!conversion.isValid && audioTrack) {
        ({ conversion, target } = await buildConversion(true));
      }

      if (!conversion.isValid) {
        throw new Error(VIDEO_TOO_LARGE_CUT_ERROR);
      }

      conversion.onProgress = (progress) => {
        const pct = Math.max(lastReportedProgress, Math.min(99, Math.round(progress * 100)));
        lastReportedProgress = pct;
        options.onProgress?.(pct);
      };

      const onAbort = () => {
        void conversion.cancel();
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });

      try {
        await conversion.execute();
      } finally {
        options.signal?.removeEventListener('abort', onAbort);
      }

      if (!target.buffer) {
        throw new Error(VIDEO_TOO_LARGE_CUT_ERROR);
      }
      return target.buffer;
    };

    options.onProgress?.(1);

    let compressedBuffer = await runConversionPass(25.5 * 1024 * 1024);

    // If VBR still exceeded 28MB slightly, retry once with tighter 20MB budget
    if (compressedBuffer.byteLength > CLOUD_RUN_SAFE_UPLOAD_BYTES) {
      if (options.signal?.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      compressedBuffer = await runConversionPass(20 * 1024 * 1024);
    }

    if (compressedBuffer.byteLength > CLOUD_RUN_SAFE_UPLOAD_BYTES) {
      throw new Error(VIDEO_TOO_LARGE_CUT_ERROR);
    }

    options.onProgress?.(100);

    const baseName = file.name.replace(/\.[^.]+$/, '') || 'video';
    const compressedFile = new File([compressedBuffer], `${baseName}.mp4`, {
      type: 'video/mp4',
    });

    return {
      file: compressedFile,
      summary: {
        wasCompressed: shouldCompressVideo(file.size) || compressedFile.size !== file.size,
        originalSizeBytes: file.size,
        compressedSizeBytes: compressedFile.size,
        durationSeconds: trackDuration,
      },
    };
  } catch (err) {
    if (
      (err instanceof DOMException && err.name === 'AbortError') ||
      options.signal?.aborted
    ) {
      throw err;
    }
    if (err instanceof Error && err.message === ORIGINAL_VIDEO_LIMIT_ERROR) {
      throw err;
    }
    throw new Error(VIDEO_TOO_LARGE_CUT_ERROR);
  } finally {
    input.dispose();
  }
}
