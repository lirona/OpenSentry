#!/usr/bin/env node

import http from 'node:http';

import { onRequest as applyMiddleware } from '../functions/api/_middleware.js';
import {
  ANALYSIS_JOB_STATUS,
  getAnalysisJobIdFromPath,
  isAnalysisJobStatusPath,
} from '../functions/api/lib/analysis-job-contract.js';
import { createAnalysisJobStore } from '../functions/api/lib/analysis-job-store.js';
import {
  AnalysisJobConflictError,
  AnalysisJobManagerUnavailableError,
  AnalysisJobQueueFullError,
  createAnalysisJobManager,
} from '../functions/api/lib/analysis-jobs.js';
import { parseAnalyzeRequest } from '../functions/api/lib/analyze-request.js';
import { runLocalAnalysis } from '../functions/api/lib/local-analyze.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8788;
const MAX_REQUEST_BYTES = 64 * 1024;

export function createRunnerServer(options = {}) {
  const env = options.env || process.env;
  assertRunnerEnvironment(env);
  let analysisJobManager = options.analysisJobManager || null;
  let analysisJobStartupError = null;

  function initializeAnalysisJobs() {
    if (analysisJobManager || analysisJobStartupError) return analysisJobManager;
    try {
      analysisJobManager = createAnalysisJobManager({
        store: options.analysisJobStore || createAnalysisJobStore({
          databasePath: options.databasePath,
        }),
        executor: options.analysisExecutor || (({ address, chain }) => (
          runLocalAnalysis({ address, chain, env })
        )),
      });
      return analysisJobManager;
    } catch (error) {
      analysisJobStartupError = error;
      throw error;
    }
  }

  const server = http.createServer(async (incoming, outgoing) => {
    try {
      const request = await buildWebRequest(incoming, {
        maxRequestBytes: options.maxRequestBytes || MAX_REQUEST_BYTES,
      });
      const response = await applyMiddleware({
        request,
        env,
        next: () => routeRequest(request, analysisJobManager),
      });
      await sendWebResponse(outgoing, response);
    } catch (error) {
      const status = error?.code === 'REQUEST_TOO_LARGE' ? 413 : 500;
      const body = status === 413
        ? {
            success: false,
            error: 'request_too_large',
            message: `Request body exceeds ${options.maxRequestBytes || MAX_REQUEST_BYTES} bytes.`,
          }
        : {
            success: false,
            error: 'internal_error',
            message: 'The local analysis runner encountered an unexpected error.',
          };

      if (status === 500) {
        console.error('Local runner request failed:', error);
      }

      await sendWebResponse(outgoing, jsonResponse(status, body));
    }
  });

  server.prependOnceListener('listening', () => {
    try {
      initializeAnalysisJobs();
    } catch {
      server.close();
    }
  });

  Object.defineProperties(server, {
    analysisJobManager: {
      get: () => analysisJobManager,
      enumerable: false,
    },
    analysisJobStartupError: {
      get: () => analysisJobStartupError,
      enumerable: false,
    },
  });

  return server;
}

export function assertRunnerEnvironment(env) {
  if (!cleanEnvString(env?.ANALYZE_RELAY_TOKEN)) {
    throw new Error('opensentry-runner: ANALYZE_RELAY_TOKEN is required');
  }
  if (cleanEnvString(env?.ANALYZE_RELAY_URL)) {
    throw new Error('opensentry-runner: ANALYZE_RELAY_URL must not be set on the local runner');
  }
}

async function routeRequest(request, analysisJobManager) {
  const url = new URL(request.url);

  if (url.pathname === '/api/health') {
    return jsonResponse(200, {
      success: true,
      mode: 'runner',
    });
  }

  if (url.pathname === '/api/analyze') {
    if (request.method !== 'POST') {
      return jsonResponse(405, {
        success: false,
        error: 'method_not_allowed',
        message: 'Only POST is allowed.',
      });
    }
    const parsed = await parseAnalyzeRequest(request);
    if (!parsed.ok) return parsed.response;

    let job;
    try {
      job = analysisJobManager.submit(parsed.body);
    } catch (error) {
      const response = analysisJobManagerErrorResponse(error);
      if (response) return response;
      throw error;
    }

    return jsonResponse(202, {
      success: true,
      ...job,
    }, {
      location: `/api/analyze/${job.jobId}`,
    });
  }

  if (isAnalysisJobStatusPath(url.pathname)) {
    if (request.method !== 'GET') {
      return jsonResponse(405, {
        success: false,
        error: 'method_not_allowed',
        message: 'Only GET is allowed.',
      });
    }

    const jobId = getAnalysisJobIdFromPath(url.pathname);
    if (!jobId) {
      return jsonResponse(400, {
        success: false,
        error: 'invalid_job_id',
        message: 'The analysis job ID is invalid.',
      });
    }

    let job;
    try {
      job = analysisJobManager.getJob(jobId);
    } catch (error) {
      const response = analysisJobManagerErrorResponse(error);
      if (response) return response;
      throw error;
    }
    if (!job) {
      return jsonResponse(404, {
        success: false,
        error: 'job_not_found',
        message: 'This analysis job could not be found.',
      });
    }

    return analysisJobResponse(job);
  }

  return jsonResponse(404, {
    success: false,
    error: 'not_found',
    message: 'Route not found.',
  });
}

