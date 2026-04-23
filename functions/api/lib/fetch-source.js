// Contract source fetching via Etherscan's V2 multichain API.
//
// As of 2025-08-15 Etherscan deprecated the legacy per-chain V1 endpoints
// (api.etherscan.io, api.basescan.org, api.arbiscan.io, ...) in favor of a
// single unified V2 endpoint that takes a `chainid` query parameter and a
// single Etherscan API key that works across all supported chains. This
// module targets the V2 API exclusively.
//
// Docs: https://docs.etherscan.io/etherscan-v2 and
//       https://docs.etherscan.io/api-reference/endpoint/getsourcecode
//
// Exported: fetchSource(address, chain, env, options?)

import { buildSourceBundle } from './source-bundle.js';
import { tryParseJson } from './try-parse-json.js';

const V2_BASE_URL = "https://api.etherscan.io/v2/api";

// Whitelisted chains -> Etherscan V2 chainid.
const CHAIN_IDS = {
  ethereum: 1,
  base: 8453,
  arbitrum: 42161,
  optimism: 10,
  polygon: 137,
};

const ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;

// Hard upper bound on a single explorer call so we never tie up the 30s
// Pages Function budget waiting on a slow API.
const FETCH_TIMEOUT_MS = 15_000;

// Cap proxy chain depth to prevent pathological loops beyond the visited-set
// protection (e.g. two proxies pointing to each other on different addresses
// via storage reads that Etherscan resolved statically).
const MAX_PROXY_DEPTH = 3;

// Etherscan V2 free tier caps at 3 calls/sec per key. When we burst through
// that (e.g. a proxy fetch followed immediately by another analysis) the API
// returns a soft error; we retry once after this delay before giving up.
const RATE_LIMIT_RETRY_DELAY_MS = 1_200;
const RATE_LIMIT_PATTERN = /rate limit|calls per sec|too many requests/i;

/**
 * Fetch verified source code for a contract.
 *
 * @param {string} address         - EVM address (0x-prefixed, 40 hex chars)
 * @param {string} chain           - one of: ethereum, base, arbitrum, optimism, polygon
 * @param {object} env             - Cloudflare Pages Functions env bindings
 * @param {object} [options]
 * @param {Set<string>} [options.visited] - lowercase addresses already fetched in this call chain
 * @param {number} [options.depth]        - current proxy recursion depth (0 at top level)
 * @returns {Promise<object>} success result or `{ success: false, error, message }`
 */
