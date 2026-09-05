import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import {
  ANALYSIS_INTERRUPTED_ERROR,
  AnalysisJobConflictError,
  AnalysisJobResultSerializationError,
  AnalysisJobStateError,
  AnalysisJobStoreInUseError,
  createAnalysisJobStore,
  __internal,
} from '../functions/api/lib/analysis-job-store.js';

const JOB_A = '00000000-0000-4000-8000-000000000001';
const JOB_B = '00000000-0000-4000-8000-000000000002';
const JOB_C = '00000000-0000-4000-8000-000000000003';
const JOB_D = '00000000-0000-4000-8000-000000000004';
const ADDRESS = '0x1111111111111111111111111111111111111111';

test('store creates a durable queued job before returning it', async () => {
  await withDatabase(async ({ databasePath }) => {
    let now = 1_000;
    const store = createAnalysisJobStore({ databasePath, clock: () => now });

    const admission = store.createOrGetJob({ id: JOB_A, address: ADDRESS, chain: 'ethereum' });
    const { job } = admission;

    assert.equal(admission.created, true);
    assert.deepEqual(job, {
      id: JOB_A,
      status: 'queued',
      address: ADDRESS,
      chain: 'ethereum',
      result: null,
      error: null,
      createdAt: new Date(1_000).toISOString(),
      startedAt: null,
      completedAt: null,
      expiresAt: null,
      expiredAt: null,
    });
    assert.equal(store.countUnfinishedJobs(), 1);

    store.close();
    now = 2_000;
    const reopened = createAnalysisJobStore({ databasePath, clock: () => now });
    assert.equal(reopened.startupInterruptedCount, 1);
    assert.equal(reopened.getJob(JOB_A).status, 'failed');
    reopened.close();
  });
});

test('store persists successful and failed terminal jobs across reopen', async () => {
  await withDatabase(async ({ databasePath }) => {
    let now = 10;
    const store = createAnalysisJobStore({
      databasePath,
      clock: () => now,
      resultRetentionMs: 1_000,
    });

    store.createOrGetJob({ id: JOB_A, address: ADDRESS, chain: 'ethereum' });
    now = 20;
    store.startJob(JOB_A);
    now = 30;
    store.succeedJob(JOB_A, { contractName: 'Vault', report: { findings: [] } });

    store.createOrGetJob({ id: JOB_B, address: ADDRESS, chain: 'base' });
    now = 40;
    store.startJob(JOB_B);
    now = 50;
    store.failJob(JOB_B, { code: 'unverified', message: 'Source is not verified.' });
    store.close();

    now = 60;
    const reopened = createAnalysisJobStore({
      databasePath,
      clock: () => now,
      resultRetentionMs: 1_000,
    });

    assert.equal(reopened.startupInterruptedCount, 0);
    assert.deepEqual(reopened.getJob(JOB_A), {
      id: JOB_A,
      status: 'succeeded',
      address: ADDRESS,
      chain: 'ethereum',
      result: { contractName: 'Vault', report: { findings: [] } },
      error: null,
      createdAt: new Date(10).toISOString(),
      startedAt: new Date(20).toISOString(),
      completedAt: new Date(30).toISOString(),
      expiresAt: new Date(1_030).toISOString(),
      expiredAt: null,
    });
    assert.deepEqual(reopened.getJob(JOB_B).error, {
      code: 'unverified',
      message: 'Source is not verified.',
    });
    assert.equal(reopened.getJob(JOB_B).status, 'failed');
    assert.equal(reopened.countUnfinishedJobs(), 0);
    reopened.close();
  });
});

test('startup converts every queued and running job to an interrupted failure', async () => {
  await withDatabase(async ({ databasePath }) => {
    let now = 100;
    const first = createAnalysisJobStore({
      databasePath,
      clock: () => now,
      resultRetentionMs: 500,
    });
    first.createOrGetJob({ id: JOB_A, address: ADDRESS, chain: 'ethereum' });
    first.createOrGetJob({ id: JOB_B, address: ADDRESS, chain: 'base' });
    now = 150;
    first.startJob(JOB_B);
    first.close();

    now = 200;
    const second = createAnalysisJobStore({
      databasePath,
      clock: () => now,
      resultRetentionMs: 500,
    });

    assert.equal(second.startupInterruptedCount, 2);
    for (const id of [JOB_A, JOB_B]) {
      const job = second.getJob(id);
      assert.equal(job.status, 'failed');
      assert.deepEqual(job.error, ANALYSIS_INTERRUPTED_ERROR);
      assert.equal(job.completedAt, new Date(200).toISOString());
      assert.equal(job.expiresAt, new Date(700).toISOString());
    }
    assert.equal(second.getJob(JOB_A).startedAt, null);
    assert.equal(second.getJob(JOB_B).startedAt, new Date(150).toISOString());
    second.close();
  });
});

