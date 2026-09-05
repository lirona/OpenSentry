import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  AnalysisJobResultSerializationError,
  createAnalysisJobStore,
} from '../functions/api/lib/analysis-job-store.js';
import {
  AnalysisJobConflictError,
  AnalysisJobExecutionError,
  AnalysisJobManagerUnavailableError,
  AnalysisJobQueueFullError,
  InvalidAnalysisJobIdError,
  createAnalysisJobManager,
  isAnalysisJobId,
  __internal,
} from '../functions/api/lib/analysis-jobs.js';

const JOB_IDS = Array.from({ length: 12 }, (_, index) => (
  `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`
));
const ADDRESS = '0x1111111111111111111111111111111111111111';

test('submit persists a queued job before returning and never awaits execution', async () => {
  const store = createAnalysisJobStore({ databasePath: ':memory:', clock: () => 1 });
  const execution = deferred();
  let executorCalls = 0;
  const manager = createManager({
    store,
    executor: async () => {
      executorCalls += 1;
      return execution.promise;
    },
  });

  const submission = manager.submit(jobRequest(JOB_IDS[0], 'ethereum'));

  assert.deepEqual(submission, { jobId: JOB_IDS[0], status: 'queued' });
  assert.equal(executorCalls, 0);
  assert.equal(store.getJob(JOB_IDS[0]).status, 'queued');

  await waitFor(() => executorCalls === 1);
  assert.equal(manager.getJob(JOB_IDS[0]).status, 'running');
  execution.resolve({ address: ADDRESS, report: { findings: [] } });
  await manager.whenIdle();

  assert.equal(manager.getJob(JOB_IDS[0]).status, 'succeeded');
  assert.deepEqual(manager.getJob(JOB_IDS[0]).result, {
    address: ADDRESS,
    report: { findings: [] },
  });
  await manager.close();
});

test('manager runs persisted jobs in FIFO order with exactly one active audit', async () => {
  const store = createAnalysisJobStore({ databasePath: ':memory:', clock: () => 1 });
  const executions = [deferred(), deferred(), deferred()];
  const started = [];
  let active = 0;
  let maximumActive = 0;
  const manager = createManager({
    store,
    executor: async ({ chain }) => {
      const index = started.length;
      started.push(chain);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      try {
        await executions[index].promise;
        return { chain };
      } finally {
        active -= 1;
      }
    },
  });

  manager.submit(jobRequest(JOB_IDS[0], 'ethereum'));
  manager.submit(jobRequest(JOB_IDS[1], 'base'));
  manager.submit(jobRequest(JOB_IDS[2], 'polygon'));

  await waitFor(() => started.length === 1);
  assert.deepEqual(started, ['ethereum']);
  executions[0].resolve();
  await waitFor(() => started.length === 2);
  assert.deepEqual(started, ['ethereum', 'base']);
  executions[1].resolve();
  await waitFor(() => started.length === 3);
  assert.deepEqual(started, ['ethereum', 'base', 'polygon']);
  executions[2].resolve();
  await manager.whenIdle();

  assert.equal(maximumActive, 1);
  for (const id of JOB_IDS.slice(0, 3)) {
    assert.equal(manager.getJob(id).status, 'succeeded');
  }
  await manager.close();
});

