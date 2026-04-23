export function tryParseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    return null;
  }
}
