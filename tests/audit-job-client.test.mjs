import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ACTIVE_AUDIT_JOB_STORAGE_KEY,
  __internal,
  clearActiveAuditJob,
  createAuditJob,
  createAuditJobId,
  isAbortError,
  isAmbiguousJobCreationError,
  loadActiveAuditJob,
  pollAuditJob,
  runAuditJob,
  saveActiveAuditJob,
} from '../website/audit-job-client.js';

const ENDPOINT = 'https://opensentry.pages.dev/api/analyze';
const JOB_ID = '2dd20c93-e528-4e75-bd70-cf3e6f1699b9';
const ANALYSIS = {
  address: '0x1111111111111111111111111111111111111111',
  chain: 'ethereum',
  contractName: 'Vault',
  timestamp: '2026-09-04T12:00:00.000Z',
  report: { findings: [], agentSummaries: [] },
};

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function jobStatus(status, overrides = {}) {
  return jsonResponse(200, {
    success: status !== 'failed',
    jobId: JOB_ID,
    status,
    ...overrides,
  });
}

async function rejectedError(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('Expected promise to reject');
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
    values,
  };
}

test('createAuditJob submits exactly once and accepts the queued job contract', async () => {
  const controller = new AbortController();
  const calls = [];
  const result = await createAuditJob({
    endpoint: ENDPOINT,
    jobId: JOB_ID,
    address: ANALYSIS.address,
    chain: ANALYSIS.chain,
    signal: controller.signal,
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(202, { success: true, jobId: JOB_ID, status: 'queued' });
    },
  });

  assert.deepEqual(result, { jobId: JOB_ID, status: 'queued' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.signal, controller.signal);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    jobId: JOB_ID,
    address: ANALYSIS.address,
    chain: ANALYSIS.chain,
  });
});

test('createAuditJob preserves structured server errors without retrying POST', async () => {
  let calls = 0;
  const error = await rejectedError(createAuditJob({
    endpoint: ENDPOINT,
    jobId: JOB_ID,
    address: 'bad',
    chain: 'ethereum',
    fetchFn: async () => {
      calls += 1;
      return jsonResponse(400, {
        success: false,
        error: 'invalid_address',
        message: 'Use a valid address.',
      });
    },
  }));

  assert.equal(calls, 1);
  assert.equal(error.code, 'invalid_address');
  assert.equal(error.message, 'Use a valid address.');
  assert.equal(isAmbiguousJobCreationError(error), false);
  assert.equal(error.jobMayExist, false);
});

test('createAuditJob maps a network failure without retrying POST', async () => {
  let calls = 0;
  const error = await rejectedError(createAuditJob({
    endpoint: ENDPOINT,
    jobId: JOB_ID,
    address: ANALYSIS.address,
    chain: ANALYSIS.chain,
    fetchFn: async () => {
      calls += 1;
      throw new TypeError('connection reset');
    },
  }));

  assert.equal(calls, 1);
  assert.equal(error.code, 'relay_unavailable');
  assert.equal(isAmbiguousJobCreationError(error), true);
  assert.equal(error.jobMayExist, true);
});

test('createAuditJob rejects every malformed success envelope', async () => {
  const cases = [
    jsonResponse(200, { success: true, jobId: JOB_ID, status: 'queued' }),
    jsonResponse(202, { success: false, jobId: JOB_ID, status: 'queued' }),
    jsonResponse(202, { success: true, jobId: '', status: 'queued' }),
    jsonResponse(202, { success: true, jobId: JOB_ID, status: 'mystery' }),
    new Response('not json', { status: 202 }),
  ];

  for (const response of cases) {
    const error = await rejectedError(createAuditJob({
      endpoint: ENDPOINT,
      jobId: JOB_ID,
      address: ANALYSIS.address,
      chain: ANALYSIS.chain,
      fetchFn: async () => response,
    }));
    assert.equal(error.code, 'relay_bad_response');
    assert.equal(isAmbiguousJobCreationError(error), true);
  }
});

test('createAuditJob maps a non-JSON server failure to runner unavailable', async () => {
  const error = await rejectedError(createAuditJob({
    endpoint: ENDPOINT,
    jobId: JOB_ID,
    address: ANALYSIS.address,
    chain: ANALYSIS.chain,
    fetchFn: async () => new Response('<html>gateway error</html>', { status: 503 }),
  }));

  assert.equal(error.code, 'relay_unavailable');
  assert.equal(isAmbiguousJobCreationError(error), true);
});

