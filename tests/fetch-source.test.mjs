// Unit tests for functions/api/lib/fetch-source.js
//
// Run:  node --test tests/fetch-source.test.mjs
//
// The tests stub `globalThis.fetch` to return canned explorer responses so
// they can exercise every parser / error path without network access. If
// ETHERSCAN_API_KEY is set in the environment, a small live-integration
// section also runs against a known USDC contract on Ethereum.

import test from "node:test";
import assert from "node:assert/strict";

import { fetchSource } from "../functions/api/lib/fetch-source.js";

const MOCK_ENV = { ETHERSCAN_API_KEY: "test-key" };
const ADDR = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // USDC proxy
const IMPL_ADDR = "0x43506849D7C04F9138D1A2050bbF3A0c054402dd";

// ---------- helpers -------------------------------------------------------

function stubFetch(handler) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => handler(url, init);
  return () => {
    globalThis.fetch = original;
  };
}

function explorerOk(resultArray) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: "1", message: "OK", result: resultArray }),
  };
}

function explorerErr(message) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ status: "0", message: "NOTOK", result: message }),
  };
}

// A minimal verified single-file entry, matching the shape Etherscan's V2
// getsourcecode returns.
function singleFileEntry(overrides = {}) {
  return {
    SourceCode: "pragma solidity 0.8.20;\ncontract Hello { uint256 public x; }",
    ABI: '[{"inputs":[],"name":"x","outputs":[{"type":"uint256"}],"type":"function"}]',
    ContractName: "Hello",
    CompilerVersion: "v0.8.20+commit.a1b79de6",
    CompilerType: "Solidity",
    OptimizationUsed: "1",
    Runs: "200",
    ConstructorArguments: "",
    EVMVersion: "paris",
    Library: "",
    ContractFileName: "",
    LicenseType: "MIT",
    Proxy: "0",
    Implementation: "",
    SwarmSource: "",
    ...overrides,
  };
}

// A multi-file Standard JSON Input entry, double-brace wrapped as Etherscan
// returns it.
function multiFileEntry(overrides = {}) {
  const sji = {
    language: "Solidity",
    sources: {
      "src/A.sol": { content: "pragma solidity 0.8.20;\ncontract A {}" },
      "src/B.sol": { content: "pragma solidity 0.8.20;\ncontract B {}" },
    },
    settings: { optimizer: { enabled: true, runs: 200 } },
  };
  return {
    SourceCode: "{" + JSON.stringify(sji) + "}", // outer brace = double-brace wrap
    ABI: "[]",
    ContractName: "A",
    CompilerVersion: "v0.8.20+commit.a1b79de6",
    CompilerType: "Solidity",
    OptimizationUsed: "1",
    Runs: "200",
    ConstructorArguments: "",
    EVMVersion: "paris",
    Library: "",
    ContractFileName: "src/A.sol",
    LicenseType: "MIT",
    Proxy: "0",
    Implementation: "",
    SwarmSource: "",
    ...overrides,
  };
}

// ---------- tests ---------------------------------------------------------

test("rejects malformed addresses", async () => {
  const res = await fetchSource("not-an-address", "ethereum", MOCK_ENV);
  assert.equal(res.success, false);
  assert.equal(res.error, "invalid_address");
});

test("rejects too-short addresses", async () => {
  const res = await fetchSource("0x1234", "ethereum", MOCK_ENV);
  assert.equal(res.success, false);
  assert.equal(res.error, "invalid_address");
});

test("accepts mixed-case addresses", async () => {
  const restore = stubFetch(async () => explorerOk([singleFileEntry()]));
  try {
    const res = await fetchSource(ADDR, "ethereum", MOCK_ENV);
    assert.equal(res.success, true);
    assert.equal(res.contractName, "Hello");
  } finally {
    restore();
  }
});

test("rejects unsupported chains", async () => {
  const res = await fetchSource(ADDR, "solana", MOCK_ENV);
  assert.equal(res.success, false);
  assert.equal(res.error, "unsupported_chain");
});

test("rejects when no API key is configured", async () => {
  const res = await fetchSource(ADDR, "ethereum", {});
  assert.equal(res.success, false);
  assert.equal(res.error, "missing_api_key");
});

