#!/usr/bin/env node

import http from 'node:http';

import { onRequest as applyMiddleware } from '../functions/api/_middleware.js';
import { onRequestPost as analyzeRequest } from '../functions/api/lib/local-analyze.js';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 8788;
const MAX_REQUEST_BYTES = 64 * 1024;

export function createRunnerServer(options = {}) {
  const env = options.env || process.env;
  const analyzeHandler = options.analyzeHandler || analyzeRequest;
  assertRunnerEnvironment(env);

  return http.createServer(async (incoming, outgoing) => {
    try {
      const request = await buildWebRequest(incoming, {
        maxRequestBytes: options.maxRequestBytes || MAX_REQUEST_BYTES,
      });
      const response = await applyMiddleware({
        request,
        env,
        next: () => routeRequest(request, env, analyzeHandler),
      });
      await sendWebResponse(outgoing, response);
    } catch (error) {
      const status = error?.code === 'REQUEST_TOO_LARGE' ? 413 : 500;
      const body = status === 413
        ? {
            success: false,
            error: 'request_too_large',
            message: `Request body exceeds ${options.maxRequestBytes || MAX_REQUEST_BYTES} bytes.`,
          }
        : {
            success: false,
            error: 'internal_error',
            message: 'The local analysis runner encountered an unexpected error.',
          };

      if (status === 500) {
        console.error('Local runner request failed:', error);
      }

      await sendWebResponse(outgoing, jsonResponse(status, body));
    }
  });
}

export function assertRunnerEnvironment(env) {
  if (!cleanEnvString(env?.ANALYZE_RELAY_TOKEN)) {
    throw new Error('opensentry-runner: ANALYZE_RELAY_TOKEN is required');
  }
  if (cleanEnvString(env?.ANALYZE_RELAY_URL)) {
    throw new Error('opensentry-runner: ANALYZE_RELAY_URL must not be set on the local runner');
  }
}

async function routeRequest(request, env, analyzeHandler) {
  const url = new URL(request.url);

  if (url.pathname === '/api/health') {
    return jsonResponse(200, {
      success: true,
      mode: 'runner',
    });
  }

  if (url.pathname === '/api/analyze') {
    if (request.method !== 'POST') {
      return jsonResponse(405, {
        success: false,
        error: 'method_not_allowed',
        message: 'Only POST is allowed.',
      });
    }
    return analyzeHandler({ request, env });
  }

  return jsonResponse(404, {
    success: false,
    error: 'not_found',
    message: 'Route not found.',
  });
}

async function buildWebRequest(incoming, { maxRequestBytes }) {
  const host = incoming.headers.host || `${DEFAULT_HOST}:${DEFAULT_PORT}`;
  const url = new URL(incoming.url || '/', `http://${host}`);
  const body = await readRequestBody(incoming, maxRequestBytes);
  const init = {
    method: incoming.method || 'GET',
    headers: incoming.headers,
  };

  if (body.length > 0) {
    init.body = body;
  }

  return new Request(url, init);
}

async function readRequestBody(incoming, maxRequestBytes) {
  const chunks = [];
  let size = 0;

  for await (const chunk of incoming) {
    size += chunk.length;
    if (size > maxRequestBytes) {
      const error = new Error('Request body is too large');
      error.code = 'REQUEST_TOO_LARGE';
      throw error;
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

async function sendWebResponse(outgoing, response) {
  const body = Buffer.from(await response.arrayBuffer());
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  outgoing.end(body);
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
    },
  });
}

function cleanEnvString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export const __internal = Object.freeze({
  DEFAULT_HOST,
  DEFAULT_PORT,
  MAX_REQUEST_BYTES,
  routeRequest,
  buildWebRequest,
  readRequestBody,
  sendWebResponse,
});

if (import.meta.url === `file://${process.argv[1]}`) {
  const host = cleanEnvString(process.env.RUNNER_HOST) || DEFAULT_HOST;
  const port = parsePort(process.env.PORT);
  const server = createRunnerServer();

  server.listen(port, host, () => {
    console.log(`OpenSentry runner listening on http://${host}:${port}`);
  });

  const close = () => {
    server.close(() => {
      process.exitCode = 0;
    });
  };

  process.once('SIGINT', close);
  process.once('SIGTERM', close);
}

function parsePort(value) {
  if (value == null || value === '') return DEFAULT_PORT;
  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error('opensentry-runner: PORT must be an integer between 1 and 65535');
  }
  return parsed;
}
