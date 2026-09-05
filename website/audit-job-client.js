const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_RETRY_DELAY_MS = 30_000;
const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TRANSIENT_POLL_ERRORS = new Set([
  'relay_unavailable',
  'relay_timeout',
]);
const AMBIGUOUS_CREATION_ERRORS = new Set([
  'relay_unavailable',
  'relay_timeout',
  'relay_bad_response',
]);

export const ACTIVE_AUDIT_JOB_STORAGE_KEY = 'opensentry.activeAuditJob.v1';

export class AuditJobError extends Error {
  constructor(code, message, { creationAmbiguous = false, jobMayExist = false } = {}) {
    super(message);
    this.name = 'AuditJobError';
    this.code = code;
    this.creationAmbiguous = creationAmbiguous;
    this.jobMayExist = jobMayExist;
  }
}

export function createAuditJobId(cryptoProvider = globalThis.crypto) {
  if (typeof cryptoProvider?.randomUUID !== 'function') {
    throw new Error('Secure UUID generation is unavailable.');
  }
  const jobId = cryptoProvider.randomUUID();
  if (!isAuditJobId(jobId)) {
    throw new Error('Secure UUID generation returned an invalid job ID.');
  }
  return jobId;
}

export async function createAuditJob({
  endpoint,
  jobId,
  address,
  chain,
  fetchFn = globalThis.fetch,
  signal,
}) {
  if (!isAuditJobId(jobId)) throw invalidResponseError();
  throwIfAborted(signal);

  let response;
  try {
    response = await fetchFn(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jobId, address, chain }),
      signal,
    });
  } catch (error) {
    rethrowAbort(error, signal);
    throw new AuditJobError(
      'relay_unavailable',
      'The analysis runner is currently unavailable. Please try again later.',
      { creationAmbiguous: true, jobMayExist: true },
    );
  }

  let data;
  try {
    data = await readJsonResponse(response, signal);
  } catch (error) {
    if (error instanceof AuditJobError && (response.ok || response.status >= 500)) {
      error.creationAmbiguous = true;
      error.jobMayExist = true;
    }
    throw error;
  }
  if (!response.ok) {
    const error = responseError(data, response.status);
    if (response.status >= 500) error.jobMayExist = true;
    if (AMBIGUOUS_CREATION_ERRORS.has(error.code)) {
      error.creationAmbiguous = true;
    }
    throw error;
  }

  if (
    response.status !== 202
    || data?.success !== true
    || !['queued', 'running', 'succeeded', 'failed', 'expired'].includes(data.status)
    || data.jobId !== jobId
  ) {
    throw invalidResponseError({ creationAmbiguous: true, jobMayExist: true });
  }

  return {
    jobId: data.jobId,
    status: data.status,
  };
}