test('manager enforces the fixed unfinished-job cap and releases capacity after failure', async () => {
  const store = createAnalysisJobStore({ databasePath: ':memory:', clock: () => 1 });
  const firstExecution = deferred();
  let calls = 0;
  const manager = createManager({
    store,
    executor: async ({ chain }) => {
      calls += 1;
      if (calls === 1) {
        await firstExecution.promise;
        throw new AnalysisJobExecutionError('first_failed', 'The first audit failed.');
      }
      return { chain };
    },
  });

  for (let index = 0; index < __internal.MAX_UNFINISHED_JOBS; index += 1) {
    manager.submit(jobRequest(JOB_IDS[index], `chain-${index}`));
  }
  assert.equal(store.countUnfinishedJobs(), __internal.MAX_UNFINISHED_JOBS);
  assert.deepEqual(
    manager.submit(jobRequest(JOB_IDS[7], 'chain-7')),
    { jobId: JOB_IDS[7], status: 'queued' },
  );
  assert.throws(
    () => manager.submit(jobRequest(JOB_IDS[8], 'overflow')),
    error => error instanceof AnalysisJobQueueFullError && error.code === 'analysis_queue_full',
  );

  await waitFor(() => calls === 1);
  firstExecution.resolve();
  await waitFor(() => calls >= 2);
  const replacement = manager.submit(jobRequest(JOB_IDS[8], 'replacement'));
  assert.equal(replacement.jobId, JOB_IDS[8]);

  await manager.whenIdle();
  assert.equal(store.countUnfinishedJobs(), 0);
  assert.equal(manager.getJob(JOB_IDS[0]).status, 'failed');
  assert.equal(manager.getJob(JOB_IDS[8]).status, 'succeeded');
  await manager.close();
});

test('manager stores safe execution errors and hides unexpected exceptions', async () => {
  const store = createAnalysisJobStore({ databasePath: ':memory:', clock: () => 1 });
  const logged = [];
  const manager = createManager({
    store,
    logger: { error: (...args) => logged.push(args) },
    executor: async ({ chain }) => {
      if (chain === 'ethereum') {
        throw new AnalysisJobExecutionError('unverified', 'Contract source is not verified.');
      }
      throw new Error('secret provider detail');
    },
  });

  manager.submit(jobRequest(JOB_IDS[0], 'ethereum'));
  manager.submit(jobRequest(JOB_IDS[1], 'base'));
  await manager.whenIdle();

  assert.deepEqual(manager.getJob(JOB_IDS[0]).error, {
    code: 'unverified',
    message: 'Contract source is not verified.',
  });
  assert.deepEqual(manager.getJob(JOB_IDS[1]).error, __internal.UNEXPECTED_ANALYSIS_ERROR);
  assert.doesNotMatch(manager.getJob(JOB_IDS[1]).error.message, /secret provider detail/);
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /failed unexpectedly/);
  assert.equal(logged[0][1].message, 'secret provider detail');
  await manager.close();
});

test('manager converts an unserializable result to failure and continues safely', async () => {
  const store = createAnalysisJobStore({ databasePath: ':memory:', clock: () => 1 });
  const logged = [];
  const manager = createManager({
    store,
    logger: { error: (...args) => logged.push(args) },
    executor: async ({ chain }) => (
      chain === 'ethereum' ? { unsafeInteger: 1n } : { report: {} }
    ),
  });

  manager.submit(jobRequest(JOB_IDS[0], 'ethereum'));
  manager.submit(jobRequest(JOB_IDS[1], 'base'));
  await manager.whenIdle();

  const job = manager.getJob(JOB_IDS[0]);
  assert.equal(job.status, 'failed');
  assert.deepEqual(job.error, __internal.RESULT_PERSISTENCE_ERROR);
  assert.equal(manager.getJob(JOB_IDS[1]).status, 'succeeded');
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /Failed to save result/);
  await manager.close();
});

test('manager validates client job IDs and request fields before persisting work', async () => {
  const store = createAnalysisJobStore({ databasePath: ':memory:', clock: () => 1 });
  let executorCalls = 0;
  const manager = createManager({
    store,
    executor: async () => {
      executorCalls += 1;
      return {};
    },
  });

  assert.throws(() => manager.submit(), InvalidAnalysisJobIdError);
  assert.throws(
    () => manager.submit({ jobId: JOB_IDS[0], address: '', chain: 'ethereum' }),
    /Analysis address/,
  );
  assert.throws(
    () => manager.submit({ jobId: JOB_IDS[0], address: ADDRESS, chain: '' }),
    /Analysis chain/,
  );
  assert.throws(
    () => manager.submit({ jobId: 'not-a-uuid', address: ADDRESS, chain: 'ethereum' }),
    error => error instanceof InvalidAnalysisJobIdError && error.code === 'invalid_job_id',
  );
  assert.equal(store.countUnfinishedJobs(), 0);
  assert.equal(executorCalls, 0);
  await manager.close();
});