export async function fetchSource(address, chain, env, options = {}) {
  const { visited = new Set(), depth = 0 } = options;

  if (typeof address !== "string" || !ADDRESS_REGEX.test(address)) {
    return {
      success: false,
      error: "invalid_address",
      message: `Invalid address format: expected 0x-prefixed 40-char hex, got "${address}"`,
    };
  }

  const chainId = CHAIN_IDS[chain];
  if (!chainId) {
    return {
      success: false,
      error: "unsupported_chain",
      message: `Unsupported chain "${chain}". Supported: ${Object.keys(CHAIN_IDS).join(", ")}`,
    };
  }

  const apiKey = resolveApiKey(env);
  if (!apiKey) {
    return {
      success: false,
      error: "missing_api_key",
      message: "No Etherscan API key configured. Set ETHERSCAN_API_KEY in the environment.",
    };
  }

  const url =
    `${V2_BASE_URL}?chainid=${chainId}` +
    `&module=contract&action=getsourcecode` +
    `&address=${address}` +
    `&apikey=${encodeURIComponent(apiKey)}`;

  let raw = await callExplorer(url);

  // Soft retry on rate-limit replies. Etherscan returns HTTP 200 with a
  // `status:"0"` body like `{result:"Max calls per sec rate limit reached..."}`
  // when the per-second cap is exceeded — that's a transient condition, so
  // sleeping briefly and retrying once keeps the analysis flowing.
  if (raw.success && isRateLimited(raw.data)) {
    await sleep(RATE_LIMIT_RETRY_DELAY_MS);
    raw = await callExplorer(url);
  }

  if (!raw.success) return raw;

  const data = raw.data;

  // V2 error envelope: `{status:"0", message:"NOTOK", result:"<error string>"}`.
  if (data.status === "0" && typeof data.result === "string") {
    return {
      success: false,
      error: isRateLimited(data) ? "rate_limited" : "explorer_error",
      message: data.result || "Explorer API returned an error",
    };
  }

  if (!Array.isArray(data.result) || data.result.length === 0) {
    return {
      success: false,
      error: "not_found",
      message: `No contract data returned for ${address} on ${chain}`,
    };
  }

  const entry = data.result[0];

  // Unverified contracts come back with status "1" but an empty SourceCode.
  if (!entry.SourceCode || entry.SourceCode === "") {
    return {
      success: false,
      error: "unverified",
      message: `Contract source code is not verified on ${chain}`,
    };
  }

  const { files, combinedSource } = parseSourceCode(entry.SourceCode, entry.ContractName);

  const isProxy = entry.Proxy === "1";
  const implementationAddress =
    entry.Implementation && entry.Implementation !== "" ? entry.Implementation : null;

  const result = {
    success: true,
    address,
    chain,
    contractName: entry.ContractName || "Unknown",
    compiler: entry.CompilerVersion || "",
    optimization: {
      enabled: entry.OptimizationUsed === "1",
      runs: parseInt(entry.Runs || "0", 10) || 0,
    },
    evmVersion: entry.EVMVersion || "",
    licenseType: entry.LicenseType || "",
    source: combinedSource,
    files,
    isProxy,
    implementationAddress,
    abi: parseAbi(entry.ABI),
  };

  // Recurse into the implementation contract for proxies. We track visited
  // addresses (lowercased) to defend against proxy loops, and also cap the
  // recursion depth as a belt-and-braces guard.
  if (
    isProxy &&
    implementationAddress &&
    depth < MAX_PROXY_DEPTH &&
    !visited.has(implementationAddress.toLowerCase())
  ) {
    visited.add(address.toLowerCase());
    const impl = await fetchSource(implementationAddress, chain, env, {
      visited,
      depth: depth + 1,
    });

    if (impl.success) {
      result.implementation = impl;
      result.source =
        `// === PROXY CONTRACT (${address}) ===\n` +
        combinedSource +
        `\n\n// === IMPLEMENTATION CONTRACT (${implementationAddress}) ===\n` +
        impl.source;
      // Merge file lists so downstream agents can see everything with
      // origin-qualified names.
      result.files = [
        ...files.map((f) => ({ name: `proxy/${f.name}`, content: f.content })),
        ...impl.files.map((f) => ({ name: `implementation/${f.name}`, content: f.content })),
      ];
    } else {
      result.implementationError = impl.message || impl.error;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRateLimited(data) {
  return (
    data &&
    data.status === "0" &&
    typeof data.result === "string" &&
    RATE_LIMIT_PATTERN.test(data.result)
  );
}

function resolveApiKey(env) {
  if (!env) return "";
  const apiKey = env.ETHERSCAN_API_KEY;
  return (typeof apiKey === "string" && apiKey.length > 0) ? apiKey : "";
}

async function callExplorer(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err && err.name === "AbortError") {
      return {
        success: false,
        error: "timeout",
        message: `Explorer API timed out after ${FETCH_TIMEOUT_MS}ms`,
      };
    }
    return {
      success: false,
      error: "network_error",
      message: `Network error contacting explorer: ${err && err.message ? err.message : String(err)}`,
    };
  }
  clearTimeout(timer);

  if (!response.ok) {
    return {
      success: false,
      error: "http_error",
      message: `Explorer API returned HTTP ${response.status}`,
    };
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    return {
      success: false,
      error: "parse_error",
      message: "Explorer API returned a non-JSON response",
    };
  }

  return { success: true, data };
}

/**
 * Parse the SourceCode string returned by Etherscan into an array of files
 * plus a single concatenated source blob (with filename headers) suitable
 * for feeding to an LLM.
 *
 * Three shapes are possible:
 *   1. Standard JSON Input, double-brace wrapped: `{{ "language": ..., "sources": {...} }}`
 *   2. Standard JSON Input, plain JSON (single-brace): `{ "language": ..., "sources": {...} }`
 *   3. Flat single-file Solidity source
 *
 * The double-brace wrap is an Etherscan quirk — the outer `{}` must be peeled
 * off before parsing. Some multi-file contracts also come back as plain JSON
 * (non-Standard-JSON-Input verification) with a top-level filename-to-source
 * map, which we also handle.
 */
function parseSourceCode(rawSourceCode, contractName) {
  const doubleBraced = rawSourceCode.startsWith("{{") && rawSourceCode.endsWith("}}");

  if (doubleBraced) {
    const inner = rawSourceCode.slice(1, -1);
    const parsed = tryParseJson(inner);
    if (parsed) {
      const files = extractFiles(parsed);
      if (files) return buildMultiFileResult(files);
    }
    // If we can't parse a double-braced payload, fall through and treat the
    // whole thing as a single file so the caller still gets something.
  } else if (rawSourceCode.trimStart().startsWith("{")) {
    // Plain JSON multi-file (no double-brace wrapping).
    const parsed = tryParseJson(rawSourceCode);
    if (parsed) {
      const files = extractFiles(parsed);
      if (files) return buildMultiFileResult(files);
    }
  }

  // Single-file fallback.
  const fileName = `${contractName || "Contract"}.sol`;
  return buildSourceBundle([{ name: fileName, content: rawSourceCode }]);
}

/**
 * Given a parsed Standard JSON Input object (or a plain filename-to-source
 * map), return an array of `{ name, content }` file descriptors, or null if
 * the shape isn't recognized.
 */
function extractFiles(parsed) {
  if (!parsed || typeof parsed !== "object") return null;

  // Standard JSON Input: { language, sources: { "path/File.sol": { content } } }
  if (parsed.sources && typeof parsed.sources === "object") {
    const files = [];
    for (const [name, value] of Object.entries(parsed.sources)) {
      if (value && typeof value === "object" && typeof value.content === "string") {
        files.push({ name, content: value.content });
      } else if (typeof value === "string") {
        files.push({ name, content: value });
      }
    }
    return files.length > 0 ? files : null;
  }

  // Plain filename-to-source map: { "File.sol": { content } } or { "File.sol": "source" }.
  // This is a legacy shape — we only accept it when every key looks like a
  // path-or-filename (has an extension or a path separator) to avoid
  // misinterpreting unrelated JSON as a file map.
  const entries = Object.entries(parsed);
  if (entries.length === 0) return null;
  const looksLikeFileMap = entries.every(([k, v]) => {
    if (typeof k !== "string") return false;
    if (!/\.[A-Za-z0-9]+$/.test(k) && !k.includes("/")) return false;
    if (typeof v === "string") return true;
    return v && typeof v === "object" && typeof v.content === "string";
  });
  if (!looksLikeFileMap) return null;

  return entries.map(([name, value]) => ({
    name,
    content: typeof value === "string" ? value : value.content,
  }));
}

function buildMultiFileResult(files) {
  return buildSourceBundle(files);
}

function parseAbi(abiString) {
  if (!abiString || abiString === "Contract source code not verified") return [];
  try {
    return JSON.parse(abiString);
  } catch (_) {
    return [];
  }
}