test('store enforces queued to running to one immutable terminal state', () => {
  let now = 1;
  const store = createAnalysisJobStore({ databasePath: ':memory:', clock: () => now });
  store.createOrGetJob({ id: JOB_A, address: ADDRESS, chain: 'ethereum' });

  assert.throws(
    () => store.succeedJob(JOB_A, {}),
    error => error instanceof AnalysisJobStateError && error.code === 'invalid_job_state',
  );
  assert.throws(
    () => store.failJob(JOB_A, { code: 'failed', message: 'failed' }),
    error => error instanceof AnalysisJobStateError && error.code === 'invalid_job_state',
  );

  now = 2;
  store.startJob(JOB_A);
  assert.throws(() => store.startJob(JOB_A), AnalysisJobStateError);
  now = 3;
  store.succeedJob(JOB_A, { ok: true });

  assert.throws(
    () => store.succeedJob(JOB_A, { replaced: true }),
    AnalysisJobStateError,
  );
  assert.throws(
    () => store.failJob(JOB_A, { code: 'late_failure', message: 'Too late.' }),
    AnalysisJobStateError,
  );
  assert.deepEqual(store.getJob(JOB_A).result, { ok: true });
  store.close();
});

test('store distinguishes missing jobs from jobs in the wrong state', () => {
  const store = createAnalysisJobStore({ databasePath: ':memory:', clock: () => 1 });

  assert.throws(
    () => store.startJob(JOB_A),
    error => error instanceof AnalysisJobStateError && error.code === 'job_not_found',
  );
  assert.throws(
    () => store.succeedJob(JOB_A, {}),
    error => error instanceof AnalysisJobStateError && error.code === 'job_not_found',
  );
  assert.throws(
    () => store.failJob(JOB_A, { code: 'failed', message: 'failed' }),
    error => error instanceof AnalysisJobStateError && error.code === 'job_not_found',
  );
  assert.equal(store.getJob(JOB_A), null);
  store.close();
});

test('store returns matching duplicate IDs and rejects request fingerprint conflicts', () => {
  const store = createAnalysisJobStore({ databasePath: ':memory:', clock: () => 1 });
  const first = store.createOrGetJob({ id: JOB_A, address: ADDRESS, chain: 'ethereum' });
  const duplicate = store.createOrGetJob({ id: JOB_A, address: ADDRESS, chain: 'ethereum' });

  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.deepEqual(duplicate.job, first.job);
  assert.throws(
    () => store.createOrGetJob({ id: JOB_A, address: ADDRESS, chain: 'base' }),
    error => (
      error instanceof AnalysisJobConflictError
      && error.code === 'analysis_job_conflict'
      && error.jobId === JOB_A
    ),
  );
  assert.throws(() => store.createOrGetJob({ id: '', address: ADDRESS, chain: 'base' }), TypeError);
  assert.throws(() => store.createOrGetJob({ id: JOB_B, address: '', chain: 'base' }), TypeError);
  assert.throws(() => store.createOrGetJob({ id: JOB_B, address: ADDRESS, chain: '' }), TypeError);

  assert.equal(store.getJob(JOB_A).chain, 'ethereum');
  assert.equal(store.countUnfinishedJobs(), 1);
  store.close();
});

