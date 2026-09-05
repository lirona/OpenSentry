import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { ANALYSIS_JOB_STATUS } from './analysis-job-contract.js';

const SCHEMA_VERSION = 1;
const RESULT_RETENTION_MS = 24 * 60 * 60 * 1_000;
const TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

export const ANALYSIS_INTERRUPTED_ERROR = Object.freeze({
  code: 'analysis_interrupted',
  message: 'Analysis was interrupted because the local runner restarted.',
});

export class AnalysisJobStateError extends Error {
  constructor(message, { code = 'invalid_job_state', jobId = null } = {}) {
    super(message);
    this.name = 'AnalysisJobStateError';
    this.code = code;
    this.jobId = jobId;
  }
}

export class AnalysisJobStoreInUseError extends Error {
  constructor(databasePath, options = {}) {
    super('The analysis job database is already owned by another local runner.', options);
    this.name = 'AnalysisJobStoreInUseError';
    this.code = 'analysis_job_store_in_use';
    this.databasePath = databasePath;
  }
}

export class AnalysisJobConflictError extends Error {
  constructor(jobId) {
    super('This analysis job ID is already associated with a different request.');
    this.name = 'AnalysisJobConflictError';
    this.code = 'analysis_job_conflict';
    this.jobId = jobId;
  }
}

export class AnalysisJobResultSerializationError extends TypeError {
  constructor(options = {}) {
    super('Analysis job result must be JSON-serializable.', options);
    this.name = 'AnalysisJobResultSerializationError';
    this.code = 'analysis_result_not_serializable';
  }
}

export function createAnalysisJobStore(options = {}) {
  const databasePath = resolveDatabasePath(options.databasePath);
  const clock = options.clock || Date.now;
  const resultRetentionMs = positiveDuration(
    options.resultRetentionMs,
    RESULT_RETENTION_MS,
    'resultRetentionMs',
  );
  const tombstoneRetentionMs = positiveDuration(
    options.tombstoneRetentionMs,
    TOMBSTONE_RETENTION_MS,
    'tombstoneRetentionMs',
  );

  if (typeof clock !== 'function') {
    throw new TypeError('createAnalysisJobStore: clock must be a function');
  }

  if (databasePath !== ':memory:') {
    mkdirSync(path.dirname(databasePath), { recursive: true, mode: 0o700 });
  }

  const database = new Database(databasePath, { timeout: 0 });
  let closed = false;

  let statements;
  let createOrGet;
  let interruptUnfinished;
  let cleanupExpired;
  let startupInterruptedCount;
  try {
    if (databasePath !== ':memory:') {
      acquireExclusiveDatabaseOwnership(database, databasePath);
    }
    initializeDatabase(database);
    statements = prepareStatements(database);
    createOrGet = database.transaction(({ id, address, chain, requestFingerprint }) => {
      const existing = statements.selectJob.get(id);
      if (existing) {
        if (existing.request_fingerprint !== requestFingerprint) {
          throw new AnalysisJobConflictError(id);
        }
        return { created: false, row: existing };
      }

      statements.insertJob.run({
        id,
        address,
        chain,
        requestFingerprint,
        status: ANALYSIS_JOB_STATUS.QUEUED,
        createdAt: readClock(clock),
      });
      return { created: true, row: statements.selectJob.get(id) };
    });
    interruptUnfinished = database.transaction((now) => statements.interruptUnfinished.run({
      completedAt: now,
      expiresAt: now + resultRetentionMs,
      errorCode: ANALYSIS_INTERRUPTED_ERROR.code,
      errorMessage: ANALYSIS_INTERRUPTED_ERROR.message,
    }).changes);
    cleanupExpired = database.transaction((now) => {
      const expiredCount = statements.expireTerminal.run({
        now,
        purgeAt: now + tombstoneRetentionMs,
      }).changes;
      const deletedCount = statements.deleteTombstones.run({ now }).changes;
      return { expiredCount, deletedCount };
    });

    startupInterruptedCount = interruptUnfinished(readClock(clock));
    cleanupExpired(readClock(clock));
  } catch (error) {
    database.close();
    throw error;
  }

  function assertOpen() {
    if (closed) {
      throw new Error('Analysis job store is closed.');
    }
  }

  function createOrGetJob({ id, address, chain }) {
    assertOpen();
    assertNonEmptyString(id, 'id');
    assertNonEmptyString(address, 'address');
    assertNonEmptyString(chain, 'chain');

    const admission = createOrGet({
      id,
      address,
      chain,
      requestFingerprint: fingerprintRequest(address, chain),
    });
    return {
      created: admission.created,
      job: deserializeJob(admission.row),
    };
  }

  function getJob(id) {
    assertOpen();
    assertNonEmptyString(id, 'id');
    const row = statements.selectJob.get(id);
    return row ? deserializeJob(row) : null;
  }

  function countUnfinishedJobs() {
    assertOpen();
    return statements.countUnfinished.get().count;
  }

  function startJob(id) {
    assertOpen();
    assertNonEmptyString(id, 'id');
    const result = statements.startJob.run({
      id,
      startedAt: readClock(clock),
    });
    assertTransition(result.changes, id, ANALYSIS_JOB_STATUS.QUEUED);
    return getJob(id);
  }

  function succeedJob(id, result) {
    assertOpen();
    assertNonEmptyString(id, 'id');
    const resultJson = serializeResult(result);
    const now = readClock(clock);
    const update = statements.succeedJob.run({
      id,
      resultJson,
      completedAt: now,
      expiresAt: now + resultRetentionMs,
    });
    assertTransition(update.changes, id, ANALYSIS_JOB_STATUS.RUNNING);
    return getJob(id);
  }

  function failJob(id, error) {
    assertOpen();
    assertNonEmptyString(id, 'id');
    const normalizedError = normalizeError(error);
    const now = readClock(clock);
    const update = statements.failJob.run({
      id,
      errorCode: normalizedError.code,
      errorMessage: normalizedError.message,
      completedAt: now,
      expiresAt: now + resultRetentionMs,
    });
    assertTransition(update.changes, id, ANALYSIS_JOB_STATUS.RUNNING);
    return getJob(id);
  }

  function cleanupExpiredJobs() {
    assertOpen();
    return cleanupExpired(readClock(clock));
  }

  function close() {
    if (closed) return;
    closed = true;
    database.close();
  }

  function assertTransition(changes, id, expectedStatus) {
    if (changes === 1) return;

    const existing = statements.selectStatus.get(id);
    if (!existing) {
      throw new AnalysisJobStateError(`Analysis job "${id}" does not exist.`, {
        code: 'job_not_found',
        jobId: id,
      });
    }

    throw new AnalysisJobStateError(
      `Analysis job "${id}" must be ${expectedStatus}, but is ${existing.status}.`,
      { jobId: id },
    );
  }

  return Object.freeze({
    databasePath,
    startupInterruptedCount,
    createOrGetJob,
    getJob,
    countUnfinishedJobs,
    startJob,
    succeedJob,
    failJob,
    cleanupExpiredJobs,
    close,
  });
}

