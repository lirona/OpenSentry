import { errorResult } from '../error-result.js';

const CODEX_API_URL = 'https://api.openai.com/v1/responses';

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
            instructions: systemPrompt,
            input: userMessage,
            temperature: requestConfig.temperature,
            text: { format: { type: 'json_object' } },
            store: false,
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
      if (payload?.status === 'failed' || payload?.error) {
        const message = payload?.error?.message || 'Responses API returned a failed response';
        return errorResult('HTTP_ERROR', `Model failed: ${message}`);
      }

      if (payload?.status === 'incomplete') {
        const reason = payload?.incomplete_details?.reason || 'unknown';
        return errorResult('PARSE_FAILED', `Model response was incomplete: ${reason}`);
      }

      const refusal = extractRefusalText(payload);
      if (typeof refusal === 'string' && refusal.length > 0) {
        return errorResult('SAFETY_BLOCKED', `Model refusal: ${refusal}`);
      }

      const text = extractMessageText(payload);
      if (typeof text !== 'string' || text.length === 0) {
        return errorResult('PARSE_FAILED', 'Model response had no text content');
      }

      return { ok: true, text };
    },
  });
}

function extractMessageText(payload) {
  if (typeof payload?.output_text === 'string' && payload.output_text.length > 0) {
    return payload.output_text;
  }

  if (!Array.isArray(payload?.output)) return '';

  return payload.output
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function extractRefusalText(payload) {
  if (!Array.isArray(payload?.output)) return '';

  return payload.output
    .flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .filter((part) => (
      (part?.type === 'refusal' || part?.type === 'output_refusal') &&
      (typeof part.refusal === 'string' || typeof part.text === 'string')
    ))
    .map((part) => part.refusal || part.text)
    .join('');
}

export { CODEX_API_URL };