test('store returns the current state for matching duplicate requests in every state', () => {
  let now = 1;
  const store = createAnalysisJobStore({
    databasePath: ':memory:',
    clock: () => now,
    resultRetentionMs: 10,
    tombstoneRetentionMs: 10,
  });

  store.createOrGetJob({ id: JOB_A, address: ADDRESS, chain: 'ethereum' });
  store.startJob(JOB_A);
  let duplicate = store.createOrGetJob({ id: JOB_A, address: ADDRESS, chain: 'ethereum' });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.job.status, 'running');

  store.succeedJob(JOB_A, { report: {} });
  duplicate = store.createOrGetJob({ id: JOB_A, address: ADDRESS, chain: 'ethereum' });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.job.status, 'succeeded');

  store.createOrGetJob({ id: JOB_B, address: ADDRESS, chain: 'base' });
  store.startJob(JOB_B);
  store.failJob(JOB_B, { code: 'failed', message: 'Failed.' });
  duplicate = store.createOrGetJob({ id: JOB_B, address: ADDRESS, chain: 'base' });
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.job.status, 'failed');

  now = 11;
  store.cleanupExpiredJobs();
  for (const [id, chain] of [[JOB_A, 'ethereum'], [JOB_B, 'base']]) {
    duplicate = store.createOrGetJob({ id, address: ADDRESS, chain });
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.job.status, 'expired');
    assert.throws(
      () => store.createOrGetJob({ id, address: ADDRESS, chain: 'polygon' }),
      AnalysisJobConflictError,
    );
  }

  store.close();
});

test('store rejects invalid errors and non-serializable results without changing running state', () => {
  const store = createAnalysisJobStore({ databasePath: ':memory:', clock: () => 1 });
  store.createOrGetJob({ id: JOB_A, address: ADDRESS, chain: 'ethereum' });
  store.startJob(JOB_A);

  assert.throws(() => store.failJob(JOB_A, null), TypeError);
  assert.throws(() => store.failJob(JOB_A, { code: '', message: 'failed' }), TypeError);
  assert.throws(() => store.failJob(JOB_A, { code: 'failed', message: '' }), TypeError);
  assert.throws(() => store.succeedJob(JOB_A, undefined), AnalysisJobResultSerializationError);
  assert.throws(() => store.succeedJob(JOB_A, { value: 1n }), AnalysisJobResultSerializationError);

  const circular = {};
  circular.self = circular;
  assert.throws(() => store.succeedJob(JOB_A, circular), AnalysisJobResultSerializationError);
  assert.equal(store.getJob(JOB_A).status, 'running');
  store.close();
});

test('cleanup converts due terminal jobs to tombstones and later deletes them', () => {
  let now = 10;
  const store = createAnalysisJobStore({
    databasePath: ':memory:',
    clock: () => now,
    resultRetentionMs: 100,
    tombstoneRetentionMs: 200,
  });

  store.createOrGetJob({ id: JOB_A, address: ADDRESS, chain: 'ethereum' });
  store.startJob(JOB_A);
  store.succeedJob(JOB_A, { report: true });
  store.createOrGetJob({ id: JOB_B, address: ADDRESS, chain: 'base' });
  store.startJob(JOB_B);
  store.failJob(JOB_B, { code: 'unverified', message: 'Not verified.' });

  now = 109;
  assert.deepEqual(store.cleanupExpiredJobs(), { expiredCount: 0, deletedCount: 0 });
  now = 110;
  assert.deepEqual(store.cleanupExpiredJobs(), { expiredCount: 2, deletedCount: 0 });

  for (const id of [JOB_A, JOB_B]) {
    const tombstone = store.getJob(id);
    assert.equal(tombstone.status, 'expired');
    assert.equal(tombstone.address, null);
    assert.equal(tombstone.chain, null);
    assert.equal(tombstone.result, null);
    assert.equal(tombstone.error, null);
    assert.equal(tombstone.expiresAt, null);
    assert.equal(tombstone.expiredAt, new Date(110).toISOString());
  }

  now = 309;
  assert.deepEqual(store.cleanupExpiredJobs(), { expiredCount: 0, deletedCount: 0 });
  now = 310;
  assert.deepEqual(store.cleanupExpiredJobs(), { expiredCount: 0, deletedCount: 2 });
  assert.equal(store.getJob(JOB_A), null);
  assert.equal(store.getJob(JOB_B), null);
  store.close();
});

test('cleanup never expires queued or running jobs', () => {
  let now = 1;
  const store = createAnalysisJobStore({
    databasePath: ':memory:',
    clock: () => now,
    resultRetentionMs: 10,
    tombstoneRetentionMs: 10,
  });
  store.createOrGetJob({ id: JOB_A, address: ADDRESS, chain: 'ethereum' });
  store.createOrGetJob({ id: JOB_B, address: ADDRESS, chain: 'base' });
  store.startJob(JOB_B);

  now = 10_000;
  assert.deepEqual(store.cleanupExpiredJobs(), { expiredCount: 0, deletedCount: 0 });
  assert.equal(store.getJob(JOB_A).status, 'queued');
  assert.equal(store.getJob(JOB_B).status, 'running');
  store.close();
});