test('createAuditJobId requires a cryptographically generated version 4 UUID', () => {
  assert.equal(createAuditJobId({ randomUUID: () => JOB_ID }), JOB_ID);
  assert.throws(() => createAuditJobId({}), /UUID generation is unavailable/);
  assert.throws(
    () => createAuditJobId({ randomUUID: () => 'not-a-uuid' }),
    /invalid job ID/,
  );
});

test('createAuditJob requires the client job ID before issuing a request', async () => {
  let calls = 0;
  for (const jobId of [undefined, '', 'not-a-uuid']) {
    const error = await rejectedError(createAuditJob({
      endpoint: ENDPOINT,
      jobId,
      address: ANALYSIS.address,
      chain: ANALYSIS.chain,
      fetchFn: async () => { calls += 1; },
    }));
    assert.equal(error.code, 'relay_bad_response');
  }
  assert.equal(calls, 0);
});

test('createAuditJob accepts an idempotently returned existing job state', async () => {
  for (const status of ['queued', 'running', 'succeeded', 'failed', 'expired']) {
    const result = await createAuditJob({
      endpoint: ENDPOINT,
      jobId: JOB_ID,
      address: ANALYSIS.address,
      chain: ANALYSIS.chain,
      fetchFn: async () => jsonResponse(202, {
        success: true,
        jobId: JOB_ID,
        status,
      }),
    });
    assert.deepEqual(result, { jobId: JOB_ID, status });
  }
});

test('createAuditJob propagates aborts from fetch and response parsing', async () => {
  for (const fetchFn of [
    async () => { throw new DOMException('aborted', 'AbortError'); },
    async () => ({
      ok: true,
      status: 202,
      json: async () => { throw new DOMException('aborted', 'AbortError'); },
    }),
  ]) {
    const error = await rejectedError(createAuditJob({
      endpoint: ENDPOINT,
      jobId: JOB_ID,
      address: ANALYSIS.address,
      chain: ANALYSIS.chain,
      fetchFn,
    }));
    assert.equal(isAbortError(error), true);
  }
});

test('createAuditJob does not submit when already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;

  const error = await rejectedError(createAuditJob({
    endpoint: ENDPOINT,
    jobId: JOB_ID,
    address: ANALYSIS.address,
    chain: ANALYSIS.chain,
    signal: controller.signal,
    fetchFn: async () => {
      calls += 1;
      return jsonResponse(202, { success: true, jobId: JOB_ID, status: 'queued' });
    },
  }));

  assert.equal(calls, 0);
  assert.equal(isAbortError(error), true);
});

test('runAuditJob submits once and polls the same job to completion', async () => {
  const calls = [];
  const result = await runAuditJob({
    endpoint: ENDPOINT,
    jobId: JOB_ID,
    address: ANALYSIS.address,
    chain: ANALYSIS.chain,
    pollIntervalMs: 1,
    waitFn: async () => {},
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'POST') {
        return jsonResponse(202, { success: true, jobId: JOB_ID, status: 'queued' });
      }
      return jobStatus('succeeded', { result: ANALYSIS });
    },
  });

  assert.deepEqual(result, ANALYSIS);
  assert.deepEqual(calls.map(({ url, init }) => [init.method, url]), [
    ['POST', ENDPOINT],
    ['GET', `${ENDPOINT}/${JOB_ID}`],
  ]);
  assert.equal(JSON.parse(calls[0].init.body).jobId, JOB_ID);
});

test('runAuditJob recovers an ambiguous creation by probing the same job ID', async () => {
  const calls = [];
  const waits = [];
  const result = await runAuditJob({
    endpoint: ENDPOINT,
    jobId: JOB_ID,
    address: ANALYSIS.address,
    chain: ANALYSIS.chain,
    pollIntervalMs: 7,
    waitFn: async (delay) => { waits.push(delay); },
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) throw new TypeError('response lost');
      return jobStatus('succeeded', { result: ANALYSIS });
    },
  });

  assert.deepEqual(result, ANALYSIS);
  assert.deepEqual(calls.map(({ url, init }) => [init.method, url]), [
    ['POST', ENDPOINT],
    ['GET', `${ENDPOINT}/${JOB_ID}`],
  ]);
  assert.equal(JSON.parse(calls[0].init.body).jobId, JOB_ID);
  assert.deepEqual(waits, []);
});

