import { errorResult } from '../error-result.js';

const CODEX_API_URL = 'https://api.openai.com/v1/chat/completions';

export function createCodexProvider() {
  return Object.freeze({
    name: 'codex',
    buildRequest({ systemPrompt, userMessage, requestConfig, env }) {
      return {
        url: CODEX_API_URL,
        init: {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${env.AI_API_KEY}`,
          },
          body: JSON.stringify({
            model: env.AI_MODEL,
            messages: [
              { role: 'developer', content: systemPrompt },
              { role: 'user', content: userMessage },
            ],
            temperature: requestConfig.temperature,
            response_format: { type: 'json_object' },
          }),
        },
      };
    },
    classifyHttpError(res, errBody) {
      const apiMsg = errBody?.error?.message || res.statusText || `HTTP ${res.status}`;
      const apiCode = errBody?.error?.code || '';

      if (res.status === 429) {
        return errorResult('RATE_LIMIT', `Model rate limit: ${apiMsg}`, { httpStatus: 429 });
      }
      if (
        res.status === 400 &&
        (
          apiCode === 'context_length_exceeded' ||
          /context length|too long|too many tokens|maximum context/i.test(apiMsg)
        )
      ) {
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
      const choice = payload?.choices?.[0];
      if (!choice) {
        return errorResult('PARSE_FAILED', 'Model response had no choices');
      }

      if (choice.finish_reason === 'content_filter') {
        return errorResult(
          'SAFETY_BLOCKED',
          'Model response was blocked by content filtering',
          { finishReason: choice.finish_reason },
        );
      }

      const refusal = choice?.message?.refusal || extractRefusalText(choice?.message?.content);
      if (typeof refusal === 'string' && refusal.length > 0) {
        return errorResult('SAFETY_BLOCKED', `Model refusal: ${refusal}`);
      }

      const text = extractMessageText(choice?.message?.content);
      if (typeof text !== 'string' || text.length === 0) {
        return errorResult('PARSE_FAILED', 'Model response had no text content');
      }

      return { ok: true, text };
    },
  });
}

function extractMessageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function extractRefusalText(content) {
  if (!Array.isArray(content)) return '';

  return content
    .filter((part) => part?.type === 'refusal' && typeof part.refusal === 'string')
    .map((part) => part.refusal)
    .join('');
}

export { CODEX_API_URL };
