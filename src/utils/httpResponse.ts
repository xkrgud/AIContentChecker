import { VIDEO_TOO_LARGE_CUT_ERROR } from './videoUpload.ts';

export type HttpErrorContext = 'analyze' | 'inspect';

export function mapHttpStatusToFriendlyError(
  status: number,
  context: HttpErrorContext = 'analyze'
): string {
  if (status === 413) {
    return `파일이 너무 커요. ${VIDEO_TOO_LARGE_CUT_ERROR}`;
  }
  if (status === 429) {
    return '잠시 후 다시 시도해 주세요. (브라우저당 1분에 최대 5회까지만 분석할 수 있어요.)';
  }
  if (status === 504 || status === 408) {
    return '서버 응답이 늦어요. 영상이 길거나 요청이 몰렸을 수 있으니 잠시 후 다시 시도해 주세요.';
  }
  if (status === 502) {
    return '서버 응답을 받지 못했어요 (502). 잠시 후 다시 시도해 주세요.';
  }
  if (status === 503) {
    return 'AI 분석 서버에 요청이 몰리고 있어요. 잠시 후 다시 시도해 주세요.';
  }
  if (status >= 500) {
    return `서버에서 요청을 처리하지 못했어요 (${status}). 잠시 후 다시 시도해 주세요.`;
  }
  if (status === 400) {
    return context === 'inspect'
      ? '입력한 링크 형식을 다시 확인해 주세요.'
      : '입력 형식이 올바르지 않아요. 링크와 입력 내용을 다시 확인해 주세요.';
  }
  if (status === 422) {
    return '요청한 영상이나 링크를 처리할 수 없어요. 링크와 파일 상태를 확인해 주세요.';
  }
  return context === 'inspect'
    ? `링크 정보를 확인하지 못했어요. (오류 코드 ${status})`
    : `요청 처리 중 오류가 발생했어요. (오류 코드 ${status})`;
}

export function extractErrorMessageFromBody(
  rawText: string,
  status: number,
  context: HttpErrorContext = 'analyze'
): string {
  const trimmed = rawText.trim();
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed) as { error?: unknown; message?: unknown };
      if (typeof parsed?.error === 'string' && parsed.error.trim()) {
        return parsed.error.trim();
      }
      if (typeof parsed?.message === 'string' && parsed.message.trim()) {
        return parsed.message.trim();
      }
    } catch {
      // Non-JSON response (e.g., HTML 413/502/504 gateway page) -> fall back to status map
    }
  }
  return mapHttpStatusToFriendlyError(status, context);
}

export async function readSafeJsonResponse<T = unknown>(
  response: Pick<Response, 'ok' | 'status' | 'text'>,
  context: HttpErrorContext = 'analyze'
): Promise<{ ok: true; data: T } | { ok: false; status: number; error: string }> {
  const rawText = await response.text().catch(() => '');

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: extractErrorMessageFromBody(rawText, response.status, context),
    };
  }

  try {
    const data = JSON.parse(rawText) as T;
    return { ok: true, data };
  } catch {
    return {
      ok: false,
      status: response.status || 502,
      error: mapHttpStatusToFriendlyError(response.status >= 400 ? response.status : 502, context),
    };
  }
}