export async function pollAuditJob({
  endpoint,
  jobId,
  fetchFn = globalThis.fetch,
  waitFn = waitForDelay,
  signal,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxRetryDelayMs = DEFAULT_MAX_RETRY_DELAY_MS,
}) {
  const interval = normalizeDelay(pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const maximumRetryDelay = Math.max(
    interval,
    normalizeDelay(maxRetryDelayMs, DEFAULT_MAX_RETRY_DELAY_MS),
  );
  let consecutiveFailures = 0;

  while (true) {
    throwIfAborted(signal);

    let job;
    try {
      job = await fetchAuditJob({
        endpoint,
        jobId,
        fetchFn,
        signal,
      });
    } catch (error) {
      if (isTransientPollError(error)) {
        consecutiveFailures += 1;
        await waitFn(retryDelay(interval, maximumRetryDelay, consecutiveFailures), signal);
        continue;
      }
      throw error;
    }

    if (job.status === 'queued' || job.status === 'running') {
      consecutiveFailures = 0;
      await waitFn(interval, signal);
      continue;
    }

    return job.result;
  }
}

export async function runAuditJob({
  endpoint,
  jobId,
  address,
  chain,
  fetchFn = globalThis.fetch,
  waitFn = waitForDelay,
  signal,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxRetryDelayMs = DEFAULT_MAX_RETRY_DELAY_MS,
}) {
  const interval = normalizeDelay(pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
  const maximumRetryDelay = Math.max(
    interval,
    normalizeDelay(maxRetryDelayMs, DEFAULT_MAX_RETRY_DELAY_MS),
  );
  let consecutiveFailures = 0;

  while (true) {
    try {
      await createAuditJob({ endpoint, jobId, address, chain, fetchFn, signal });
      break;
    } catch (error) {
      if (!isAmbiguousJobCreationError(error)) throw error;

      try {
        const job = await fetchAuditJob({ endpoint, jobId, fetchFn, signal });
        if (job.status === 'succeeded') return job.result;
        return pollAuditJob({
          endpoint,
          jobId,
          fetchFn,
          waitFn,
          signal,
          pollIntervalMs,
          maxRetryDelayMs,
        });
      } catch (statusError) {
        if (!isCreationReconciliationError(statusError)) throw statusError;
      }

      consecutiveFailures += 1;
      await waitFn(retryDelay(interval, maximumRetryDelay, consecutiveFailures), signal);
    }
  }

  return pollAuditJob({
    endpoint,
    jobId,
    fetchFn,
    waitFn,
    signal,
    pollIntervalMs,
    maxRetryDelayMs,
  });
}

export function loadActiveAuditJob(storage) {
  if (!storage) return null;

  let raw;
  try {
    raw = storage.getItem(ACTIVE_AUDIT_JOB_STORAGE_KEY);
  } catch {
    return null;
  }

  if (!raw) return null;

  try {
    const value = JSON.parse(raw);
    if (
      value?.version !== 1
      || !isAuditJobId(value.jobId)
      || !isNonEmptyString(value.address)
      || !isNonEmptyString(value.chain)
    ) {
      return null;
    }

    return {
      jobId: value.jobId,
      address: value.address,
      chain: value.chain,
    };
  } catch {
    return null;
  }
}

export function saveActiveAuditJob(storage, job) {
  if (
    !storage
    || !isAuditJobId(job?.jobId)
    || !isNonEmptyString(job?.address)
    || !isNonEmptyString(job?.chain)
  ) {
    return false;
  }

  try {
    storage.setItem(ACTIVE_AUDIT_JOB_STORAGE_KEY, JSON.stringify({
      version: 1,
      jobId: job.jobId,
      address: job.address,
      chain: job.chain,
    }));
    return true;
  } catch {
    return false;
  }
}

export function clearActiveAuditJob(storage) {
  if (!storage) return false;

  try {
    storage.removeItem(ACTIVE_AUDIT_JOB_STORAGE_KEY);
    return true;
  } catch {
    return false;
  }
}

export function isAbortError(error) {
  return error?.name === 'AbortError';
}

export function isAmbiguousJobCreationError(error) {
  return error instanceof AuditJobError && error.creationAmbiguous === true;
}

async function fetchAuditJob({ endpoint, jobId, fetchFn, signal }) {
  if (!isAuditJobId(jobId)) throw invalidResponseError();
  throwIfAborted(signal);

  const statusUrl = `${endpoint.replace(/\/$/, '')}/${encodeURIComponent(jobId)}`;
  let response;
  try {
    response = await fetchFn(statusUrl, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch (error) {
    rethrowAbort(error, signal);
    throw new AuditJobError(
      'relay_unavailable',
      'The analysis runner is currently unavailable. Please try again later.',
      { jobMayExist: true },
    );
  }

  let data;
  try {
    data = await readJsonResponse(response, signal);
  } catch (error) {
    if (error instanceof AuditJobError) error.jobMayExist = true;
    throw error;
  }
  if (!response.ok) {
    const error = responseError(data, response.status);
    if (response.status >= 500) error.jobMayExist = true;
    throw error;
  }
  if (data?.jobId !== jobId || !isNonEmptyString(data.status)) {
    throw invalidResponseError({ jobMayExist: true });
  }

  if (data.status === 'queued' || data.status === 'running') {
    if (data.success !== true) throw invalidResponseError({ jobMayExist: true });
    return { status: data.status, result: null };
  }

  if (data.status === 'succeeded') {
    if (data.success !== true || !isAnalysisResult(data.result)) {
      throw invalidResponseError({ jobMayExist: true });
    }
    return { status: data.status, result: data.result };
  }

  if (data.status === 'failed') {
    if (
      data.success !== false
      || !isNonEmptyString(data.error)
      || !isNonEmptyString(data.message)
    ) {
      throw invalidResponseError({ jobMayExist: true });
    }
    throw new AuditJobError(data.error, data.message);
  }

  throw invalidResponseError({ jobMayExist: true });
}

function retryDelay(interval, maximum, failureCount) {
  return Math.min(interval * (2 ** Math.min(failureCount - 1, 30)), maximum);
}

function normalizeDelay(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isAuditJobId(value) {
  return typeof value === 'string' && JOB_ID_RE.test(value);
}

function isTransientPollError(error) {
  return error instanceof AuditJobError && TRANSIENT_POLL_ERRORS.has(error.code);
}

function isCreationReconciliationError(error) {
  return error instanceof AuditJobError && (
    error.code === 'job_not_found'
    || AMBIGUOUS_CREATION_ERRORS.has(error.code)
  );
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isAnalysisResult(value) {
  return isObject(value)
    && isNonEmptyString(value.address)
    && isNonEmptyString(value.chain)
    && isNonEmptyString(value.timestamp)
    && isObject(value.report);
}

async function readJsonResponse(response, signal) {
  try {
    return await response.json();
  } catch (error) {
    rethrowAbort(error, signal);
    if (response.status >= 500 && response.status <= 599) {
      throw new AuditJobError(
        'relay_unavailable',
        'The analysis runner is currently unavailable. Please try again later.',
      );
    }
    throw invalidResponseError();
  }
}

function responseError(data, status) {
  const fallbackCode = status === 404
    ? 'job_not_found'
    : status === 410
      ? 'job_expired'
      : 'internal_error';
  const fallbackMessage = status === 404
    ? 'This analysis job could not be found.'
    : status === 410
      ? 'This analysis job has expired. Please start a new analysis.'
      : 'The analysis could not be completed. Please try again later.';

  return new AuditJobError(
    isNonEmptyString(data?.error) ? data.error : fallbackCode,
    isNonEmptyString(data?.message) ? data.message : fallbackMessage,
  );
}

function invalidResponseError(options) {
  return new AuditJobError(
    'relay_bad_response',
    'The analysis runner returned an invalid response. Please try again later.',
    options,
  );
}

function rethrowAbort(error, signal) {
  if (isAbortError(error)) throw error;
  throwIfAborted(signal);
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

function waitForDelay(delayMs, signal) {
  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', handleAbort);
      resolve();
    }, delayMs);

    function handleAbort() {
      clearTimeout(timeout);
      reject(signal.reason instanceof Error
        ? signal.reason
        : new DOMException('The operation was aborted.', 'AbortError'));
    }

    signal?.addEventListener('abort', handleAbort, { once: true });
  });
}

export const __internal = {
  JOB_ID_RE,
  AMBIGUOUS_CREATION_ERRORS,
  TRANSIENT_POLL_ERRORS,
  isAuditJobId,
  isCreationReconciliationError,
  isTransientPollError,
  retryDelay,
  waitForDelay,
};
