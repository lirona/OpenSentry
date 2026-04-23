import { errorResult } from '../error-result.js';

const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_API_VERSION = '2023-06-01';

export function createClaudeProvider() {
  return Object.freeze({
    name: 'claude',
    buildRequest({ systemPrompt, userMessage, requestConfig, env }) {
      return {
        url: CLAUDE_API_URL,
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': env.AI_API_KEY,
            'anthropic-version': CLAUDE_API_VERSION,
          },
          body: JSON.stringify({
            model: env.AI_MODEL,
            system: systemPrompt,
            max_tokens: requestConfig.maxOutputTokens,
            temperature: requestConfig.temperature,
            messages: [{ role: 'user', content: userMessage }],
          }),
        },
      };
    },
    classifyHttpError(res, errBody) {
      const apiMsg = errBody?.error?.message || res.statusText || `HTTP ${res.status}`;

      if (res.status === 429) {
        return errorResult('RATE_LIMIT', `Model rate limit: ${apiMsg}`, { httpStatus: 429 });
      }
      if (res.status === 400) {
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
      const textBlock = payload?.content?.find?.((part) => part?.type === 'text');
      const text = textBlock?.text;
      if (typeof text !== 'string' || text.length === 0) {
        return errorResult('PARSE_FAILED', 'Model response had no text content');
      }

      return { ok: true, text };
    },
  });
}

export { CLAUDE_API_URL, CLAUDE_API_VERSION };