test('manager accepts a valid client UUID and maps it back from storage', async () => {
  const store = createAnalysisJobStore({ databasePath: ':memory:', clock: () => 1 });
  const manager = createAnalysisJobManager({
    store,
    executor: async () => ({ report: {} }),
  });

  const submission = manager.submit(jobRequest(JOB_IDS[0], 'ethereum'));
  assert.deepEqual(submission, { jobId: JOB_IDS[0], status: 'queued' });
  await manager.whenIdle();
  assert.equal(manager.getJob(submission.jobId).status, 'succeeded');
  await manager.close();
});

test('manager returns current state for idempotent duplicates without scheduling duplicate work', async () => {
  const store = createAnalysisJobStore({ databasePath: ':memory:', clock: () => 1 });
  const execution = deferred();
  let calls = 0;
  const manager = createAnalysisJobManager({
    store,
    executor: async () => {
      calls += 1;
      await execution.promise;
      return {};
    },
  });

  const queued = manager.submit(jobRequest(JOB_IDS[0], 'ethereum'));
  const queuedDuplicate = manager.submit(jobRequest(JOB_IDS[0], 'ethereum'));
  assert.deepEqual(queuedDuplicate, queued);
  assert.equal(store.countUnfinishedJobs(), 1);

  await waitFor(() => calls === 1);
  assert.deepEqual(
    manager.submit(jobRequest(JOB_IDS[0], 'ethereum')),
    { jobId: JOB_IDS[0], status: 'running' },
  );
  assert.throws(
    () => manager.submit(jobRequest(JOB_IDS[0], 'base')),
    error => error instanceof AnalysisJobConflictError && error.code === 'analysis_job_conflict',
  );

  execution.resolve();
  await manager.whenIdle();
  assert.deepEqual(
    manager.submit(jobRequest(JOB_IDS[0], 'ethereum')),
    { jobId: JOB_IDS[0], status: 'succeeded' },
  );
  assert.equal(calls, 1);
  await manager.close();
});

test('getJob validates IDs, returns null for unknown jobs, and maps the persisted ID to jobId', async () => {
  const store = createAnalysisJobStore({ databasePath: ':memory:', clock: () => 1 });
  const execution = deferred();
  const manager = createManager({
    store,
    executor: async () => execution.promise,
  });

  assert.equal(isAnalysisJobId(JOB_IDS[0]), true);
  assert.equal(isAnalysisJobId(JOB_IDS[0].toUpperCase()), true);
  assert.equal(isAnalysisJobId('not-a-job'), false);
  assert.throws(
    () => manager.getJob('not-a-job'),
    error => error instanceof InvalidAnalysisJobIdError && error.code === 'invalid_job_id',
  );
  assert.equal(manager.getJob(JOB_IDS[1]), null);

  manager.submit(jobRequest(JOB_IDS[0], 'ethereum'));
  const job = manager.getJob(JOB_IDS[0]);
  assert.equal(job.jobId, JOB_IDS[0]);
  assert.equal(Object.hasOwn(job, 'id'), false);

  execution.resolve({ report: {} });
  await manager.whenIdle();
  await manager.close();
});

test('getJob performs retention cleanup and exposes expired tombstones', async () => {
  let now = 1;
  const store = createAnalysisJobStore({
    databasePath: ':memory:',
    clock: () => now,
    resultRetentionMs: 10,
    tombstoneRetentionMs: 20,
  });
  const manager = createManager({
    store,
    executor: async () => ({ report: {} }),
  });

  manager.submit(jobRequest(JOB_IDS[0], 'ethereum'));
  await manager.whenIdle();
  now = 11;
  assert.equal(manager.getJob(JOB_IDS[0]).status, 'expired');
  now = 31;
  assert.equal(manager.getJob(JOB_IDS[0]), null);
  await manager.close();
});