function acquireExclusiveDatabaseOwnership(database, databasePath) {
  try {
    const lockingMode = database.pragma('locking_mode = EXCLUSIVE', { simple: true });
    if (lockingMode !== 'exclusive') {
      throw new Error(`Could not enable exclusive locking for analysis job database "${databasePath}".`);
    }
    database.exec('BEGIN EXCLUSIVE; COMMIT;');
  } catch (error) {
    if (error?.code === 'SQLITE_BUSY' || error?.code === 'SQLITE_LOCKED') {
      throw new AnalysisJobStoreInUseError(databasePath, { cause: error });
    }
    throw error;
  }
}

function initializeDatabase(database) {
  const schemaVersion = database.pragma('user_version', { simple: true });
  if (schemaVersion > SCHEMA_VERSION) {
    throw new Error(
      `Analysis job database schema ${schemaVersion} is newer than supported schema ${SCHEMA_VERSION}.`,
    );
  }

  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.exec(`
    CREATE TABLE IF NOT EXISTS analysis_jobs (
      id TEXT PRIMARY KEY,
      request_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'expired')),
      address TEXT,
      chain TEXT,
      result_json TEXT,
      error_code TEXT,
      error_message TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      expires_at INTEGER,
      expired_at INTEGER,
      purge_at INTEGER,
      CHECK (
        (status = 'queued' AND address IS NOT NULL AND chain IS NOT NULL AND
          started_at IS NULL AND completed_at IS NULL AND result_json IS NULL AND
          error_code IS NULL AND error_message IS NULL AND expires_at IS NULL AND
          expired_at IS NULL AND purge_at IS NULL) OR
        (status = 'running' AND address IS NOT NULL AND chain IS NOT NULL AND
          started_at IS NOT NULL AND completed_at IS NULL AND result_json IS NULL AND
          error_code IS NULL AND error_message IS NULL AND expires_at IS NULL AND
          expired_at IS NULL AND purge_at IS NULL) OR
        (status = 'succeeded' AND address IS NOT NULL AND chain IS NOT NULL AND
          started_at IS NOT NULL AND completed_at IS NOT NULL AND result_json IS NOT NULL AND
          error_code IS NULL AND error_message IS NULL AND expires_at IS NOT NULL AND
          expired_at IS NULL AND purge_at IS NULL) OR
        (status = 'failed' AND address IS NOT NULL AND chain IS NOT NULL AND
          completed_at IS NOT NULL AND result_json IS NULL AND error_code IS NOT NULL AND
          error_message IS NOT NULL AND expires_at IS NOT NULL AND expired_at IS NULL AND
          purge_at IS NULL) OR
        (status = 'expired' AND address IS NULL AND chain IS NULL AND result_json IS NULL AND
          error_code IS NULL AND error_message IS NULL AND expires_at IS NULL AND
          expired_at IS NOT NULL AND purge_at IS NOT NULL)
      )
    );

    CREATE INDEX IF NOT EXISTS analysis_jobs_unfinished
      ON analysis_jobs(status)
      WHERE status IN ('queued', 'running');

    CREATE INDEX IF NOT EXISTS analysis_jobs_expiration
      ON analysis_jobs(expires_at)
      WHERE status IN ('succeeded', 'failed');

    CREATE INDEX IF NOT EXISTS analysis_jobs_purge
      ON analysis_jobs(purge_at)
      WHERE status = 'expired';
  `);

  if (schemaVersion === 0) {
    database.pragma(`user_version = ${SCHEMA_VERSION}`);
  }
}

