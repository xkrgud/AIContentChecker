export const GEMINI_MODELS = {
  primaryAnalysis: 'gemini-4-hydrogen',
  fallbackAnalysis: 'gemini-3.1-flash-lite',
  factCheck: 'gemini-2.5-flash',
} as const;

export type GeminiModelRole = keyof typeof GEMINI_MODELS;
