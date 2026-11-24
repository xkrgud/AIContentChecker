export interface ClassifiedAnalyzeError {
  status: number;
  error: string;
  isAborted?: boolean;
}

export const QUOTA_EXHAUSTED_USER_MESSAGE =
  '오늘 무료 사용량을 다 썼어요. 한국 시간 오후 5시쯤 다시 시도해 주세요';

export function extractErrorStatus(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const val = (err as { status?: unknown }).status;
    if (typeof val === 'number') return val;
  }
  return undefined;
}

export function isQuotaExhaustedError(err: unknown): boolean {
  if (!err) return false;
  const statusCode = extractErrorStatus(err);
  if (statusCode === 429) return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /RESOURCE_EXHAUSTED|\b429\b|quota exceeded|rate limit|too many requests/i.test(msg);
}

export function isAbortLikeError(err: unknown): boolean {
  if (!err) return false;
  if (err instanceof Error && err.name === 'AbortError') return true;
  const msg = err instanceof Error ? err.message : String(err);
  return /\bAbortError\b|aborted|Request was aborted/i.test(msg);
}

export function classifyAnalyzeError(
  err: unknown,
  options: { isYouTubeVideo?: boolean } = {}
): ClassifiedAnalyzeError {
  if (isAbortLikeError(err)) {
    return {
      status: 499,
      error: '분석 요청이 취소되었습니다.',
      isAborted: true,
    };
  }

  const msg = err instanceof Error ? err.message : String(err);
  const statusCode = extractErrorStatus(err);

  if (
    statusCode === 401 ||
    statusCode === 403 ||
    /API_KEY_INVALID|API key not valid|PERMISSION_DENIED/i.test(msg)
  ) {
    return {
      status: 403,
      error:
        'Gemini API 키가 유효하지 않거나 권한이 없습니다. Settings > Secrets 패널에서 GEMINI_API_KEY를 확인해 주세요.',
    };
  }

  if (isQuotaExhaustedError(err)) {
    return {
      status: 429,
      error: QUOTA_EXHAUSTED_USER_MESSAGE,
    };
  }

  if (
    statusCode === 503 ||
    /503|UNAVAILABLE|high demand|overloaded|Service Unavailable/i.test(msg)
  ) {
    return {
      status: 503,
      error:
        'AI 분석 모델에 일시적으로 요청이 몰리고 있습니다. 잠시 후 다시 시도해 주세요.',
    };
  }

  // Distinguish missing/unsupported Gemini model errors BEFORE checking video fetch errors
  const looksLikeModelError =
    (/models\/[a-z0-9._-]+/i.test(msg) &&
      /(not found|invalid|unsupported|unavailable|deprecated|does not exist|not supported|NOT_FOUND)/i.test(
        msg
      )) ||
    /\bmodel\b.*(not found|invalid|unsupported|unavailable|deprecated|does not exist|not supported)/i.test(
      msg
    ) ||
    /(not found|unsupported|deprecated).*\bmodel\b/i.test(msg) ||
    (statusCode === 404 && !/video|youtube|fileUri|fileData/i.test(msg));

  if (looksLikeModelError) {
    return {
      status: 502,
      error:
        '설정한 AI 분석 모델을 찾을 수 없거나 현재 사용할 수 없습니다. 모델 이름과 지원 상태를 확인해 주세요.',
    };
  }

  const looksLikeVideoFetchError =
    /fileData|fileUri|Unable to fetch|cannot access|private video|video is unavailable|FAILED_PRECONDITION/i.test(
      msg
    ) ||
    (Boolean(options.isYouTubeVideo) &&
      (/video|youtube/i.test(msg) || statusCode === 404 || /NOT_FOUND/i.test(msg)));

  if (looksLikeVideoFetchError) {
    return {
      status: 422,
      error:
        '영상을 불러올 수 없어요. 비공개·삭제된 영상이거나 현재 접근할 수 없는 영상 링크인지 확인해 주세요.',
    };
  }

  if (statusCode === 400 || /INVALID_ARGUMENT/i.test(msg)) {
    return {
      status: 400,
      error: '입력 형식이 올바르지 않아 분석을 시작할 수 없습니다. 링크와 입력 내용을 다시 확인해 주세요.',
    };
  }

  return {
    status: 500,
    error: 'AI 분석 요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.',
  };
}
