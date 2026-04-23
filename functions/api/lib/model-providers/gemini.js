import { errorResult } from '../error-result.js';

const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

export function createGeminiProvider() {
  return Object.freeze({
    name: 'gemini',
    buildRequest({ systemPrompt, userMessage, requestConfig, env }) {
      return {
        url: `${GEMINI_BASE_URL}/${encodeURIComponent(env.AI_MODEL)}:generateContent?key=${encodeURIComponent(env.AI_API_KEY)}`,
        init: {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userMessage }] }],
            generationConfig: {
              temperature: requestConfig.temperature,
              maxOutputTokens: requestConfig.maxOutputTokens,
              responseMimeType: requestConfig.responseMimeType,
            },
          }),
        },
      };
    },
    classifyHttpError(res, errBody) {
      const apiMsg = errBody?.error?.message || res.statusText || `HTTP ${res.status}`;
      const apiStatus = errBody?.error?.status || '';

      if (res.status === 429) {
        return errorResult('RATE_LIMIT', `Model rate limit: ${apiMsg}`, { httpStatus: 429 });
      }
      if (res.status === 400 && apiStatus === 'INVALID_ARGUMENT') {
        return errorResult(
          'INPUT_TOO_LARGE',
          `Model rejected input (likely too large or malformed): ${apiMsg}`,
          { httpStatus: 400 },
        );
      }
      if (res.status >= 500 && res.status < 600) {
        return errorResult('HTTP_5XX', `Model ${res.status}: ${apiMsg}`, { httpStatus: res.status });
      }
      return errorResult('HTTP_ERROR', `Model ${res.status}: ${apiMsg}`, { httpStatus: res.status });
    },
    extractText(payload) {
      if (payload?.promptFeedback?.blockReason) {
        return errorResult(
          'SAFETY_BLOCKED',
          `Model safety filter blocked the prompt: ${payload.promptFeedback.blockReason}`,
          { blockReason: payload.promptFeedback.blockReason },
        );
      }

      const candidate = payload?.candidates?.[0];
      if (!candidate) {
        return errorResult('PARSE_FAILED', 'Model response had no candidates');
      }

      const finishReason = candidate.finishReason;
      if (finishReason === 'SAFETY' || finishReason === 'RECITATION') {
        return errorResult(
          'SAFETY_BLOCKED',
          `Model candidate blocked with finishReason=${finishReason}`,
          { finishReason },
        );
      }

      const text = candidate?.content?.parts?.[0]?.text;
      if (typeof text !== 'string' || text.length === 0) {
        return errorResult('PARSE_FAILED', 'Model candidate had no text part');
      }

      return { ok: true, text };
    },
  });
}

export { GEMINI_BASE_URL };