test("prefers legacy chain-specific key over unified key", async () => {
  let capturedUrl;
  const restore = stubFetch(async (url) => {
    capturedUrl = url;
    return explorerOk([singleFileEntry()]);
  });
  try {
    await fetchSource(ADDR, "base", {
      ETHERSCAN_API_KEY: "unified-key",
      BASESCAN_API_KEY: "legacy-base-key",
    });
    assert.ok(capturedUrl.includes("apikey=legacy-base-key"));
    assert.ok(capturedUrl.includes("chainid=8453"));
  } finally {
    restore();
  }
});

test("falls back to ETHERSCAN_API_KEY when chain-specific key is empty", async () => {
  let capturedUrl;
  const restore = stubFetch(async (url) => {
    capturedUrl = url;
    return explorerOk([singleFileEntry()]);
  });
  try {
    await fetchSource(ADDR, "polygon", { ETHERSCAN_API_KEY: "unified-key" });
    assert.ok(capturedUrl.includes("apikey=unified-key"));
    assert.ok(capturedUrl.includes("chainid=137"));
  } finally {
    restore();
  }
});

test("maps each supported chain to the correct V2 chainid", async () => {
  const expected = {
    ethereum: 1,
    base: 8453,
    arbitrum: 42161,
    optimism: 10,
    polygon: 137,
  };
  for (const [chain, id] of Object.entries(expected)) {
    let capturedUrl;
    const restore = stubFetch(async (url) => {
      capturedUrl = url;
      return explorerOk([singleFileEntry()]);
    });
    try {
      await fetchSource(ADDR, chain, MOCK_ENV);
      assert.ok(
        capturedUrl.includes(`chainid=${id}`),
        `${chain} should map to chainid=${id}, got url: ${capturedUrl}`,
      );
      assert.ok(capturedUrl.startsWith("https://api.etherscan.io/v2/api?"));
    } finally {
      restore();
    }
  }
});

test("parses a verified single-file contract", async () => {
  const restore = stubFetch(async () => explorerOk([singleFileEntry()]));
  try {
    const res = await fetchSource(ADDR, "ethereum", MOCK_ENV);
    assert.equal(res.success, true);
    assert.equal(res.contractName, "Hello");
    assert.equal(res.compiler, "v0.8.20+commit.a1b79de6");
    assert.deepEqual(res.optimization, { enabled: true, runs: 200 });
    assert.equal(res.evmVersion, "paris");
    assert.equal(res.licenseType, "MIT");
    assert.equal(res.isProxy, false);
    assert.equal(res.implementationAddress, null);
    assert.equal(res.files.length, 1);
    assert.equal(res.files[0].name, "Hello.sol");
    assert.ok(res.files[0].content.includes("contract Hello"));
    assert.ok(res.source.includes("contract Hello"));
    assert.ok(Array.isArray(res.abi));
    assert.equal(res.abi.length, 1);
  } finally {
    restore();
  }
});

test("parses a multi-file contract with double-brace wrapping", async () => {
  const restore = stubFetch(async () => explorerOk([multiFileEntry()]));
  try {
    const res = await fetchSource(ADDR, "ethereum", MOCK_ENV);
    assert.equal(res.success, true);
    assert.equal(res.files.length, 2);
    const names = res.files.map((f) => f.name).sort();
    assert.deepEqual(names, ["src/A.sol", "src/B.sol"]);
    assert.ok(res.source.includes("// === File: src/A.sol ==="));
    assert.ok(res.source.includes("// === File: src/B.sol ==="));
    assert.ok(res.source.includes("contract A"));
    assert.ok(res.source.includes("contract B"));
  } finally {
    restore();
  }
});