test('manager fails closed when the queued-to-running transition cannot be persisted', async () => {
  const transitionError = new Error('start write failed');
  const executed = [];
  const logged = [];
  const store = makeFakeStore({
    startJob() {
      throw transitionError;
    },
  });
  const manager = createManager({
    store,
    logger: { error: (...args) => logged.push(args) },
    executor: async ({ chain }) => {
      executed.push(chain);
      return {};
    },
  });

  manager.submit(jobRequest(JOB_IDS[0], 'ethereum'));
  manager.submit(jobRequest(JOB_IDS[1], 'base'));
  await manager.whenIdle();

  assert.deepEqual(executed, []);
  assert.equal(store.peekJob(JOB_IDS[0]).status, 'queued');
  assert.equal(store.peekJob(JOB_IDS[1]).status, 'queued');
  assertManagerUnavailable(manager, transitionError);
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /Failed to start/);
  await manager.close();
  assert.equal(store.closed, true);
});

test('manager fails closed when a failed terminal transition cannot be persisted', async () => {
  const transitionError = new Error('failure write failed');
  const executed = [];
  const logged = [];
  const store = makeFakeStore({
    failJob() {
      throw transitionError;
    },
  });
  const manager = createManager({
    store,
    logger: { error: (...args) => logged.push(args) },
    executor: async ({ chain }) => {
      executed.push(chain);
      if (chain === 'ethereum') {
        throw new AnalysisJobExecutionError('failed', 'Expected failure.');
      }
      return {};
    },
  });

  manager.submit(jobRequest(JOB_IDS[0], 'ethereum'));
  manager.submit(jobRequest(JOB_IDS[1], 'base'));
  await manager.whenIdle();

  assert.deepEqual(executed, ['ethereum']);
  assert.equal(store.peekJob(JOB_IDS[0]).status, 'running');
  assert.equal(store.peekJob(JOB_IDS[1]).status, 'queued');
  assertManagerUnavailable(manager, transitionError);
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /Failed to save failure/);
  await manager.close();
  assert.equal(store.closed, true);
});

test('manager fails closed when a successful terminal transition cannot be persisted', async () => {
  const transitionError = new Error('success write failed');
  const executed = [];
  const logged = [];
  const store = makeFakeStore({
    succeedJob() {
      throw transitionError;
    },
  });
  const manager = createManager({
    store,
    logger: { error: (...args) => logged.push(args) },
    executor: async ({ chain }) => {
      executed.push(chain);
      return {};
    },
  });

  manager.submit(jobRequest(JOB_IDS[0], 'ethereum'));
  manager.submit(jobRequest(JOB_IDS[1], 'base'));
  await manager.whenIdle();

  assert.deepEqual(executed, ['ethereum']);
  assert.equal(store.peekJob(JOB_IDS[0]).status, 'running');
  assert.equal(store.peekJob(JOB_IDS[1]).status, 'queued');
  assertManagerUnavailable(manager, transitionError);
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /Failed to save result/);
  await manager.close();
  assert.equal(store.closed, true);
});