test('startup cleanup expires offline results and later purges their tombstones', async () => {
  await withDatabase(async ({ databasePath }) => {
    let now = 1;
    const first = createAnalysisJobStore({
      databasePath,
      clock: () => now,
      resultRetentionMs: 10,
      tombstoneRetentionMs: 20,
    });
    first.createOrGetJob({ id: JOB_A, address: ADDRESS, chain: 'ethereum' });
    first.startJob(JOB_A);
    first.succeedJob(JOB_A, { report: {} });
    first.close();

    now = 11;
    const second = createAnalysisJobStore({
      databasePath,
      clock: () => now,
      resultRetentionMs: 10,
      tombstoneRetentionMs: 20,
    });
    assert.equal(second.getJob(JOB_A).status, 'expired');
    second.close();

    now = 31;
    const third = createAnalysisJobStore({
      databasePath,
      clock: () => now,
      resultRetentionMs: 10,
      tombstoneRetentionMs: 20,
    });
    assert.equal(third.getJob(JOB_A), null);
    third.close();
  });
});

test('a second live owner cannot open or reconcile a file-backed job database', async () => {
  await withDatabase(async ({ databasePath }) => {
    const first = createAnalysisJobStore({ databasePath, clock: () => 1 });
    first.createOrGetJob({ id: JOB_A, address: ADDRESS, chain: 'ethereum' });
    first.startJob(JOB_A);

    assert.throws(
      () => createAnalysisJobStore({ databasePath, clock: () => 2 }),
      error => (
        error instanceof AnalysisJobStoreInUseError
        && error.code === 'analysis_job_store_in_use'
        && error.databasePath === databasePath
        && error.cause?.code === 'SQLITE_BUSY'
      ),
    );
    assert.equal(first.getJob(JOB_A).status, 'running');

    first.close();
    const reopened = createAnalysisJobStore({ databasePath, clock: () => 3 });
    assert.equal(reopened.startupInterruptedCount, 1);
    assert.equal(reopened.getJob(JOB_A).status, 'failed');
    reopened.close();
  });
});

test('independent in-memory stores do not share file ownership state', () => {
  const first = createAnalysisJobStore({ databasePath: ':memory:', clock: () => 1 });
  const second = createAnalysisJobStore({ databasePath: ':memory:', clock: () => 2 });

  assert.equal(
    first.createOrGetJob({ id: JOB_A, address: ADDRESS, chain: 'ethereum' }).created,
    true,
  );
  assert.equal(
    second.createOrGetJob({ id: JOB_A, address: ADDRESS, chain: 'base' }).created,
    true,
  );
  assert.equal(first.getJob(JOB_A).chain, 'ethereum');
  assert.equal(second.getJob(JOB_A).chain, 'base');

  first.close();
  second.close();
});

