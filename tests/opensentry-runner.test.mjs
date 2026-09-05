import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  assertRunnerEnvironment,
  createRunnerServer,
} from '../bin/opensentry-runner.js';
import {
  AnalysisJobStoreInUseError,
  createAnalysisJobStore,
} from '../functions/api/lib/analysis-job-store.js';
import {
  AnalysisJobConflictError,
  AnalysisJobExecutionError,
  AnalysisJobManagerUnavailableError,
  AnalysisJobQueueFullError,
  createAnalysisJobManager,
} from '../functions/api/lib/analysis-jobs.js';

const TOKEN = 'runner-secret';
const JOB_ID = '123e4567-e89b-42d3-a456-426614174000';
const UNKNOWN_JOB_ID = '123e4567-e89b-42d3-a456-426614174001';
const ADDRESS = '0x1111111111111111111111111111111111111111';
const BASE_ENV = { ANALYZE_RELAY_TOKEN: TOKEN };
const AUTH_HEADERS = {
  'content-type': 'application/json',
  'x-opensentry-runner-token': TOKEN,
};

test('runner refuses invalid relay environments before opening storage', () => {
  assert.throws(() => assertRunnerEnvironment({}), /ANALYZE_RELAY_TOKEN is required/);
  assert.throws(
    () => assertRunnerEnvironment({
      ANALYZE_RELAY_TOKEN: TOKEN,
      ANALYZE_RELAY_URL: 'https://relay.example/api/analyze',
    }),
    /ANALYZE_RELAY_URL must not be set/,
  );
});