test('runAuditJob retries the same creation after an ambiguous response and missing probe', async () => {
  const calls = [];
  const waits = [];
  const result = await runAuditJob({
    endpoint: ENDPOINT,
    jobId: JOB_ID,
    address: ANALYSIS.address,
    chain: ANALYSIS.chain,
    pollIntervalMs: 7,
    waitFn: async delay => waits.push(delay),
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      if (calls.length === 1) throw new TypeError('response lost');
      if (calls.length === 2) return jsonResponse(404, {
        success: false,
        error: 'job_not_found',
        message: 'Missing.',
      });
      if (init.method === 'POST') {
        return jsonResponse(202, { success: true, jobId: JOB_ID, status: 'queued' });
      }
      return jobStatus('succeeded', { result: ANALYSIS });
    },
  });

  assert.deepEqual(result, ANALYSIS);
  assert.deepEqual(calls.map(({ url, init }) => [init.method, url]), [
    ['POST', ENDPOINT],
    ['GET', `${ENDPOINT}/${JOB_ID}`],
    ['POST', ENDPOINT],
    ['GET', `${ENDPOINT}/${JOB_ID}`],
  ]);
  assert.deepEqual(
    calls.filter(({ init }) => init.method === 'POST')
      .map(({ init }) => JSON.parse(init.body).jobId),
    [JOB_ID, JOB_ID],
  );
  assert.deepEqual(waits, [7]);
});

test('runAuditJob does not poll after an unambiguous creation failure', async () => {
  const calls = [];
  const error = await rejectedError(runAuditJob({
    endpoint: ENDPOINT,
    jobId: JOB_ID,
    address: ANALYSIS.address,
    chain: ANALYSIS.chain,
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(400, {
        success: false,
        error: 'invalid_address',
        message: 'Use a valid address.',
      });
    },
  }));

  assert.equal(error.code, 'invalid_address');
  assert.deepEqual(calls.map(({ init }) => init.method), ['POST']);
});

test('runAuditJob preserves the job ID after a definitive manager outage on reconnect', async () => {
  const calls = [];
  const error = await rejectedError(runAuditJob({
    endpoint: ENDPOINT,
    jobId: JOB_ID,
    address: ANALYSIS.address,
    chain: ANALYSIS.chain,
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(503, {
        success: false,
        error: 'analysis_job_manager_unavailable',
        message: 'Restart the local runner.',
      });
    },
  }));

  assert.equal(error.code, 'analysis_job_manager_unavailable');
  assert.equal(error.creationAmbiguous, false);
  assert.equal(error.jobMayExist, true);
  assert.deepEqual(calls.map(({ init }) => init.method), ['POST']);
});

test('runAuditJob reconnects by idempotently submitting the existing job ID', async () => {
  const calls = [];
  const result = await runAuditJob({
    endpoint: ENDPOINT,
    jobId: JOB_ID,
    address: ANALYSIS.address,
    chain: ANALYSIS.chain,
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      if (init.method === 'POST') {
        return jsonResponse(202, { success: true, jobId: JOB_ID, status: 'succeeded' });
      }
      return jobStatus('succeeded', { result: ANALYSIS });
    },
  });

  assert.deepEqual(result, ANALYSIS);
  assert.deepEqual(calls.map(({ url, init }) => [init.method, url]), [
    ['POST', ENDPOINT],
    ['GET', `${ENDPOINT}/${JOB_ID}`],
  ]);
});

test('pollAuditJob waits through queued and running states then returns the analysis payload', async () => {
  const responses = [
    jobStatus('queued'),
    jobStatus('running'),
    jobStatus('succeeded', { result: ANALYSIS }),
  ];
  const calls = [];
  const waits = [];

  const result = await pollAuditJob({
    endpoint: `${ENDPOINT}/`,
    jobId: JOB_ID,
    pollIntervalMs: 7,
    fetchFn: async (url, init) => {
      calls.push({ url, init });
      return responses.shift();
    },
    waitFn: async (delay, signal) => waits.push({ delay, signal }),
  });

  assert.deepEqual(result, ANALYSIS);
  assert.deepEqual(waits.map(({ delay }) => delay), [7, 7]);
  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.url, `${ENDPOINT}/${JOB_ID}`);
    assert.equal(call.init.method, 'GET');
    assert.equal(call.init.headers.Accept, 'application/json');
  }
});

