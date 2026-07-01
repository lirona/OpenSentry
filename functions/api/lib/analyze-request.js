const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SUPPORTED_CHAINS = new Set(['ethereum', 'base', 'arbitrum', 'optimism', 'polygon']);

export async function parseAnalyzeRequest(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return invalidRequest(400, {
      success: false,
      error: 'invalid_json',
      message: 'Request body must be valid JSON.',
    });
  }

  const { address, chain } = body || {};

  if (typeof address !== 'string' || !ADDRESS_RE.test(address)) {
    return invalidRequest(400, {
      success: false,
      error: 'invalid_address',
      message: 'Invalid contract address. Expected 0x-prefixed 40-character hex string.',
    });
  }

  if (typeof chain !== 'string' || !SUPPORTED_CHAINS.has(chain)) {
    return invalidRequest(400, {
      success: false,
      error: 'unsupported_chain',
      message: `Unsupported chain "${chain}". Supported: ${[...SUPPORTED_CHAINS].join(', ')}.`,
    });
  }

  return {
    ok: true,
    body: { address, chain },
  };
}

export function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}

function invalidRequest(status, body) {
  return {
    ok: false,
    response: jsonResponse(status, body),
  };
}

export const __internal = Object.freeze({
  ADDRESS_RE,
  SUPPORTED_CHAINS,
  invalidRequest,
});