test('faulted manager rows remain durable for next-start interruption reconciliation', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'opensentry-faulted-manager-'));
  const databasePath = path.join(directory, 'analysis-jobs.sqlite');

  try {
    const underlying = createAnalysisJobStore({ databasePath, clock: () => 1 });
    const transitionError = new Error('success write failed');
    const store = {
      ...underlying,
      succeedJob() {
        throw transitionError;
      },
    };
    const manager = createManager({
      store,
      logger: { error: () => {} },
      executor: async () => ({ report: {} }),
    });

    manager.submit(jobRequest(JOB_IDS[0], 'ethereum'));
    manager.submit(jobRequest(JOB_IDS[1], 'base'));
    await manager.whenIdle();
    assert.equal(underlying.getJob(JOB_IDS[0]).status, 'running');
    assert.equal(underlying.getJob(JOB_IDS[1]).status, 'queued');
    await manager.close();

    const reopened = createAnalysisJobStore({ databasePath, clock: () => 2 });
    assert.equal(reopened.startupInterruptedCount, 2);
    for (const jobId of JOB_IDS.slice(0, 2)) {
      assert.equal(reopened.getJob(jobId).status, 'failed');
      assert.equal(reopened.getJob(jobId).error.code, 'analysis_interrupted');
    }
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('manager faults without attempting a competing transition after a commit-then-throw', async () => {
  const transitionError = new Error('read after success failed');
  const baseStore = makeFakeStore();
  let failureWrites = 0;
  const store = {
    ...baseStore,
    succeedJob(id, result) {
      baseStore.succeedJob(id, result);
      throw transitionError;
    },
    failJob() {
      failureWrites += 1;
    },
  };
  const manager = createManager({
    store,
    logger: { error: () => {} },
    executor: async () => ({ report: {} }),
  });

  manager.submit(jobRequest(JOB_IDS[0], 'ethereum'));
  manager.submit(jobRequest(JOB_IDS[1], 'base'));
  await manager.whenIdle();

  assert.equal(baseStore.peekJob(JOB_IDS[0]).status, 'succeeded');
  assert.equal(baseStore.peekJob(JOB_IDS[1]).status, 'queued');
  assert.equal(failureWrites, 0);
  assertManagerUnavailable(manager, transitionError);
  await manager.close();
});

test('serialization fallback persistence failure faults the manager', async () => {
  const transitionError = new Error('fallback failure write failed');
  const store = makeFakeStore({
    succeedJob() {
      throw new AnalysisJobResultSerializationError();
    },
    failJob() {
      throw transitionError;
    },
  });
  const manager = createManager({
    store,
    logger: { error: () => {} },
    executor: async () => ({ unsafeInteger: 1n }),
  });

  manager.submit(jobRequest(JOB_IDS[0], 'ethereum'));
  manager.submit(jobRequest(JOB_IDS[1], 'base'));
  await manager.whenIdle();

  assert.equal(store.peekJob(JOB_IDS[0]).status, 'running');
  assert.equal(store.peekJob(JOB_IDS[1]).status, 'queued');
  assertManagerUnavailable(manager, transitionError);
  await manager.close();
});

test('a throwing logger cannot prevent transition failure from faulting the manager', async () => {
  const transitionError = new Error('start write failed');
  const executed = [];
  const store = makeFakeStore({
    startJob() {
      throw transitionError;
    },
  });
  const manager = createManager({
    store,
    logger: {
      error() {
        throw new Error('logger failed');
      },
    },
    executor: async ({ chain }) => {
      executed.push(chain);
      return {};
    },
  });

  manager.submit(jobRequest(JOB_IDS[0], 'ethereum'));
  manager.submit(jobRequest(JOB_IDS[1], 'base'));
  await manager.whenIdle();

  assert.deepEqual(executed, []);
  assert.equal(store.peekJob(JOB_IDS[0]).status, 'queued');
  assert.equal(store.peekJob(JOB_IDS[1]).status, 'queued');
  assertManagerUnavailable(manager, transitionError);
  await manager.close();
});

test('periodic cleanup failures are logged and closing clears the timer', async () => {
  const cleanupError = new Error('cleanup failed');
  const logged = [];
  let timerCallback;
  let clearedTimer;
  const timerHandle = { unrefCalled: false, unref() { this.unrefCalled = true; } };
  const store = makeFakeStore({
    cleanupExpiredJobs() {
      throw cleanupError;
    },
  });
  const manager = createAnalysisJobManager({
    store,
    executor: async () => ({}),
    logger: { error: (...args) => logged.push(args) },
    setIntervalFn(callback, delay) {
      timerCallback = callback;
      assert.equal(delay, __internal.CLEANUP_INTERVAL_MS);
      return timerHandle;
    },
    clearIntervalFn(handle) {
      clearedTimer = handle;
    },
  });

  assert.equal(timerHandle.unrefCalled, true);
  timerCallback();
  assert.equal(logged.length, 1);
  assert.match(logged[0][0], /cleanup failed/i);
  assertManagerUnavailable(manager, cleanupError);

  await manager.close();
  assert.equal(clearedTimer, timerHandle);
  assert.equal(store.closed, true);
});

test('every submit store failure makes the manager consistently unavailable', async () => {
  const scenarios = [
    ['cleanup', 'cleanupExpiredJobs'],
    ['existing-job lookup', 'getJob'],
    ['unfinished count', 'countUnfinishedJobs'],
    ['job admission', 'createOrGetJob'],
  ];

  for (const [name, method] of scenarios) {
    const cause = new Error(`${name} failed`);
    const store = makeFakeStore({
      [method]() {
        throw cause;
      },
    });
    const manager = createManager({ store, executor: async () => ({}) });

    assertUnavailableThrown(
      () => manager.submit(jobRequest(JOB_IDS[0], 'ethereum')),
      cause,
    );
    assertManagerUnavailable(manager, cause);
    await manager.close();
    assert.equal(store.closed, true);
  }
});

test('every getJob store failure makes the manager consistently unavailable', async () => {
  for (const [name, method] of [
    ['cleanup', 'cleanupExpiredJobs'],
    ['job lookup', 'getJob'],
  ]) {
    const cause = new Error(`${name} failed`);
    const store = makeFakeStore({
      [method]() {
        throw cause;
      },
    });
    const manager = createManager({ store, executor: async () => ({}) });

    assertUnavailableThrown(() => manager.getJob(JOB_IDS[0]), cause);
    assertManagerUnavailable(manager, cause);
    await manager.close();
    assert.equal(store.closed, true);
  }
});

test('explicit cleanup failure makes the manager consistently unavailable', async () => {
  const cause = new Error('explicit cleanup failed');
  const store = makeFakeStore({
    cleanupExpiredJobs() {
      throw cause;
    },
  });
  const manager = createManager({ store, executor: async () => ({}) });

  assertUnavailableThrown(() => manager.cleanupExpiredJobs(), cause);
  assertManagerUnavailable(manager, cause);
  await manager.close();
  assert.equal(store.closed, true);
});

test('periodic cleanup failure cancels scheduled work without orphan execution', async () => {
  const cause = new Error('periodic cleanup failed');
  const executed = [];
  let cleanupCalls = 0;
  let timerCallback;
  const store = makeFakeStore({
    cleanupExpiredJobs() {
      cleanupCalls += 1;
      if (cleanupCalls === 1) return { expiredCount: 0, deletedCount: 0 };
      throw cause;
    },
  });
  const manager = createAnalysisJobManager({
    store,
    executor: async ({ chain }) => {
      executed.push(chain);
      return {};
    },
    logger: { error: () => {} },
    setIntervalFn(callback) {
      timerCallback = callback;
      return { unref() {} };
    },
    clearIntervalFn() {},
  });

  manager.submit(jobRequest(JOB_IDS[0], 'ethereum'));
  timerCallback();
  await manager.whenIdle();
  await Promise.resolve();

  assert.deepEqual(executed, []);
  assert.equal(store.peekJob(JOB_IDS[0]).status, 'queued');
  assertManagerUnavailable(manager, cause);
  await manager.close();
});

test('close rejects new work, waits for queued work, closes once, and is idempotent', async () => {
  const underlying = createAnalysisJobStore({ databasePath: ':memory:', clock: () => 1 });
  let closeCalls = 0;
  const store = {
    createOrGetJob: underlying.createOrGetJob,
    getJob: underlying.getJob,
    countUnfinishedJobs: underlying.countUnfinishedJobs,
    startJob: underlying.startJob,
    succeedJob: underlying.succeedJob,
    failJob: underlying.failJob,
    cleanupExpiredJobs: underlying.cleanupExpiredJobs,
    close() {
      closeCalls += 1;
      underlying.close();
    },
  };
  const execution = deferred();
  const manager = createManager({
    store,
    executor: async () => execution.promise,
  });
  manager.submit(jobRequest(JOB_IDS[0], 'ethereum'));
  await waitFor(() => underlying.getJob(JOB_IDS[0]).status === 'running');

  const firstClose = manager.close();
  const secondClose = manager.close();
  assert.equal(firstClose, secondClose);
  assert.throws(
    () => manager.submit(jobRequest(JOB_IDS[1], 'base')),
    error => error.code === 'analysis_job_manager_closed',
  );
  let closed = false;
  firstClose.then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);

  execution.resolve({ report: {} });
  await firstClose;
  assert.equal(closeCalls, 1);
  assert.throws(() => underlying.getJob(JOB_IDS[0]), /closed/);
});