test('runner initializes persistent storage only after its port is bound', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'opensentry-runner-port-'));
  const databasePath = path.join(directory, 'jobs.sqlite');
  let resolveAnalysis;
  const deferredAnalysis = new Promise((resolve) => { resolveAnalysis = resolve; });
  const first = createRunnerServer({
    env: BASE_ENV,
    databasePath,
    analysisExecutor: () => deferredAnalysis,
  });

  try {
    first.listen(0, '127.0.0.1');
    await once(first, 'listening');
    const address = first.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const created = await createJob(baseUrl);
    const { jobId } = await created.json();
    await waitForJobStatus(first.analysisJobManager, jobId, 'running');

    const second = createRunnerServer({ env: BASE_ENV, databasePath });
    const collision = once(second, 'error');
    second.listen(address.port, '127.0.0.1');
    const [error] = await collision;

    assert.equal(error.code, 'EADDRINUSE');
    assert.equal(second.analysisJobManager, null);
    assert.equal(first.analysisJobManager.getJob(jobId).status, 'running');

    resolveAnalysis({ address: ADDRESS, chain: 'ethereum', report: {} });
    await first.analysisJobManager.whenIdle();
  } finally {
    resolveAnalysis?.({ address: ADDRESS, chain: 'ethereum', report: {} });
    if (first.listening) {
      first.close();
      await once(first, 'close');
    }
    await first.analysisJobManager?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('runner refuses a second process using the same job database on another port', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'opensentry-runner-owner-'));
  const databasePath = path.join(directory, 'jobs.sqlite');
  let resolveAnalysis;
  const deferredAnalysis = new Promise((resolve) => { resolveAnalysis = resolve; });
  const first = createRunnerServer({
    env: BASE_ENV,
    databasePath,
    analysisExecutor: () => deferredAnalysis,
  });
  let second = null;

  try {
    first.listen(0, '127.0.0.1');
    await once(first, 'listening');
    const firstAddress = first.address();
    const created = await createJob(`http://127.0.0.1:${firstAddress.port}`);
    assert.equal(created.status, 202);
    await waitForJobStatus(first.analysisJobManager, JOB_ID, 'running');

    second = createRunnerServer({ env: BASE_ENV, databasePath });
    const closed = once(second, 'close');
    second.listen(0, '127.0.0.1');
    await once(second, 'listening');
    await closed;

    assert.equal(second.listening, false);
    assert.ok(second.analysisJobStartupError instanceof AnalysisJobStoreInUseError);
    assert.equal(second.analysisJobManager, null);
    assert.equal(first.analysisJobManager.getJob(JOB_ID).status, 'running');

    resolveAnalysis({ address: ADDRESS, chain: 'ethereum', report: {} });
    await first.analysisJobManager.whenIdle();
  } finally {
    resolveAnalysis?.({ address: ADDRESS, chain: 'ethereum', report: {} });
    if (second?.listening) {
      second.close();
      await once(second, 'close');
    }
    if (first.listening) {
      first.close();
      await once(first, 'close');
    }
    await first.analysisJobManager?.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('runner closes its socket when persistent storage cannot initialize', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'opensentry-runner-store-'));
  const server = createRunnerServer({
    env: BASE_ENV,
    databasePath: directory,
  });
  const closed = once(server, 'close');

  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    await closed;
    assert.equal(server.listening, false);
    assert.ok(server.analysisJobStartupError instanceof Error);
    assert.equal(server.analysisJobManager, null);
  } finally {
    if (server.listening) {
      server.close();
      await once(server, 'close');
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test('runner health and unknown-route responses are JSON', async () => {
  await withRunner({}, async (baseUrl) => {
    const health = await fetch(`${baseUrl}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { success: true, mode: 'runner' });
    assert.equal(health.headers.get('cache-control'), 'no-store');

    const missing = await fetch(`${baseUrl}/api/unknown`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'not_found');
  });
});

test('POST persists a job and returns 202 without waiting for analysis', async () => {
  let resolveAnalysis;
  const deferredAnalysis = new Promise((resolve) => { resolveAnalysis = resolve; });
  const manager = createAnalysisJobManager({
    store: createAnalysisJobStore({ databasePath: ':memory:' }),
    executor: () => deferredAnalysis,
  });

  await withRunner({ analysisJobManager: manager }, async (baseUrl) => {
    const response = await createJob(baseUrl);
    assert.equal(response.status, 202);
    assert.equal(response.headers.get('location'), `/api/analyze/${JOB_ID}`);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), {
      success: true,
      jobId: JOB_ID,
      status: 'queued',
    });

    const inProgress = await getJob(baseUrl, JOB_ID);
    assert.equal(inProgress.status, 200);
    const progressBody = await inProgress.json();
    assert.ok(['queued', 'running'].includes(progressBody.status));
    assert.equal('result' in progressBody, false);
    assert.equal('error' in progressBody, false);

    resolveAnalysis({
      address: ADDRESS,
      chain: 'ethereum',
      report: { findings: [] },
    });
    await manager.whenIdle();

    const complete = await getJob(baseUrl, JOB_ID);
    assert.deepEqual(await complete.json(), {
      success: true,
      jobId: JOB_ID,
      status: 'succeeded',
      result: {
        address: ADDRESS,
        chain: 'ethereum',
        report: { findings: [] },
      },
    });
  });
});

test('runner returns each persisted job state with mutually exclusive fields', async () => {
  const states = [
    {
      job: { jobId: JOB_ID, status: 'queued', result: null, error: null },
      status: 200,
      body: { success: true, jobId: JOB_ID, status: 'queued' },
    },
    {
      job: { jobId: JOB_ID, status: 'running', result: null, error: null },
      status: 200,
      body: { success: true, jobId: JOB_ID, status: 'running' },
    },
    {
      job: { jobId: JOB_ID, status: 'succeeded', result: { report: {} }, error: null },
      status: 200,
      body: { success: true, jobId: JOB_ID, status: 'succeeded', result: { report: {} } },
    },
    {
      job: {
        jobId: JOB_ID,
        status: 'failed',
        result: null,
        error: { code: 'unverified', message: 'Verified source is required.' },
      },
      status: 200,
      body: {
        success: false,
        jobId: JOB_ID,
        status: 'failed',
        error: 'unverified',
        message: 'Verified source is required.',
      },
    },
    {
      job: { jobId: JOB_ID, status: 'expired', result: null, error: null },
      status: 410,
      body: {
        success: false,
        jobId: JOB_ID,
        status: 'expired',
        error: 'job_expired',
        message: 'This analysis job has expired. Please start a new analysis.',
      },
    },
  ];

  for (const scenario of states) {
    await withRunner({
      analysisJobManager: fakeManager({ getJob: () => scenario.job }),
    }, async (baseUrl) => {
      const response = await getJob(baseUrl, JOB_ID);
      assert.equal(response.status, scenario.status);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), scenario.body);
    });
  }
});

test('runner authenticates both job creation and status requests', async () => {
  let submitCalls = 0;
  let getCalls = 0;
  const manager = fakeManager({
    submit: () => {
      submitCalls += 1;
      return { jobId: JOB_ID, status: 'queued' };
    },
    getJob: () => {
      getCalls += 1;
      return { jobId: JOB_ID, status: 'queued' };
    },
  });

  await withRunner({ analysisJobManager: manager }, async (baseUrl) => {
    const createResponse = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: ADDRESS, chain: 'ethereum' }),
    });
    assert.equal(createResponse.status, 401);

    const statusResponse = await fetch(`${baseUrl}/api/analyze/${JOB_ID}`);
    assert.equal(statusResponse.status, 401);
    assert.equal(submitCalls, 0);
    assert.equal(getCalls, 0);
  });
});

test('runner validates create bodies before submitting jobs', async () => {
  let submitCalls = 0;
  const manager = fakeManager({
    submit: () => {
      submitCalls += 1;
      return { jobId: JOB_ID, status: 'queued' };
    },
  });

  await withRunner({ analysisJobManager: manager }, async (baseUrl) => {
    for (const [rawBody, expectedError] of [
      ['not json', 'invalid_json'],
      [JSON.stringify(null), 'invalid_job_id'],
      [JSON.stringify({ jobId: JOB_ID, address: 'invalid', chain: 'ethereum' }), 'invalid_address'],
      [JSON.stringify({ jobId: JOB_ID, address: ADDRESS, chain: 'solana' }), 'unsupported_chain'],
    ]) {
      const response = await fetch(`${baseUrl}/api/analyze`, {
        method: 'POST',
        headers: AUTH_HEADERS,
        body: rawBody,
      });
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error, expectedError);
    }
    assert.equal(submitCalls, 0);
  });
});

test('runner reports a full queue without returning an orphaned job ID', async () => {
  await withRunner({
    analysisJobManager: fakeManager({
      submit: () => { throw new AnalysisJobQueueFullError(); },
    }),
  }, async (baseUrl) => {
    const response = await createJob(baseUrl);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      success: false,
      error: 'analysis_queue_full',
      message: 'The local analysis queue is full. Please try again later.',
    });
  });
});

test('runner reports idempotency conflicts and manager outages as safe JSON', async () => {
  const scenarios = [
    {
      manager: fakeManager({
        submit: () => { throw new AnalysisJobConflictError(JOB_ID); },
      }),
      request: createJob,
      status: 409,
      error: 'analysis_job_conflict',
    },
    {
      manager: fakeManager({
        submit: () => { throw new AnalysisJobManagerUnavailableError(); },
      }),
      request: createJob,
      status: 503,
      error: 'analysis_job_manager_unavailable',
    },
    {
      manager: fakeManager({
        getJob: () => { throw new AnalysisJobManagerUnavailableError(); },
      }),
      request: (baseUrl) => getJob(baseUrl, JOB_ID),
      status: 503,
      error: 'analysis_job_manager_unavailable',
    },
  ];

  for (const scenario of scenarios) {
    await withRunner({ analysisJobManager: scenario.manager }, async (baseUrl) => {
      const response = await scenario.request(baseUrl);
      assert.equal(response.status, scenario.status);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const body = await response.json();
      assert.equal(body.success, false);
      assert.equal(body.error, scenario.error);
      assert.equal(typeof body.message, 'string');
      assert.ok(body.message.length > 0);
    });
  }
});

test('runner distinguishes malformed, unknown, and extra-segment job paths', async () => {
  await withRunner({ analysisJobManager: fakeManager() }, async (baseUrl) => {
    const malformed = await getJob(baseUrl, 'not-a-uuid');
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).error, 'invalid_job_id');

    const unknown = await getJob(baseUrl, UNKNOWN_JOB_ID);
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, 'job_not_found');

    const extra = await fetch(`${baseUrl}/api/analyze/${JOB_ID}/extra`, {
      headers: { 'x-opensentry-runner-token': TOKEN },
    });
    assert.equal(extra.status, 404);
    assert.equal((await extra.json()).error, 'not_found');
  });
});

test('runner enforces collection and item methods and POST media type', async () => {
  await withRunner({}, async (baseUrl) => {
    const collectionGet = await fetch(`${baseUrl}/api/analyze`, {
      headers: { 'x-opensentry-runner-token': TOKEN },
    });
    assert.equal(collectionGet.status, 405);

    const itemPost = await fetch(`${baseUrl}/api/analyze/${JOB_ID}`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: '{}',
    });
    assert.equal(itemPost.status, 405);

    const wrongMediaType = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        'x-opensentry-runner-token': TOKEN,
      },
      body: '{}',
    });
    assert.equal(wrongMediaType.status, 415);
  });
});

test('runner rejects oversized request bodies before job admission', async () => {
  let submitCalls = 0;
  await withRunner({
    maxRequestBytes: 16,
    analysisJobManager: fakeManager({ submit: () => { submitCalls += 1; } }),
  }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/analyze`, {
      method: 'POST',
      headers: AUTH_HEADERS,
      body: JSON.stringify({ address: 'this body is too large' }),
    });
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error, 'request_too_large');
    assert.equal(submitCalls, 0);
  });
});

test('runner converts unexpected manager failures into safe JSON', async () => {
  const originalError = console.error;
  console.error = () => {};
  try {
    const scenarios = [
      {
        manager: fakeManager({ submit: () => { throw new Error('database path secret'); } }),
        request: createJob,
      },
      {
        manager: fakeManager({ getJob: () => { throw new Error('database path secret'); } }),
        request: (baseUrl) => getJob(baseUrl, JOB_ID),
      },
    ];

    for (const scenario of scenarios) {
      await withRunner({ analysisJobManager: scenario.manager }, async (baseUrl) => {
        const response = await scenario.request(baseUrl);
        assert.equal(response.status, 500);
        const raw = await response.text();
        assert.match(raw, /internal_error/);
        assert.doesNotMatch(raw, /database path secret/);
      });
    }
  } finally {
    console.error = originalError;
  }
});

test('known execution failures become safe terminal job failures', async () => {
  const manager = createAnalysisJobManager({
    store: createAnalysisJobStore({ databasePath: ':memory:' }),
    executor: async () => {
      throw new AnalysisJobExecutionError('unverified', 'Verified source is required.');
    },
  });

  await withRunner({ analysisJobManager: manager }, async (baseUrl) => {
    const created = await createJob(baseUrl);
    assert.equal(created.status, 202);
    await manager.whenIdle();
    const response = await getJob(baseUrl, JOB_ID);
    assert.deepEqual(await response.json(), {
      success: false,
      jobId: JOB_ID,
      status: 'failed',
      error: 'unverified',
      message: 'Verified source is required.',
    });
  });
});

async function createJob(baseUrl) {
  return fetch(`${baseUrl}/api/analyze`, {
    method: 'POST',
    headers: AUTH_HEADERS,
    body: JSON.stringify({ jobId: JOB_ID, address: ADDRESS, chain: 'ethereum' }),
  });
}

async function getJob(baseUrl, jobId) {
  return fetch(`${baseUrl}/api/analyze/${jobId}`, {
    headers: { 'x-opensentry-runner-token': TOKEN },
  });
}

async function waitForJobStatus(manager, jobId, status) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (manager.getJob(jobId)?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail(`Job ${jobId} did not reach ${status}.`);
}

function fakeManager(overrides = {}) {
  return {
    submit: overrides.submit || (() => ({ jobId: JOB_ID, status: 'queued' })),
    getJob: overrides.getJob || (() => null),
    close: overrides.close || (async () => {}),
  };
}

async function withRunner(options, run) {
  const server = createRunnerServer({
    env: { ...BASE_ENV, ...(options.env || {}) },
    analysisJobManager: options.analysisJobManager || fakeManager(),
    maxRequestBytes: options.maxRequestBytes,
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();

  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    server.close();
    await once(server, 'close');
    await server.analysisJobManager.close();
  }
}
