// POST /api/analyze — Main orchestrator endpoint.
//
// Accepts { address, chain }, fetches verified source, fans out 8 AI security
// agents in parallel, merges the results, and returns a unified report.

import { fetchSource } from './lib/fetch-source.js';
import { AGENTS } from './lib/embedded-skills.js';
import { buildSystemPrompt } from './lib/prompt-wrapper.js';
import { runAgent } from './lib/agent-runner.js';
import { mergeResults } from './lib/merge-results.js';

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

  const metadata = {
    contractName: sourceResult.contractName,
    chain,
    address,
    compiler: sourceResult.compiler,
  };

  // ---- Build agent configs --------------------------------------------------

  const agentConfigs = Object.entries(AGENTS).map(([key, agent]) => ({
    key,
    name: agent.name,
    systemPrompt: buildSystemPrompt(agent.content),
  }));

  // ---- Fan out all 8 agents in parallel -------------------------------------
  //
  // Promise.allSettled guarantees we get partial results even if some agents
  // fail (timeout, safety filter, rate limit). The merger classifies each
  // settled result and emits "Analysis incomplete" for failures.

  const settledResults = await Promise.allSettled(
    agentConfigs.map(cfg =>
      runAgent(cfg.key, cfg.systemPrompt, sourceResult.source, metadata, env),
    ),
  );

  // Pair each settled result with its agent metadata so the merger can map
  // display names for failed agents that never returned a result.
  const agentRuns = agentConfigs.map((cfg, i) => ({
    key: cfg.key,
    name: cfg.name,
    settled: settledResults[i],
  }));

  // ---- Merge + return -------------------------------------------------------

  const report = mergeResults(agentRuns);

  return jsonResponse(200, {
    success: true,
    contractName: sourceResult.contractName,
    address,
    chain,
    isProxy: sourceResult.isProxy,
    implementationAddress: sourceResult.implementationAddress,
    implementationContractName: sourceResult.implementation?.contractName || null,
    timestamp: new Date().toISOString(),
    report,
  });
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
