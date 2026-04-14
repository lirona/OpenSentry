// POST /api/analyze — Main orchestrator endpoint.
//
// Accepts { address, chain }, fetches verified source, runs 8 AI security
// agents with bounded concurrency, merges the results, and returns a unified
// report.

import { fetchSource } from './lib/fetch-source.js';
import { analyzeContractSource } from './lib/analyze-pipeline.js';

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const SUPPORTED_CHAINS = new Set(['ethereum', 'base', 'arbitrum', 'optimism', 'polygon']);

export async function onRequestPost(context) {
  const { request, env } = context;

  // ---- Parse + validate request body ----------------------------------------

  let body;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(400, {
      success: false,
      error: 'invalid_json',
      message: 'Request body must be valid JSON.',
    });
  }

  const { address, chain } = body || {};

  if (typeof address !== 'string' || !ADDRESS_RE.test(address)) {
    return jsonResponse(400, {
      success: false,
      error: 'invalid_address',
      message: `Invalid contract address. Expected 0x-prefixed 40-character hex string.`,
    });
  }

  if (typeof chain !== 'string' || !SUPPORTED_CHAINS.has(chain)) {
    return jsonResponse(400, {
      success: false,
      error: 'unsupported_chain',
      message: `Unsupported chain "${chain}". Supported: ${[...SUPPORTED_CHAINS].join(', ')}.`,
    });
  }

  // ---- Fetch verified source ------------------------------------------------

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

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