test("parses plain JSON multi-file (no double-brace wrap)", async () => {
  // Some older verifications return a plain filename->source map at the top
  // level, without the Standard JSON Input wrapper and without double braces.
  const plainMap = {
    "Token.sol": "pragma solidity 0.8.0; contract Token {}",
    "Owned.sol": "pragma solidity 0.8.0; contract Owned {}",
  };
  const entry = singleFileEntry({
    SourceCode: JSON.stringify(plainMap),
    ContractName: "Token",
  });
  const restore = stubFetch(async () => explorerOk([entry]));
  try {
    const res = await fetchSource(ADDR, "ethereum", MOCK_ENV);
    assert.equal(res.success, true);
    assert.equal(res.files.length, 2);
    assert.ok(res.source.includes("// === File: Token.sol ==="));
    assert.ok(res.source.includes("// === File: Owned.sol ==="));
  } finally {
    restore();
  }
});

test("does not misinterpret random JSON as a file map", async () => {
  // Not a Standard JSON Input, not a filename-to-source map — should be
  // treated as a plain single-file contract, not split into "foo.sol" etc.
  const entry = singleFileEntry({
    SourceCode: JSON.stringify({ foo: "bar", baz: "qux" }),
    ContractName: "NotAFileMap",
  });
  const restore = stubFetch(async () => explorerOk([entry]));
  try {
    const res = await fetchSource(ADDR, "ethereum", MOCK_ENV);
    assert.equal(res.success, true);
    assert.equal(res.files.length, 1);
    assert.equal(res.files[0].name, "NotAFileMap.sol");
    assert.ok(res.source.includes('"foo"'));
  } finally {
    restore();
  }
});

test("falls back to single-file when double-braced payload is malformed", async () => {
  const entry = singleFileEntry({
    SourceCode: "{{ this is not valid json }}",
    ContractName: "Broken",
  });
  const restore = stubFetch(async () => explorerOk([entry]));
  try {
    const res = await fetchSource(ADDR, "ethereum", MOCK_ENV);
    assert.equal(res.success, true);
    assert.equal(res.files.length, 1);
    assert.equal(res.files[0].name, "Broken.sol");
    assert.ok(res.source.includes("this is not valid json"));
  } finally {
    restore();
  }
});

test("reports unverified contracts", async () => {
  const entry = singleFileEntry({
    SourceCode: "",
    ABI: "Contract source code not verified",
    ContractName: "",
  });
  const restore = stubFetch(async () => explorerOk([entry]));
  try {
    const res = await fetchSource(ADDR, "ethereum", MOCK_ENV);
    assert.equal(res.success, false);
    assert.equal(res.error, "unverified");
    assert.match(res.message, /not verified/);
  } finally {
    restore();
  }
});

test("retries once on rate-limit then succeeds", async () => {
  let call = 0;
  const restore = stubFetch(async () => {
    call += 1;
    if (call === 1) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: "0",
          message: "NOTOK",
          result: "Max calls per sec rate limit reached (3/sec)",
        }),
      };
    }
    return explorerOk([singleFileEntry()]);
  });
  try {
    const res = await fetchSource(ADDR, "ethereum", MOCK_ENV);
    assert.equal(res.success, true);
    assert.equal(res.contractName, "Hello");
    assert.equal(call, 2);
  } finally {
    restore();
  }
});

test("reports rate_limited after a second failure", async () => {
  let call = 0;
  const restore = stubFetch(async () => {
    call += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        status: "0",
        message: "NOTOK",
        result: "Max calls per sec rate limit reached (3/sec)",
      }),
    };
  });
  try {
    const res = await fetchSource(ADDR, "ethereum", MOCK_ENV);
    assert.equal(res.success, false);
    assert.equal(res.error, "rate_limited");
    assert.equal(call, 2);
  } finally {
    restore();
  }
});

test("surfaces explorer API errors", async () => {
  const restore = stubFetch(async () => explorerErr("Missing/Invalid API Key"));
  try {
    const res = await fetchSource(ADDR, "ethereum", MOCK_ENV);
    assert.equal(res.success, false);
    assert.equal(res.error, "explorer_error");
    assert.match(res.message, /Missing\/Invalid API Key/);
  } finally {
    restore();
  }
});

test("handles HTTP errors from the explorer", async () => {
  const restore = stubFetch(async () => ({
    ok: false,
    status: 503,
    json: async () => ({}),
  }));
  try {
    const res = await fetchSource(ADDR, "ethereum", MOCK_ENV);
    assert.equal(res.success, false);
    assert.equal(res.error, "http_error");
    assert.match(res.message, /503/);
  } finally {
    restore();
  }
});

