const RUNNER_TOKEN_HEADER = 'x-opensentry-runner-token';

export function getAnalyzeRelayEndpoint(env) {
  const raw = cleanEnvString(env?.ANALYZE_RELAY_URL);
  if (!raw) {
    return {
      configured: false,
      endpoint: null,
      error: null,
      errorCode: null,
    };
  }

  let endpoint;
  try {
    endpoint = new URL(raw);
  } catch {
    return {
      configured: true,
      endpoint: null,
      error: 'ANALYZE_RELAY_URL must be a valid http(s) URL.',
      errorCode: 'invalid_relay_url',
    };
  }

  if (endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') {
    return {
      configured: true,
      endpoint: null,
      error: 'ANALYZE_RELAY_URL must use http or https.',
      errorCode: 'invalid_relay_url',
    };
  }

  if (!getRunnerToken(env)) {
    return {
      configured: true,
      endpoint: null,
      error: 'ANALYZE_RELAY_TOKEN is required when ANALYZE_RELAY_URL is configured.',
      errorCode: 'invalid_relay_config',
    };
  }

  if (endpoint.pathname === '' || endpoint.pathname === '/') {
    endpoint.pathname = '/api/analyze';
  }
  endpoint.pathname = endpoint.pathname.replace(/\/$/, '');

  return {
    configured: true,
    endpoint,
    error: null,
    errorCode: null,
  };
}

export function checkRunnerToken(request, env) {
  const token = getRunnerToken(env);
  const relay = getAnalyzeRelayEndpoint(env);

  if (!token || relay.configured) return null;

  const received = request.headers.get(RUNNER_TOKEN_HEADER) || '';
  if (received === token) return null;

  return jsonResponse(401, {
    success: false,
    error: 'unauthorized_runner_request',
    message: 'Local runner token is missing or invalid.',
  });
}

export async function relayAnalysisJobCreation({ request, body, endpoint, env }) {
  return relayRunnerRequest({
    request,
    target: endpoint,
    env,
    method: 'POST',
    body,
  });
}

export async function relayAnalysisJobStatus({ request, jobId, endpoint, env }) {
  const target = new URL(endpoint);
  target.pathname = `${target.pathname}/${encodeURIComponent(jobId)}`;

  return relayRunnerRequest({
    request,
    target,
    env,
    method: 'GET',
  });
}

async function relayRunnerRequest({ request, target, env, method, body }) {
  const targetUrl = String(target);
  if (sameOrigin(request.url, targetUrl)) {
    return jsonResponse(500, {
      success: false,
      error: 'relay_loop',
      message: 'ANALYZE_RELAY_URL points back to this API endpoint.',
    });
  }

  const headers = new Headers({ 'content-type': 'application/json' });
  const token = getRunnerToken(env);
  if (token) {
    headers.set(RUNNER_TOKEN_HEADER, token);
  }

  const clientIp = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For');
  if (clientIp) {
    headers.set('X-Forwarded-For', clientIp);
  }

  let res;
  try {
    res = await fetch(targetUrl, {
      method,
      headers,
      redirect: 'manual',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    return relayUnavailableResponse();
  }

  const contentType = res.headers.get('content-type') || '';
  let responseText;
  try {
    responseText = await res.text();
  } catch {
    return relayUnavailableResponse();
  }
  if (res.status === 504 || res.status === 524) {
    return invalidRunnerResponse(res.status);
  }
  if (res.status === 502) return relayUnavailableResponse();
  if (!contentType.toLowerCase().includes('application/json') || !isJson(responseText)) {
    return invalidRunnerResponse(res.status);
  }

  const responseHeaders = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  };
  const location = res.headers.get('location');
  if (location) responseHeaders.location = location;

  return new Response(responseText, {
    status: res.status,
    headers: responseHeaders,
  });
}

function invalidRunnerResponse(status) {
  if (status === 504 || status === 524) {
    return jsonResponse(504, {
      success: false,
      error: 'relay_timeout',
      message: 'The connection to the local runner timed out. The audit may still be running.',
    });
  }

  if (status >= 500) {
    return relayUnavailableResponse();
  }

  return jsonResponse(502, {
    success: false,
    error: 'relay_bad_response',
    message: 'Local runner returned an invalid JSON response.',
  });
}

function relayUnavailableResponse() {
  return jsonResponse(502, {
    success: false,
    error: 'relay_unavailable',
    message: 'Local runner is unavailable. Make sure your desktop server and tunnel are running.',
  });
}

function isJson(value) {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

function getRunnerToken(env) {
  return cleanEnvString(env?.ANALYZE_RELAY_TOKEN);
}

function cleanEnvString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sameOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export const __internal = Object.freeze({
  RUNNER_TOKEN_HEADER,
  relayRunnerRequest,
  invalidRunnerResponse,
  isJson,
});
