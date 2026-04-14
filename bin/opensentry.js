#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { loadLocalSource } from '../functions/api/lib/local-source.js';
import { analyzeContractSourceWithOptions } from '../functions/api/lib/analyze-pipeline.js';

export async function runCli(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const stderr = io.stderr || process.stderr;
  const env = io.env || process.env;

  try {
    const options = parseArgs(argv);

    if (options.help) {
      stdout.write(`${usage()}\n`);
      return 0;
    }

    const targetPath = options.path || options.file;
    const sourceResult = await loadLocalSource(targetPath);
    if (!sourceResult.success) {
      stderr.write(`${sourceResult.message}\n`);
      return 1;
    }

    const analysis = await analyzeContractSourceWithOptions({
      sourceResult,
      address: `local://${sourceResult.localPath}`,
      chain: options.chain || 'local',
      env,
      includeTrace: Boolean(options.traceDir),
    });

    const output = {
      success: true,
      source: {
        type: 'local',
        path: sourceResult.localPath,
        fileCount: sourceResult.files.length,
        contractName: sourceResult.contractName,
      },
      analysis: {
        contractName: analysis.contractName,
        address: analysis.address,
        chain: analysis.chain,
        isProxy: analysis.isProxy,
        implementationAddress: analysis.implementationAddress,
        implementationContractName: analysis.implementationContractName,
        timestamp: analysis.timestamp,
        report: analysis.report,
      },
    };

    if (options.out) {
      const outPath = path.resolve(options.out);
      await mkdir(path.dirname(outPath), { recursive: true });
      await writeFile(outPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    }

    if (options.traceDir && analysis.trace) {
      await writeTraceFiles(path.resolve(options.traceDir), sourceResult, analysis.trace);
    }

    if (options.json) {
      stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
      stdout.write(renderSummary(output, options));
    }

    return 0;
  } catch (error) {
    stderr.write(`${error?.message || String(error)}\n`);
    return 1;
  }
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    throw new Error(usage());
  }

  const [command, ...rest] = argv;
  if (command === '--help' || command === '-h') {
    return { help: true };
  }
  if (command !== 'analyze') {
    throw new Error(`Unknown command "${command}"\n\n${usage()}`);
  }

  const options = {
    json: false,
    out: null,
    traceDir: null,
    path: null,
    file: null,
    chain: null,
  };

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    const next = rest[i + 1];

    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--path') {
      options.path = requireValue(arg, next);
      i++;
      continue;
    }
    if (arg === '--file') {
      options.file = requireValue(arg, next);
      i++;
      continue;
    }
    if (arg === '--out') {
      options.out = requireValue(arg, next);
      i++;
      continue;
    }
    if (arg === '--trace-dir') {
      options.traceDir = requireValue(arg, next);
      i++;
      continue;
    }
    if (arg === '--chain') {
      options.chain = requireValue(arg, next);
      i++;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      return { help: true };
    }

    throw new Error(`Unknown option "${arg}"\n\n${usage()}`);
  }

  if (Boolean(options.path) === Boolean(options.file)) {
    throw new Error(`Specify exactly one of --path or --file\n\n${usage()}`);
  }

  return options;
}

function requireValue(flag, value) {
  if (typeof value !== 'string' || value.startsWith('--')) {
    throw new Error(`Missing value for ${flag}\n\n${usage()}`);
  }
  return value;
}

function usage() {
  return (
    'Usage:\n' +
    '  opensentry analyze --path <contracts-dir> [--chain <name>] [--json] [--out <file>] [--trace-dir <dir>]\n' +
    '  opensentry analyze --file <contract.sol> [--chain <name>] [--json] [--out <file>] [--trace-dir <dir>]\n' +
    '\n' +
    'Environment:\n' +
    '  AI_PROVIDER   gemini or claude (defaults to gemini)\n' +
    '  AI_API_KEY    model API key\n' +
    '  AI_MODEL      model name\n'
  );
}

function renderSummary(output, options) {
  const report = output.analysis.report;
  const findings = report.findings.map((finding) => (
    `- [${finding.severity}] ${finding.check} @ ${finding.location}\n` +
    `  ${finding.summary}\n`
  )).join('');

  let text =
    `OpenSentry local analysis\n` +
    `Source: ${output.source.path}\n` +
    `Contract: ${output.analysis.contractName}\n` +
    `Chain label: ${output.analysis.chain}\n` +
    `Files: ${output.source.fileCount}\n` +
    `Overall severity: ${report.overallSeverity}\n` +
    `Counts: critical=${report.criticalCount} warning=${report.warningCount} info=${report.infoCount}\n`;

  if (report.findings.length > 0) {
    text += `Findings:\n${findings}`;
  } else {
    text += 'Findings:\n- none\n';
  }

  if (options.out) {
    text += `Saved final JSON: ${path.resolve(options.out)}\n`;
  }
  if (options.traceDir) {
    text += `Saved trace files: ${path.resolve(options.traceDir)}\n`;
  }

  return text;
}

async function writeTraceFiles(traceDir, sourceResult, trace) {
  await mkdir(traceDir, { recursive: true });
  await mkdir(path.join(traceDir, 'prompts'), { recursive: true });
  await mkdir(path.join(traceDir, 'agent-results'), { recursive: true });

  await writeFile(path.join(traceDir, 'source.json'), `${JSON.stringify({
    contractName: sourceResult.contractName,
    localPath: sourceResult.localPath,
    files: sourceResult.files,
  }, null, 2)}\n`, 'utf8');
  await writeFile(path.join(traceDir, 'source.txt'), `${sourceResult.source}\n`, 'utf8');

  for (const cfg of trace.agentConfigs) {
    await writeFile(path.join(traceDir, 'prompts', `${cfg.key}.txt`), cfg.systemPrompt, 'utf8');
  }
  for (const run of trace.agentRuns) {
    await writeFile(path.join(traceDir, 'agent-results', `${run.key}.json`), `${JSON.stringify(run, null, 2)}\n`, 'utf8');
  }

  await writeFile(path.join(traceDir, 'merged-report.json'), `${JSON.stringify(trace.mergedReport, null, 2)}\n`, 'utf8');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}