test("handles non-JSON responses gracefully", async () => {
  const restore = stubFetch(async () => ({
    ok: true,
    status: 200,
    json: async () => {
      throw new Error("Unexpected token");
    },
  }));
  try {
    const res = await fetchSource(ADDR, "ethereum", MOCK_ENV);
    assert.equal(res.success, false);
    assert.equal(res.error, "parse_error");
  } finally {
    restore();
  }
});

test("handles network errors", async () => {
  const restore = stubFetch(async () => {
    throw new TypeError("fetch failed");
  });
  try {
    const res = await fetchSource(ADDR, "ethereum", MOCK_ENV);
    assert.equal(res.success, false);
    assert.equal(res.error, "network_error");
  } finally {
    restore();
  }
});

test("recursively fetches proxy implementation and merges sources", async () => {
  let call = 0;
  const restore = stubFetch(async (url) => {
    call += 1;
    if (call === 1) {
      // proxy call
      assert.ok(url.includes(`address=${ADDR}`));
      return explorerOk([
        singleFileEntry({
          ContractName: "MyProxy",
          SourceCode: "// proxy source\ncontract MyProxy {}",
          Proxy: "1",
          Implementation: IMPL_ADDR,
        }),
      ]);
    }
    // implementation call
    assert.ok(url.includes(`address=${IMPL_ADDR}`));
    return explorerOk([
      singleFileEntry({
        ContractName: "MyImpl",
        SourceCode: "// impl source\ncontract MyImpl {}",
        Proxy: "0",
        Implementation: "",
      }),
    ]);
  });
  try {
    const res = await fetchSource(ADDR, "ethereum", MOCK_ENV);
    assert.equal(res.success, true);
    assert.equal(res.isProxy, true);
    assert.equal(res.implementationAddress, IMPL_ADDR);
    assert.ok(res.implementation);
    assert.equal(res.implementation.contractName, "MyImpl");
    // Combined source contains both, with banners.
    assert.ok(res.source.includes("=== PROXY CONTRACT"));
    assert.ok(res.source.includes("=== IMPLEMENTATION CONTRACT"));
    assert.ok(res.source.includes("contract MyProxy"));
    assert.ok(res.source.includes("contract MyImpl"));
    // Files are origin-qualified.
    const names = res.files.map((f) => f.name);
    assert.ok(names.some((n) => n.startsWith("proxy/")));
    assert.ok(names.some((n) => n.startsWith("implementation/")));
    assert.equal(call, 2);
  } finally {
    restore();
  }
});

test("proxy loop: does not refetch an already-visited implementation", async () => {
  const addrA = "0x000000000000000000000000000000000000aaaa";
  const addrB = "0x000000000000000000000000000000000000bbbb";
  let callsA = 0;
  let callsB = 0;
  const restore = stubFetch(async (url) => {
    if (url.toLowerCase().includes(`address=${addrA}`)) {
      callsA += 1;
      return explorerOk([
        singleFileEntry({
          ContractName: "A",
          SourceCode: "contract A {}",
          Proxy: "1",
          Implementation: addrB,
        }),
      ]);
    }
    if (url.toLowerCase().includes(`address=${addrB}`)) {
      callsB += 1;
      return explorerOk([
        singleFileEntry({
          ContractName: "B",
          SourceCode: "contract B {}",
          Proxy: "1",
          Implementation: addrA, // points back to A -> should NOT recurse
        }),
      ]);
    }
    throw new Error(`unexpected url: ${url}`);
  });
  try {
    const res = await fetchSource(addrA, "ethereum", MOCK_ENV);
    assert.equal(res.success, true);
    // A should be fetched once, B should be fetched once; the A->B->A loop
    // must not cause a third fetch.
    assert.equal(callsA, 1);
    assert.equal(callsB, 1);
  } finally {
    restore();
  }
});

