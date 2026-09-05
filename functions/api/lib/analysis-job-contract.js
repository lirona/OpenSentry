const JOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const ANALYSIS_JOB_STATUS = Object.freeze({
  QUEUED: 'queued',
  RUNNING: 'running',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  EXPIRED: 'expired',
});

export function isAnalysisJobId(value) {
  return typeof value === 'string' && JOB_ID_RE.test(value);
}

export function isAnalysisJobStatusPath(pathname) {
  return typeof pathname === 'string' && /^\/api\/analyze\/[^/]+$/.test(pathname);
}

export function getAnalysisJobIdFromPath(pathname) {
  if (!isAnalysisJobStatusPath(pathname)) return null;
  const match = /^\/api\/analyze\/([^/]+)$/.exec(pathname);
  if (!match) return null;

  let value;
  try {
    value = decodeURIComponent(match[1]);
  } catch {
    return null;
  }

  return isAnalysisJobId(value) ? value : null;
}

export const __internal = Object.freeze({ JOB_ID_RE });