test('file-backed ownership recovers automatically after an unclean owner exit', async () => {
  await withDatabase(async ({ databasePath }) => {
    const storeModuleUrl = new URL(
      '../functions/api/lib/analysis-job-store.js',
      import.meta.url,
    ).href;
    const childScript = `
      import { createAnalysisJobStore } from ${JSON.stringify(storeModuleUrl)};
      const store = createAnalysisJobStore({ databasePath: ${JSON.stringify(databasePath)} });
      store.createOrGetJob({
        id: ${JSON.stringify(JOB_A)},
        address: ${JSON.stringify(ADDRESS)},
        chain: 'ethereum',
      });
      process.stdout.write('ready\\n');
      setInterval(() => {}, 1_000);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '--eval', childScript], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    try {
      await waitForChildReady(child);
      assert.throws(
        () => createAnalysisJobStore({ databasePath }),
        AnalysisJobStoreInUseError,
      );

      child.kill('SIGKILL');
      await once(child, 'exit');

      const recovered = createAnalysisJobStore({ databasePath });
      assert.equal(recovered.startupInterruptedCount, 1);
      assert.equal(recovered.getJob(JOB_A).status, 'failed');
      recovered.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await once(child, 'exit');
      }
    }
  });
});

test('store detects corrupt persisted result JSON', async () => {
  await withDatabase(async ({ databasePath }) => {
    const store = createAnalysisJobStore({ databasePath, clock: () => 1 });
    store.createOrGetJob({ id: JOB_A, address: ADDRESS, chain: 'ethereum' });
    store.startJob(JOB_A);
    store.succeedJob(JOB_A, { valid: true });
    store.close();

    const database = new Database(databasePath);
    database.prepare('UPDATE analysis_jobs SET result_json = ? WHERE id = ?').run('{bad json', JOB_A);
    database.close();

    const reopened = createAnalysisJobStore({ databasePath, clock: () => 2 });
    assert.throws(() => reopened.getJob(JOB_A), /invalid JSON/);
    reopened.close();
  });
});

test('store rejects unsupported schemas without mutating them', async () => {
  await withDatabase(async ({ databasePath }) => {
    const database = new Database(databasePath);
    database.pragma(`user_version = ${__internal.SCHEMA_VERSION + 1}`);
    database.close();

    for (let attempt = 0; attempt < 2; attempt += 1) {
      assert.throws(
        () => createAnalysisJobStore({ databasePath, clock: () => 1 }),
        error => (
          !(error instanceof AnalysisJobStoreInUseError)
          && /newer than supported schema/.test(error.message)
        ),
      );
    }

    const unchanged = new Database(databasePath);
    assert.equal(
      unchanged.pragma('user_version', { simple: true }),
      __internal.SCHEMA_VERSION + 1,
    );
    unchanged.close();
  });
});

test('store validates configuration, clock values, and lifecycle', async () => {
  assert.throws(() => createAnalysisJobStore({ databasePath: '' }), /databasePath/);
  assert.throws(() => createAnalysisJobStore({ databasePath: ':memory:', clock: 1 }), /clock/);
  assert.throws(
    () => createAnalysisJobStore({ databasePath: ':memory:', resultRetentionMs: 0 }),
    /resultRetentionMs/,
  );
  assert.throws(
    () => createAnalysisJobStore({ databasePath: ':memory:', tombstoneRetentionMs: -1 }),
    /tombstoneRetentionMs/,
  );
  assert.throws(
    () => createAnalysisJobStore({ databasePath: ':memory:', clock: () => -1 }),
    /clock/,
  );

  await withDatabase(async ({ databasePath }) => {
    assert.throws(
      () => createAnalysisJobStore({ databasePath: path.dirname(databasePath), clock: () => 1 }),
      error => (
        !(error instanceof AnalysisJobStoreInUseError)
        && error.code === 'SQLITE_CANTOPEN'
      ),
    );

    const nestedPath = path.join(path.dirname(databasePath), 'nested', 'jobs.sqlite');
    const store = createAnalysisJobStore({ databasePath: nestedPath, clock: () => 1 });
    store.close();
    store.close();
    assert.throws(() => store.getJob(JOB_A), /closed/);
    assert.throws(() => store.createOrGetJob({ id: JOB_A, address: ADDRESS, chain: 'base' }), /closed/);
    assert.throws(() => store.countUnfinishedJobs(), /closed/);
    assert.throws(() => store.startJob(JOB_A), /closed/);
    assert.throws(() => store.succeedJob(JOB_A, {}), /closed/);
    assert.throws(
      () => store.failJob(JOB_A, { code: 'failed', message: 'failed' }),
      /closed/,
    );
    assert.throws(() => store.cleanupExpiredJobs(), /closed/);
  });
});

async function withDatabase(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'opensentry-job-store-'));
  try {
    await run({ databasePath: path.join(directory, 'analysis-jobs.sqlite') });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function waitForChildReady(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    const timeout = setTimeout(() => finish(new Error('Child owner did not become ready.')), 5_000);

    const finish = (error) => {
      clearTimeout(timeout);
      child.stdout.off('data', handleStdout);
      child.stderr.off('data', handleStderr);
      child.off('error', handleError);
      child.off('exit', handleExit);
      if (error) reject(error);
      else resolve();
    };
    const handleStdout = (chunk) => {
      if (String(chunk).includes('ready')) finish();
    };
    const handleStderr = (chunk) => {
      stderr += String(chunk);
    };
    const handleError = (error) => finish(error);
    const handleExit = (code, signal) => finish(new Error(
      `Child owner exited before ready (code ${code}, signal ${signal}): ${stderr}`,
    ));

    child.stdout.on('data', handleStdout);
    child.stderr.on('data', handleStderr);
    child.once('error', handleError);
    child.once('exit', handleExit);
  });
}
