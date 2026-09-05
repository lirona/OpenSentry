import { isAnalysisJobId } from './analysis-job-contract.js';
import {
  AnalysisJobConflictError,
  AnalysisJobResultSerializationError,
} from './analysis-job-store.js';

export { isAnalysisJobId } from './analysis-job-contract.js';
export { AnalysisJobConflictError } from './analysis-job-store.js';

const MAX_UNFINISHED_JOBS = 8;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1_000;
const UNEXPECTED_ANALYSIS_ERROR = Object.freeze({
  code: 'analysis_failed',
  message: 'The local analysis runner encountered an unexpected error.',
});

const RESULT_PERSISTENCE_ERROR = Object.freeze({
  code: 'analysis_result_persistence_failed',
  message: 'The completed analysis result could not be saved.',
});

export class AnalysisJobQueueFullError extends Error {
  constructor() {
    super('The local analysis queue is full. Please try again later.');
    this.name = 'AnalysisJobQueueFullError';
    this.code = 'analysis_queue_full';
  }
}

export class InvalidAnalysisJobIdError extends Error {
  constructor(jobId) {
    super('Analysis job ID must be a valid UUID.');
    this.name = 'InvalidAnalysisJobIdError';
    this.code = 'invalid_job_id';
    this.jobId = jobId;
  }
}

export class AnalysisJobManagerUnavailableError extends Error {
  constructor(cause) {
    super(
      'The local analysis job manager is unavailable. Restart the local runner.',
      cause === undefined ? {} : { cause },
    );
    this.name = 'AnalysisJobManagerUnavailableError';
    this.code = 'analysis_job_manager_unavailable';
  }
}

export class AnalysisJobExecutionError extends Error {
  constructor(code, message) {
    assertNonEmptyString(code, 'AnalysisJobExecutionError code');
    assertNonEmptyString(message, 'AnalysisJobExecutionError message');
    super(message);
    this.name = 'AnalysisJobExecutionError';
    this.code = code;
  }
}

