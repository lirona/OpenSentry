export function errorResult(code, message, extra = {}) {
  return { ok: false, error: { code, message, ...extra } };
}
