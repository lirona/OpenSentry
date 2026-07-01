import { analyzeContractSource } from './analyze-pipeline.js';
import { checkRunnerToken } from './analyze-relay.js';
import { parseAnalyzeRequest, jsonResponse } from './analyze-request.js';
import { fetchSource } from './fetch-source.js';

export async function onRequestPost(context) {
  const { request, env } = context;

  const runnerTokenError = checkRunnerToken(request, env);
  if (runnerTokenError) return runnerTokenError;

  const parsed = await parseAnalyzeRequest(request);
  if (!parsed.ok) return parsed.response;

  const { address, chain } = parsed.body;
  const sourceResult = await fetchSource(address, chain, env);

  if (!sourceResult.success) {
    const status = sourceResult.error === 'unverified' ? 422 : 502;
    return jsonResponse(status, {
      success: false,
      error: sourceResult.error,
      message: sourceResult.message,
    });
  }

  const analysis = await analyzeContractSource({
    sourceResult,
    address,
    chain,
    env,
  });

  return jsonResponse(200, {
    success: true,
    ...analysis,
  });
}