function analysisJobManagerErrorResponse(error) {
  if (error instanceof AnalysisJobConflictError) {
    return jsonResponse(409, {
      success: false,
      error: error.code,
      message: error.message,
    });
  }

  if (
    error instanceof AnalysisJobQueueFullError
    || error instanceof AnalysisJobManagerUnavailableError
  ) {
    return jsonResponse(503, {
      success: false,
      error: error.code,
      message: error.message,
    });
  }

  return null;
}

function analysisJobResponse(job) {
  if (job.status === ANALYSIS_JOB_STATUS.EXPIRED) {
    return jsonResponse(410, {
      success: false,
      jobId: job.jobId,
      status: job.status,
      error: 'job_expired',
      message: 'This analysis job has expired. Please start a new analysis.',
    });
  }

  if (job.status === ANALYSIS_JOB_STATUS.FAILED) {
    return jsonResponse(200, {
      success: false,
      jobId: job.jobId,
      status: job.status,
      error: job.error.code,
      message: job.error.message,
    });
  }

  if (job.status === ANALYSIS_JOB_STATUS.SUCCEEDED) {
    return jsonResponse(200, {
      success: true,
      jobId: job.jobId,
      status: job.status,
      result: job.result,
    });
  }

  if (
    job.status === ANALYSIS_JOB_STATUS.QUEUED
    || job.status === ANALYSIS_JOB_STATUS.RUNNING
  ) {
    return jsonResponse(200, {
      success: true,
      jobId: job.jobId,
      status: job.status,
    });
  }

  throw new Error(`Unsupported analysis job status: ${job.status}`);
}

async function buildWebRequest(incoming, { maxRequestBytes }) {
  const host = incoming.headers.host || `${DEFAULT_HOST}:${DEFAULT_PORT}`;
  const url = new URL(incoming.url || '/', `http://${host}`);
  const body = await readRequestBody(incoming, maxRequestBytes);
  const init = {
    method: incoming.method || 'GET',
    headers: incoming.headers,
  };

  if (body.length > 0) {
    init.body = body;
  }

  return new Request(url, init);
}

async function readRequestBody(incoming, maxRequestBytes) {
  const chunks = [];
  let size = 0;

  for await (const chunk of incoming) {
    size += chunk.length;
    if (size > maxRequestBytes) {
      const error = new Error('Request body is too large');
      error.code = 'REQUEST_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function sendWebResponse(outgoing, response) {
  const body = Buffer.from(await response.arrayBuffer());
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(body);
}

function jsonResponse(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    },
  });
}

function cleanEnvString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export const __internal = Object.freeze({
  DEFAULT_HOST,
  DEFAULT_PORT,
  MAX_REQUEST_BYTES,
  routeRequest,
  buildWebRequest,
  readRequestBody,
  sendWebResponse,
  analysisJobResponse,
  analysisJobManagerErrorResponse,
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const host = cleanEnvString(process.env.RUNNER_HOST) || DEFAULT_HOST;
  const port = parsePort(process.env.PORT);
  const server = createRunnerServer();

  server.listen(port, host, () => {
    if (server.analysisJobStartupError) {
      console.error('OpenSentry runner failed to initialize:', server.analysisJobStartupError);
      process.exitCode = 1;
      return;
    }
    console.log(`OpenSentry runner listening on http://${host}:${port}`);
  });

  let closing = false;
  const close = () => {
    if (closing) return;
    closing = true;
    server.close(async () => {
      try {
        await server.analysisJobManager?.close();
        process.exitCode = 0;
      } catch (error) {
        console.error('OpenSentry runner shutdown failed:', error);
        process.exitCode = 1;
      }
    });
  };

  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

function parsePort(value) {
  if (value == null || value === '') return DEFAULT_PORT;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('opensentry-runner: PORT must be an integer between 1 and 65535');
  }
  return parsed;
}
