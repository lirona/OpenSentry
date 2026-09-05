// POST /api/analyze — Public relay endpoint.
//
// Cloudflare validates the browser request and forwards it to the authenticated
// Node runner. The compiler and model pipeline intentionally live outside this
// module so the relay bundle remains within Cloudflare's size and runtime
// limits.

import { parseAnalyzeRequest, jsonResponse } from './lib/analyze-request.js';
import {
  getAnalyzeRelayEndpoint,
  relayAnalysisJobCreation,
} from './lib/analyze-relay.js';

export async function onRequestPost(context) {
  const { request, env } = context;
  const parsed = await parseAnalyzeRequest(request);
  if (!parsed.ok) return parsed.response;

  const relay = getAnalyzeRelayEndpoint(env);
  if (relay.error) {
    return jsonResponse(500, {
      success: false,
      error: relay.errorCode || 'invalid_relay_config',
      message: relay.error,
    });
  }

  if (!relay.endpoint) {
    return jsonResponse(503, {
      success: false,
      error: 'relay_not_configured',
      message: 'The public analysis relay is not configured.',
    });
  }

  return relayAnalysisJobCreation({
    request,
    body: parsed.body,
    endpoint: relay.endpoint,
    env,
  });
}
