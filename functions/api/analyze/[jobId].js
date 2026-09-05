// GET /api/analyze/:jobId - Public status relay endpoint.

import { isAnalysisJobId } from '../lib/analysis-job-contract.js';
import { jsonResponse } from '../lib/analyze-request.js';
import {
  getAnalyzeRelayEndpoint,
  relayAnalysisJobStatus,
} from '../lib/analyze-relay.js';

export async function onRequestGet(context) {
  const { request, env } = context;
  const jobId = context.params?.jobId;

  if (!isAnalysisJobId(jobId)) {
    return jsonResponse(400, {
      success: false,
      error: 'invalid_job_id',
      message: 'The analysis job ID is invalid.',
    });
  }

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

  return relayAnalysisJobStatus({
    request,
    jobId,
    endpoint: relay.endpoint,
    env,
  });
}