function prepareStatements(database) {
  return {
    insertJob: database.prepare(`
      INSERT INTO analysis_jobs (id, request_fingerprint, status, address, chain, created_at)
      VALUES (@id, @requestFingerprint, @status, @address, @chain, @createdAt)
    `),
    selectJob: database.prepare('SELECT * FROM analysis_jobs WHERE id = ?'),
    selectStatus: database.prepare('SELECT status FROM analysis_jobs WHERE id = ?'),
    countUnfinished: database.prepare(`
      SELECT COUNT(*) AS count
      FROM analysis_jobs
      WHERE status IN ('queued', 'running')
    `),
    startJob: database.prepare(`
      UPDATE analysis_jobs
      SET status = 'running', started_at = @startedAt
      WHERE id = @id AND status = 'queued'
    `),
    succeedJob: database.prepare(`
      UPDATE analysis_jobs
      SET status = 'succeeded', result_json = @resultJson,
          completed_at = @completedAt, expires_at = @expiresAt
      WHERE id = @id AND status = 'running'
    `),
    failJob: database.prepare(`
      UPDATE analysis_jobs
      SET status = 'failed', error_code = @errorCode, error_message = @errorMessage,
          completed_at = @completedAt, expires_at = @expiresAt
      WHERE id = @id AND status = 'running'
    `),
    interruptUnfinished: database.prepare(`
      UPDATE analysis_jobs
      SET status = 'failed', result_json = NULL,
          error_code = @errorCode, error_message = @errorMessage,
          completed_at = @completedAt, expires_at = @expiresAt,
          expired_at = NULL, purge_at = NULL
      WHERE status IN ('queued', 'running')
    `),
    expireTerminal: database.prepare(`
      UPDATE analysis_jobs
      SET status = 'expired', address = NULL, chain = NULL, result_json = NULL,
          error_code = NULL, error_message = NULL, expires_at = NULL,
          expired_at = @now, purge_at = @purgeAt
      WHERE status IN ('succeeded', 'failed') AND expires_at <= @now
    `),
    deleteTombstones: database.prepare(`
      DELETE FROM analysis_jobs
      WHERE status = 'expired' AND purge_at <= @now
    `),
  };
}

function deserializeJob(row) {
  let result = null;
  if (row.result_json !== null) {
    try {
      result = JSON.parse(row.result_json);
    } catch (error) {
      throw new Error(`Stored result for analysis job "${row.id}" is invalid JSON.`, { cause: error });
    }
  }

  return {
    id: row.id,
    status: row.status,
    address: row.address,
    chain: row.chain,
    result,
    error: row.error_code === null
      ? null
      : { code: row.error_code, message: row.error_message },
    createdAt: toIso(row.created_at),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    expiresAt: toIso(row.expires_at),
    expiredAt: toIso(row.expired_at),
  };
}

function serializeResult(result) {
  if (result === undefined) {
    throw new AnalysisJobResultSerializationError();
  }

  let serialized;
  try {
    serialized = JSON.stringify(result);
  } catch (error) {
    throw new AnalysisJobResultSerializationError({ cause: error });
  }

  if (serialized === undefined) {
    throw new AnalysisJobResultSerializationError();
  }
  return serialized;
}

function fingerprintRequest(address, chain) {
  return createHash('sha256')
    .update(JSON.stringify([address, chain]))
    .digest('hex');
}

function normalizeError(error) {
  const code = error?.code;
  const message = error?.message;
  assertNonEmptyString(code, 'error.code');
  assertNonEmptyString(message, 'error.message');
  return { code, message };
}

function resolveDatabasePath(value) {
  if (value === undefined) {
    return path.resolve(process.cwd(), '.opensentry', 'analysis-jobs.sqlite');
  }
  if (value === ':memory:') return value;
  assertNonEmptyString(value, 'databasePath');
  return path.resolve(value);
}

function positiveDuration(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`createAnalysisJobStore: ${name} must be a positive safe integer`);
  }
  return value;
}

function readClock(clock) {
  const now = clock();
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new TypeError('Analysis job clock must return a non-negative safe integer.');
  }
  return now;
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`Analysis job ${name} must be a non-empty string.`);
  }
}

function toIso(value) {
  return value === null ? null : new Date(value).toISOString();
}

export const __internal = Object.freeze({
  SCHEMA_VERSION,
  RESULT_RETENTION_MS,
  TOMBSTONE_RETENTION_MS,
  acquireExclusiveDatabaseOwnership,
  deserializeJob,
  fingerprintRequest,
  serializeResult,
});