test("proxy implementation fetch failure is reported but top result still succeeds", async () => {
  let call = 0;
  const restore = stubFetch(async () => {
    call += 1;
    if (call === 1) {
      return explorerOk([
        singleFileEntry({
          ContractName: "MyProxy",
          Proxy: "1",
          Implementation: IMPL_ADDR,
        }),
      ]);
    }
    return explorerErr("rate limit exceeded");
  });
  try {
    const res = await fetchSource(ADDR, "ethereum", MOCK_ENV);
    assert.equal(res.success, true);
    assert.equal(res.isProxy, true);
    assert.ok(res.implementationError);
    assert.match(res.implementationError, /rate limit/);
  } finally {
    restore();
  }
});

test("URL-encodes the API key to prevent query-string injection", async () => {
  let capturedUrl;
  const restore = stubFetch(async (url) => {
    capturedUrl = url;
    return explorerOk([singleFileEntry()]);
  });
  try {
    await fetchSource(ADDR, "ethereum", { ETHERSCAN_API_KEY: "abc&evil=1" });
    assert.ok(capturedUrl.includes("apikey=abc%26evil%3D1"));
    assert.ok(!capturedUrl.includes("abc&evil=1"));
  } finally {
    restore();
  }
});

// ---------- optional live integration ------------------------------------
//
// Node's test runner schedules top-level `test()` calls concurrently, which
// would blow past Etherscan's 3-calls-per-second free-tier rate limit. Each
// live test routes its body through a module-level promise queue so they
// execute strictly sequentially with a safety stagger between them.

const LIVE_KEY = process.env.ETHERSCAN_API_KEY;
const LIVE_ENV = LIVE_KEY ? { ETHERSCAN_API_KEY: LIVE_KEY } : null;

let liveQueue = Promise.resolve();
function liveSerial(fn) {
  const run = liveQueue.then(async () => {
    try {
      return await fn();
    } finally {
      await new Promise((r) => setTimeout(r, 1500));
    }
  });
  liveQueue = run.catch(() => {});
  return run;
}

if (LIVE_KEY) {
  test("[live] USDC proxy on Ethereum -> fetches both proxy and impl", async () => {
    await liveSerial(async () => {
      const res = await fetchSource(
        "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        "ethereum",
        LIVE_ENV,
      );
      assert.equal(res.success, true, `expected success, got: ${JSON.stringify(res)}`);
      assert.ok(res.contractName.length > 0);
      assert.ok(res.source.length > 100);
      assert.ok(Array.isArray(res.files) && res.files.length > 0);
      assert.equal(res.isProxy, true);
      assert.ok(
        res.implementationAddress && /^0x[a-fA-F0-9]{40}$/.test(res.implementationAddress),
      );
      assert.ok(res.implementation, "expected implementation to be fetched");
      assert.ok(res.source.includes("=== PROXY CONTRACT"));
      assert.ok(res.source.includes("=== IMPLEMENTATION CONTRACT"));
    });
  });

  test("[live] EOA (vitalik.eth) -> reported as unverified", async () => {
    await liveSerial(async () => {
      const res = await fetchSource(
        "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        "ethereum",
        LIVE_ENV,
      );
      assert.equal(res.success, false);
      assert.equal(res.error, "unverified", `got: ${JSON.stringify(res)}`);
    });
  });

  test("[live] WETH on Ethereum -> single-file verified contract", async () => {
    await liveSerial(async () => {
      const res = await fetchSource(
        "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "ethereum",
        LIVE_ENV,
      );
      assert.equal(res.success, true, `expected success, got: ${JSON.stringify(res)}`);
      assert.equal(res.contractName, "WETH9");
      assert.equal(res.isProxy, false);
      assert.equal(res.files.length, 1);
      assert.ok(res.source.includes("contract WETH9"));
      assert.ok(res.compiler.startsWith("v0.4"));
    });
  });

  test("[live] USDbC on Base -> verified multi-chain fetch", async () => {
    await liveSerial(async () => {
      const res = await fetchSource(
        "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",
        "base",
        LIVE_ENV,
      );
      assert.equal(res.success, true, `expected success, got: ${JSON.stringify(res)}`);
      assert.equal(res.chain, "base");
      assert.ok(res.contractName.length > 0);
      assert.ok(res.source.length > 100);
    });
  });
}