export function createAnalysisJobManager(options = {}) {
  const store = options.store;
  const executor = options.executor;
  const logger = options.logger || console;
  const setIntervalFn = options.setIntervalFn || setInterval;
  const clearIntervalFn = options.clearIntervalFn || clearInterval;

  assertStore(store);
  if (typeof executor !== 'function') {
    throw new TypeError('createAnalysisJobManager: executor must be a function');
  }
  if (!logger || typeof logger.error !== 'function') {
    throw new TypeError('createAnalysisJobManager: logger.error must be a function');
  }
  if (typeof setIntervalFn !== 'function' || typeof clearIntervalFn !== 'function') {
    throw new TypeError('createAnalysisJobManager: timer functions must be functions');
  }

  const queuedJobIds = [];
  const idleWaiters = [];
  let activeJobId = null;
  let drainScheduled = false;
  let closed = false;
  let closePromise = null;
  let unavailableError = null;
  let cleanupTimerCleared = false;

  const cleanupTimer = setIntervalFn(() => {
    if (unavailableError) return;
    try {
      store.cleanupExpiredJobs();
    } catch (error) {
      markUnavailable(error);
      logError('Analysis job cleanup failed:', error);
    }
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer?.unref?.();

  function submit({ jobId, address, chain } = {}) {
    assertOperational();
    assertValidJobId(jobId);
    assertNonEmptyString(address, 'Analysis address');
    assertNonEmptyString(chain, 'Analysis chain');

    runStoreOperation(() => store.cleanupExpiredJobs());
    const existing = runStoreOperation(() => store.getJob(jobId));
    if (
      !existing
      && runStoreOperation(() => store.countUnfinishedJobs()) >= MAX_UNFINISHED_JOBS
    ) {
      throw new AnalysisJobQueueFullError();
    }

    const admission = runStoreOperation(
      () => store.createOrGetJob({ id: jobId, address, chain }),
      { allowConflict: true },
    );
    if (admission.created) {
      queuedJobIds.push(jobId);
      scheduleDrain();
    }
    return { jobId, status: admission.job.status };
  }

  function getJob(jobId) {
    assertOperational();
    assertValidJobId(jobId);
    runStoreOperation(() => store.cleanupExpiredJobs());
    return toPublicJob(runStoreOperation(() => store.getJob(jobId)));
  }

  function cleanupExpiredJobs() {
    assertOperational();
    return runStoreOperation(() => store.cleanupExpiredJobs());
  }

  function whenIdle() {
    if (isIdle()) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  function close() {
    if (closePromise) return closePromise;
    closed = true;
    stopCleanupTimer();
    closePromise = whenIdle().then(() => {
      store.close();
    });
    return closePromise;
  }

  function scheduleDrain() {
    if (
      unavailableError
      || activeJobId !== null
      || drainScheduled
      || queuedJobIds.length === 0
    ) return;
    drainScheduled = true;
    queueMicrotask(() => {
      drainScheduled = false;
      void drainNextJob();
    });
  }

  async function drainNextJob() {
    if (unavailableError || activeJobId !== null) return;
    const jobId = queuedJobIds.shift();
    if (!jobId) {
      resolveIdleWaiters();
      return;
    }

    activeJobId = jobId;
    let job;
    try {
      job = store.startJob(jobId);
    } catch (error) {
      markUnavailable(error);
      logError(`Failed to start analysis job "${jobId}":`, error);
      finishActiveJob();
      return;
    }

    try {
      const result = await executor({
        address: job.address,
        chain: job.chain,
      });
      persistSuccess(jobId, result);
    } catch (error) {
      persistFailure(jobId, normalizeExecutionError(error));
      if (!(error instanceof AnalysisJobExecutionError)) {
        logError(`Analysis job "${jobId}" failed unexpectedly:`, error);
      }
    } finally {
      finishActiveJob();
    }
  }

  function persistSuccess(jobId, result) {
    if (unavailableError) return;
    try {
      store.succeedJob(jobId, result);
    } catch (error) {
      if (error instanceof AnalysisJobResultSerializationError) {
        logError(`Failed to save result for analysis job "${jobId}":`, error);
        persistFailure(jobId, RESULT_PERSISTENCE_ERROR);
      } else {
        markUnavailable(error);
        logError(`Failed to save result for analysis job "${jobId}":`, error);
      }
    }
  }

  function persistFailure(jobId, error) {
    if (unavailableError) return;
    try {
      store.failJob(jobId, error);
    } catch (persistenceError) {
      markUnavailable(persistenceError);
      logError(`Failed to save failure for analysis job "${jobId}":`, persistenceError);
    }
  }

  function markUnavailable(cause) {
    if (!unavailableError) {
      unavailableError = new AnalysisJobManagerUnavailableError(cause);
    }
    stopCleanupTimer();
    queuedJobIds.length = 0;
    drainScheduled = false;
    if (activeJobId === null) resolveIdleWaiters();
    return unavailableError;
  }

  function stopCleanupTimer() {
    if (cleanupTimerCleared) return;
    cleanupTimerCleared = true;
    clearIntervalFn(cleanupTimer);
  }

  function logError(...args) {
    try {
      logger.error(...args);
    } catch {
      // Logging cannot be allowed to change job state or scheduler behavior.
    }
  }

  function runStoreOperation(operation, { allowConflict = false } = {}) {
    try {
      return operation();
    } catch (error) {
      if (allowConflict && error instanceof AnalysisJobConflictError) throw error;
      throw markUnavailable(error);
    }
  }

  function assertOperational() {
    if (closed) {
      const error = new Error('Analysis job manager is closed.');
      error.code = 'analysis_job_manager_closed';
      throw error;
    }
    if (unavailableError) throw unavailableError;
  }

  function finishActiveJob() {
    activeJobId = null;
    scheduleDrain();
    if (isIdle()) resolveIdleWaiters();
  }

  function isIdle() {
    return activeJobId === null && queuedJobIds.length === 0 && !drainScheduled;
  }

  function resolveIdleWaiters() {
    if (!isIdle()) return;
    while (idleWaiters.length > 0) {
      idleWaiters.shift()();
    }
  }

  return Object.freeze({
    submit,
    getJob,
    cleanupExpiredJobs,
    whenIdle,
    close,
  });
}

function assertValidJobId(jobId) {
  if (!isAnalysisJobId(jobId)) {
    throw new InvalidAnalysisJobIdError(jobId);
  }
}

function normalizeExecutionError(error) {
  if (error instanceof AnalysisJobExecutionError) {
    return { code: error.code, message: error.message };
  }
  return UNEXPECTED_ANALYSIS_ERROR;
}

function toPublicJob(job) {
  if (!job) return null;
  const { id, ...rest } = job;
  return { jobId: id, ...rest };
}

function assertStore(store) {
  const methods = [
    'createOrGetJob',
    'getJob',
    'countUnfinishedJobs',
    'startJob',
    'succeedJob',
    'failJob',
    'cleanupExpiredJobs',
    'close',
  ];
  if (!store || methods.some((method) => typeof store[method] !== 'function')) {
    throw new TypeError('createAnalysisJobManager: store does not implement the analysis job store contract');
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string.`);
  }
}

export const __internal = Object.freeze({
  MAX_UNFINISHED_JOBS,
  CLEANUP_INTERVAL_MS,
  UNEXPECTED_ANALYSIS_ERROR,
  RESULT_PERSISTENCE_ERROR,
  normalizeExecutionError,
  toPublicJob,
});
