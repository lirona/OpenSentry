import { AGENTS } from './embedded-skills.js';
import { buildSystemPrompt } from './prompt-wrapper.js';
import { runAgent } from './agent-runner.js';
import { mergeResults } from './merge-results.js';

const DEFAULT_AGENT_CONCURRENCY = 1;

export async function analyzeContractSource({ sourceResult, address, chain, env }) {
  if (!sourceResult || typeof sourceResult !== 'object' || sourceResult.success !== true) {
    throw new TypeError('analyzeContractSource: sourceResult must be a successful fetch result');
  }

  const metadata = {
    contractName: sourceResult.contractName,
    chain,
    address,
    compiler: sourceResult.compiler,
  };

  const agentConfigs = buildAgentConfigs();
  const settledResults = await runAllSettledLimited(
    agentConfigs,
    getAgentConcurrency(env),
    cfg => runAgent(cfg.key, cfg.systemPrompt, sourceResult.source, metadata, env),
  );

  const agentRuns = agentConfigs.map((cfg, i) => ({
    key: cfg.key,
    name: cfg.name,
    settled: settledResults[i],
  }));

  const report = mergeResults(agentRuns);

  return {
    contractName: sourceResult.contractName,
    address,
    chain,
    isProxy: sourceResult.isProxy,
    implementationAddress: sourceResult.implementationAddress,
    implementationContractName: sourceResult.implementation?.contractName || null,
    timestamp: new Date().toISOString(),
    report,
  };
}

function buildAgentConfigs() {
  return Object.entries(AGENTS).map(([key, agent]) => ({
    key,
    name: agent.name,
    systemPrompt: buildSystemPrompt(agent.content),
  }));
}

function getAgentConcurrency(env) {
  const raw = env?.AI_AGENT_CONCURRENCY;
  if (raw == null || raw === '') return DEFAULT_AGENT_CONCURRENCY;

  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_AGENT_CONCURRENCY;

  return Math.min(parsed, 8);
}

async function runAllSettledLimited(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runOne() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      try {
        results[current] = {
          status: 'fulfilled',
          value: await worker(items[current], current),
        };
      } catch (reason) {
        results[current] = {
          status: 'rejected',
          reason,
        };
      }
    }
  }

  const width = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: width }, () => runOne()));
  return results;
}

export const __internal = Object.freeze({
  DEFAULT_AGENT_CONCURRENCY,
  buildAgentConfigs,
  getAgentConcurrency,
  runAllSettledLimited,
});