test('pollAuditJob reports a terminal failed job', async () => {
  const error = await rejectedError(pollAuditJob({
    endpoint: ENDPOINT,
    jobId: JOB_ID,
    fetchFn: async () => jobStatus('failed', {
      error: 'unverified',
      message: 'Verified source code is required.',
    }),
    waitFn: async () => {},
  }));

  assert.equal(error.code, 'unverified');
  assert.equal(error.message, 'Verified source code is required.');
  assert.equal(error.jobMayExist, false);
});

test('pollAuditJob maps unknown and expired jobs and never retries 4xx responses', async () => {
  for (const [status, body, expectedCode] of [
    [404, {}, 'job_not_found'],
    [410, {}, 'job_expired'],
    [404, { error: 'custom_not_found', message: 'Gone.' }, 'custom_not_found'],
    [400, {}, 'internal_error'],
  ]) {
    let calls = 0;
    const error = await rejectedError(pollAuditJob({
      endpoint: ENDPOINT,
      jobId: JOB_ID,
      fetchFn: async () => {
        calls += 1;
        return jsonResponse(status, body);
      },
      waitFn: async () => assert.fail('4xx responses must not be retried'),
    }));

    assert.equal(calls, 1);
    assert.equal(error.code, expectedCode);
    assert.equal(error.jobMayExist, false);
  }
});

test('pollAuditJob rejects every malformed or unknown successful status response', async () => {
  const cases = [
    { success: true, status: 'queued' },
    { success: true, jobId: 'wrong-job', status: 'queued' },
    { success: false, jobId: JOB_ID, status: 'queued' },
    { success: false, jobId: JOB_ID, status: 'running' },
    { success: true, jobId: JOB_ID, status: 'succeeded' },
    { success: true, jobId: JOB_ID, status: 'succeeded', result: [] },
    { success: true, jobId: JOB_ID, status: 'succeeded', result: {} },
    { success: true, jobId: JOB_ID, status: 'failed', error: 'failed' },
    { success: false, jobId: JOB_ID, status: 'failed' },
    { success: false, jobId: JOB_ID, status: 'failed', error: 'failed' },
    { success: false, jobId: JOB_ID, status: 'failed', message: 'Failed.' },
    { success: true, jobId: JOB_ID, status: 'mystery' },
  ];

  for (const body of cases) {
    const error = await rejectedError(pollAuditJob({
      endpoint: ENDPOINT,
      jobId: JOB_ID,
      fetchFn: async () => jsonResponse(200, body),
      waitFn: async () => {},
    }));
    assert.equal(error.code, 'relay_bad_response');
  }

  const nonJsonError = await rejectedError(pollAuditJob({
    endpoint: ENDPOINT,
    jobId: JOB_ID,
    fetchFn: async () => new Response('not json', { status: 200 }),
    waitFn: async () => {},
  }));
  assert.equal(nonJsonError.code, 'relay_bad_response');
});

