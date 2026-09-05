import { analyzeContractSource } from './analyze-pipeline.js';
import { AnalysisJobExecutionError } from './analysis-jobs.js';
import { fetchSource } from './fetch-source.js';

export async function runLocalAnalysis({ address, chain, env }) {
  const sourceResult = await fetchSource(address, chain, env);

  if (!sourceResult.success) {
    throw new AnalysisJobExecutionError(sourceResult.error, sourceResult.message);
  }

  const analysis = await analyzeContractSource({
    sourceResult,
    address,
    chain,
    env,
  });

  if (!analysis || typeof analysis !== 'object' || Array.isArray(analysis)) {
    throw new Error('Analysis pipeline returned an invalid result.');
  }

  return analysis;
}