test('manager validates construction dependencies and execution-error arguments', () => {
  const validStore = makeFakeStore();

  assert.throws(() => createAnalysisJobManager(), /store/);
  assert.throws(() => createAnalysisJobManager({ store: {}, executor: async () => ({}) }), /store/);
  assert.throws(() => createAnalysisJobManager({ store: validStore }), /executor/);
  assert.throws(
    () => createAnalysisJobManager({ store: validStore, executor: async () => ({}), logger: {} }),
    /logger.error/,
  );
  assert.throws(
    () => createAnalysisJobManager({ store: validStore, executor: async () => ({}), setIntervalFn: 1 }),
    /timer functions/,
  );
  assert.throws(() => new AnalysisJobExecutionError('', 'message'), /code/);
  assert.throws(() => new AnalysisJobExecutionError('failed', ''), /message/);
});

function createManager({ store, executor, logger } = {}) {
  return createAnalysisJobManager({
    store,
    executor,
    logger,
  });
}

function makeFakeStore(overrides = {}) {
  const jobs = new Map();
  const store = {
    closed: false,
    createOrGetJob({ id, address, chain }) {
      const existing = jobs.get(id);
      if (existing) {
        if (existing.address !== address || existing.chain !== chain) {
          throw new AnalysisJobConflictError(id);
        }
        return { created: false, job: existing };
      }
      const job = { id, status: 'queued', address, chain };
      jobs.set(id, job);
      return { created: true, job };
    },
    getJob(id) {
      return jobs.get(id) || null;
    },
    countUnfinishedJobs() {
      return [...jobs.values()].filter(job => job.status === 'queued' || job.status === 'running').length;
    },
    startJob(id) {
      const job = { ...jobs.get(id), status: 'running' };
      jobs.set(id, job);
      return job;
    },
    succeedJob(id, result) {
      jobs.set(id, { ...jobs.get(id), status: 'succeeded', result });
    },
    failJob(id, error) {
      jobs.set(id, { ...jobs.get(id), status: 'failed', error });
    },
    cleanupExpiredJobs() {
      return { expiredCount: 0, deletedCount: 0 };
    },
    close() {
      store.closed = true;
    },
    peekJob(id) {
      return jobs.get(id) || null;
    },
    ...overrides,
  };
  return store;
}

function jobRequest(jobId, chain) {
  return { jobId, address: ADDRESS, chain };
}

function assertManagerUnavailable(manager, cause) {
  const errors = [];
  for (const operation of [
    () => manager.submit(jobRequest(JOB_IDS[11], 'polygon')),
    () => manager.getJob(JOB_IDS[0]),
    () => manager.cleanupExpiredJobs(),
  ]) {
    assert.throws(operation, (error) => {
      errors.push(error);
      return (
        error instanceof AnalysisJobManagerUnavailableError
        && error.code === 'analysis_job_manager_unavailable'
        && error.cause === cause
        && !error.message.includes(cause.message)
      );
    });
  }
  assert.equal(new Set(errors).size, 1);
}

function assertUnavailableThrown(operation, cause) {
  assert.throws(operation, error => (
    error instanceof AnalysisJobManagerUnavailableError
    && error.code === 'analysis_job_manager_unavailable'
    && error.cause === cause
  ));
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Condition was not met before the test deadline.');
}
