import { AGENTS } from './embedded-skills.js';
import { buildSystemPrompt } from './prompt-wrapper.js';
import { runAgent, resolveModelProvider } from './agent-runner.js';
import { runCompilerFactsStage } from './compiler-facts-stage.js';
import { mergeResults } from './merge-results.js';

const DEFAULT_AGENT_CONCURRENCY = 1;

export async function analyzeContractSource({ sourceResult, address, chain, env }) {
  return analyzeContractSourceWithOptions({ sourceResult, address, chain, env, includeTrace: false });
}

export async function analyzeContractSourceWithOptions({
  sourceResult,
  address,
  chain,
  env,
  includeTrace = false,
}) {
  if (!sourceResult || typeof sourceResult !== 'object' || sourceResult.success !== true) {
    throw new TypeError('analyzeContractSource: sourceResult must be a successful fetch result');
  }

  const metadata = {
    contractName: sourceResult.contractName,
    chain,
    address,
    compiler: sourceResult.compiler,
  };
  const compilerFacts = runCompilerFactsStage(sourceResult);
  const deterministicFindingIds = compilerFacts.deterministicFindings
    .map((finding) => finding.ruleId)
    .filter((ruleId) => typeof ruleId === 'string' && ruleId.length > 0);
  const usedDeterministicContext = compilerFacts.factsStage.status === 'ok';

  // Fail fast on model-provider misconfiguration before we fan out all agents.
  resolveModelProvider(env);

  const agentConfigs = buildAgentConfigs();
  const settledResults = await runAllSettledLimited(
    agentConfigs,
    getAgentConcurrency(env),
    cfg => runAgent(cfg.key, cfg.systemPrompt, sourceResult.source, metadata, env, {
      facts: compilerFacts.factsStage.facts,
      deterministicFindings: compilerFacts.deterministicFindings,
    }),
  );

  const agentRuns = agentConfigs.map((cfg, i) => ({
    key: cfg.key,
    name: cfg.name,
    settled: settledResults[i],
    usedDeterministicContext,
    factsStageStatus: compilerFacts.factsStage.status,
    deterministicFindingIdsSupplied: deterministicFindingIds,
  }));

  const report = mergeResults(agentRuns, {
    deterministicFindings: compilerFacts.deterministicFindings,
  });
  const analysis = {
    contractName: sourceResult.contractName,
    address,
    chain,
    isProxy: sourceResult.isProxy,
    implementationAddress: sourceResult.implementationAddress,
    implementationContractName: sourceResult.implementation?.contractName || null,
    timestamp: new Date().toISOString(),
    report,
  };

  if (!includeTrace) {
    return analysis;
  }

  return {
    ...analysis,
    trace: {
      agentConfigs: agentConfigs.map((cfg) => ({
        key: cfg.key,
        name: cfg.name,
        systemPrompt: cfg.systemPrompt,
      })),
      agentRuns: agentRuns.map(serializeAgentRun),
      factsStage: compilerFacts.factsStage,
      deterministicFindings: compilerFacts.deterministicFindings,
      mergedReport: report,
    },
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

function serializeAgentRun(run) {
  if (run?.settled?.status === 'fulfilled') {
    return {
      key: run.key,
      name: run.name,
      usedDeterministicContext: Boolean(run.usedDeterministicContext),
      factsStageStatus: run.factsStageStatus || 'unknown',
      deterministicFindingIdsSupplied: Array.isArray(run.deterministicFindingIdsSupplied)
        ? run.deterministicFindingIdsSupplied
        : [],
      settled: {
        status: 'fulfilled',
        value: run.settled.value,
      },
    };
  }

  return {
    key: run?.key || 'unknown',
    name: run?.name || 'Unknown Agent',
    usedDeterministicContext: Boolean(run?.usedDeterministicContext),
    factsStageStatus: run?.factsStageStatus || 'unknown',
    deterministicFindingIdsSupplied: Array.isArray(run?.deterministicFindingIdsSupplied)
      ? run.deterministicFindingIdsSupplied
      : [],
    settled: {
      status: 'rejected',
      reason: serializeError(run?.settled?.reason),
    },
  };
}

function serializeError(reason) {
  if (!reason) return null;
  if (reason instanceof Error) {
    return {
      name: reason.name,
      message: reason.message,
      stack: reason.stack,
    };
  }
  if (typeof reason === 'object') return reason;
  return { message: String(reason) };
}

export const __internal = Object.freeze({
  DEFAULT_AGENT_CONCURRENCY,
  buildAgentConfigs,
  getAgentConcurrency,
  runAllSettledLimited,
  serializeAgentRun,
});