test('pollAuditJob retries only transient transport failures with capped backoff', async () => {
  const responses = [
    new TypeError('network down'),
    new Response('<html>bad gateway</html>', { status: 502 }),
    jsonResponse(502, { error: 'relay_unavailable', message: 'Runner offline.' }),
    jsonResponse(504, { error: 'relay_timeout', message: 'Tunnel timed out.' }),
    jobStatus('running'),
    new Response('<html>gateway timeout</html>', { status: 504 }),
    jobStatus('succeeded', { result: ANALYSIS }),
  ];
  const waits = [];

  const result = await pollAuditJob({
    endpoint: ENDPOINT,
    jobId: JOB_ID,
    pollIntervalMs: 10,
    maxRetryDelayMs: 25,
    fetchFn: async () => {
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    waitFn: async delay => waits.push(delay),
  });

  assert.deepEqual(result, ANALYSIS);
  assert.deepEqual(waits, [10, 20, 25, 25, 10, 10]);
});

test('pollAuditJob surfaces permanent structured 5xx errors without retrying', async () => {
  for (const code of [
    'invalid_relay_config',
    'relay_not_configured',
    'relay_bad_response',
    'internal_error',
    'analysis_queue_full',
    'analysis_job_manager_unavailable',
  ]) {
    let waits = 0;
    const error = await rejectedError(pollAuditJob({
      endpoint: ENDPOINT,
      jobId: JOB_ID,
      fetchFn: async () => jsonResponse(503, {
        success: false,
        error: code,
        message: `Permanent ${code}`,
      }),
      waitFn: async () => { waits += 1; },
    }));

    assert.equal(error.code, code);
    assert.equal(error.message, `Permanent ${code}`);
    assert.equal(error.jobMayExist, true);
    assert.equal(waits, 0);
  }
});

test('pollAuditJob keeps retrying transient failures until it is aborted', async () => {
  const controller = new AbortController();
  let fetchCalls = 0;
  const error = await rejectedError(pollAuditJob({
    endpoint: ENDPOINT,
    jobId: JOB_ID,
    signal: controller.signal,
    pollIntervalMs: 1,
    maxRetryDelayMs: 4,
    fetchFn: async () => {
      fetchCalls += 1;
      throw new TypeError('still offline');
    },
    waitFn: async () => {
      if (fetchCalls === 12) controller.abort();
    },
  }));

  assert.equal(fetchCalls, 12);
  assert.equal(isAbortError(error), true);
});

test('pollAuditJob never overlaps status requests', async () => {
  let calls = 0;
  let inFlight = 0;
  let maximumInFlight = 0;

  const result = await pollAuditJob({
    endpoint: ENDPOINT,
    jobId: JOB_ID,
    fetchFn: async () => {
      calls += 1;
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return calls < 4
        ? jobStatus('running')
        : jobStatus('succeeded', { result: ANALYSIS });
    },
    waitFn: async () => {},
  });

  assert.deepEqual(result, ANALYSIS);
  assert.equal(calls, 4);
  assert.equal(maximumInFlight, 1);
});

test('pollAuditJob handles aborts before fetch, during fetch, and during wait', async () => {
  const beforeFetch = new AbortController();
  beforeFetch.abort();
  let beforeFetchCalls = 0;
  const beforeFetchError = await rejectedError(pollAuditJob({
    endpoint: ENDPOINT,
    jobId: JOB_ID,
    signal: beforeFetch.signal,
    fetchFn: async () => { beforeFetchCalls += 1; },
  }));
  assert.equal(beforeFetchCalls, 0);
  assert.equal(isAbortError(beforeFetchError), true);

  const duringFetchError = await rejectedError(pollAuditJob({
    endpoint: ENDPOINT,
    jobId: JOB_ID,
    fetchFn: async () => { throw new DOMException('aborted', 'AbortError'); },
  }));
  assert.equal(isAbortError(duringFetchError), true);

  const duringWaitError = await rejectedError(pollAuditJob({
    endpoint: ENDPOINT,
    jobId: JOB_ID,
    fetchFn: async () => jobStatus('queued'),
    waitFn: async () => { throw new DOMException('aborted', 'AbortError'); },
  }));
  assert.equal(isAbortError(duringWaitError), true);
});

test('pollAuditJob rejects a missing job ID before making a request', async () => {
  let calls = 0;
  for (const jobId of [undefined, null, '', '   ']) {
    const error = await rejectedError(pollAuditJob({
      endpoint: ENDPOINT,
      jobId,
      fetchFn: async () => { calls += 1; },
    }));
    assert.equal(error.code, 'relay_bad_response');
  }
  assert.equal(calls, 0);
});

test('default polling delay removes its abort listener on completion and rejects on abort', async () => {
  let addedHandler;
  let removedHandler;
  const completedSignal = {
    aborted: false,
    addEventListener(_event, handler) { addedHandler = handler; },
    removeEventListener(_event, handler) { removedHandler = handler; },
  };
  await __internal.waitForDelay(1, completedSignal);
  assert.equal(typeof addedHandler, 'function');
  assert.equal(removedHandler, addedHandler);

  const abortedController = new AbortController();
  const waiting = __internal.waitForDelay(60_000, abortedController.signal);
  abortedController.abort();
  const error = await rejectedError(waiting);
  assert.equal(isAbortError(error), true);
});

test('retryDelay grows exponentially and remains capped', () => {
  assert.equal(__internal.retryDelay(10, 25, 1), 10);
  assert.equal(__internal.retryDelay(10, 25, 2), 20);
  assert.equal(__internal.retryDelay(10, 25, 3), 25);
  assert.equal(__internal.retryDelay(10, 25, 100), 25);
});

test('active job storage round-trips the versioned reconnect record', () => {
  const storage = memoryStorage();
  const job = { jobId: JOB_ID, address: ANALYSIS.address, chain: ANALYSIS.chain };

  assert.equal(saveActiveAuditJob(storage, job), true);
  assert.deepEqual(JSON.parse(storage.values.get(ACTIVE_AUDIT_JOB_STORAGE_KEY)), {
    version: 1,
    ...job,
  });
  assert.deepEqual(loadActiveAuditJob(storage), job);
  assert.equal(clearActiveAuditJob(storage), true);
  assert.equal(loadActiveAuditJob(storage), null);
});

test('active job storage rejects missing and malformed records without throwing', () => {
  for (const raw of [
    null,
    'not json',
    '{}',
    JSON.stringify({ version: 2, jobId: JOB_ID, address: ANALYSIS.address, chain: ANALYSIS.chain }),
    JSON.stringify({ version: 1, jobId: 'not-a-uuid', address: ANALYSIS.address, chain: ANALYSIS.chain }),
    JSON.stringify({ version: 1, jobId: '', address: ANALYSIS.address, chain: ANALYSIS.chain }),
    JSON.stringify({ version: 1, jobId: JOB_ID, address: '', chain: ANALYSIS.chain }),
    JSON.stringify({ version: 1, jobId: JOB_ID, address: ANALYSIS.address, chain: '' }),
  ]) {
    const storage = memoryStorage(raw === null ? {} : { [ACTIVE_AUDIT_JOB_STORAGE_KEY]: raw });
    assert.equal(loadActiveAuditJob(storage), null);
  }

  for (const job of [null, {}, { jobId: JOB_ID }, { jobId: JOB_ID, address: ANALYSIS.address }]) {
    assert.equal(saveActiveAuditJob(memoryStorage(), job), false);
  }
  assert.equal(saveActiveAuditJob(null, {}), false);
  assert.equal(loadActiveAuditJob(null), null);
  assert.equal(clearActiveAuditJob(null), false);
});

test('active job storage failures are nonfatal', () => {
  const brokenStorage = {
    getItem() { throw new Error('blocked'); },
    setItem() { throw new Error('full'); },
    removeItem() { throw new Error('blocked'); },
  };

  assert.equal(loadActiveAuditJob(brokenStorage), null);
  assert.equal(saveActiveAuditJob(brokenStorage, {
    jobId: JOB_ID,
    address: ANALYSIS.address,
    chain: ANALYSIS.chain,
  }), false);
  assert.equal(clearActiveAuditJob(brokenStorage), false);
});

test('audit page uses async job polling with reconnect and lifecycle cleanup', () => {
  const page = readFileSync(new URL('../website/audit-tool.html', import.meta.url), 'utf8');

  assert.match(page, /from '\.\/audit-job-client\.js';/u);
  assert.match(page, /activeJobId = createAuditJobId\(\)/u);
  assert.match(page, /const result = await runAuditJob\(/u);
  assert.match(page, /saveActiveAuditJob\(/u);
  assert.match(page, /loadActiveAuditJob\(/u);
  assert.match(page, /clearActiveAuditJob\(/u);
  assert.match(page, /if \(!error\.jobMayExist\) clearActiveAuditJob/u);
  assert.match(page, /window\.sessionStorage/u);
  assert.doesNotMatch(page, /window\.localStorage/u);
  assert.match(page, /activeAuditController\?\.abort\(\)/u);
  assert.match(page, /window\.addEventListener\('pagehide'/u);
  assert.match(page, /window\.addEventListener\('pageshow'/u);
  assert.match(page, /stopProgressAnimation\(\)/u);
  assert.match(page, />Stop waiting<\/button>/u);
  assert.doesNotMatch(page, /await fetch\(ANALYZE_API_URL/u);
});
