// Runs the committed bundle (dist/index.js) the way the GitHub runner does:
// inputs as INPUT_* variables, outputs written to a GITHUB_OUTPUT file.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secp256k1 } from '@noble/curves/secp256k1';
import { bytesToHex } from '../../src/hex.js';

// Compiled to build/test/helpers/, three levels below the repository root.
export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const DIST = join(ROOT, 'dist', 'index.js');

/** A fresh throwaway key for every test. It never holds funds. */
export function throwawayKey(): string {
  return `0x${bytesToHex(secp256k1.utils.randomPrivateKey())}`;
}

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  outputs: Record<string, string>;
}

function parseOutputs(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /^([\w-]+)<<(\S+)\n([\s\S]*?)\n\2$/gm;
  for (const m of text.matchAll(re)) out[m[1]!] = m[3]!;
  return out;
}

export async function runAction(opts: {
  inputs: Record<string, string>;
  event?: { name: string; payload: unknown };
  env?: Record<string, string>;
  args?: string[];
  withLedger?: boolean;
}): Promise<RunResult> {
  const dir = mkdtempSync(join(tmpdir(), 'imd-action-test-'));
  const outputFile = join(dir, 'output');
  writeFileSync(outputFile, '');
  const env: Record<string, string> = { PATH: process.env.PATH ?? '', GITHUB_OUTPUT: outputFile, GITHUB_WORKSPACE: dir };
  if (opts.inputs['dry-run'] === 'false' && opts.inputs['api-url']?.startsWith('http://127.0.0.1') && opts.withLedger !== false) {
    env.GITHUB_API_URL = opts.inputs['api-url'];
    env['INPUT_SPEND-LEDGER-REPO'] = 'owner/ledger';
    env['INPUT_SPEND-LEDGER-TOKEN'] = 'throwaway-ledger-token';
  }
  if (opts.event) {
    const eventPath = join(dir, 'event.json');
    writeFileSync(eventPath, JSON.stringify(opts.event.payload));
    env.GITHUB_EVENT_NAME = opts.event.name;
    env.GITHUB_EVENT_PATH = eventPath;
  }
  for (const [k, v] of Object.entries(opts.inputs)) env[`INPUT_${k.toUpperCase()}`] = v;
  Object.assign(env, opts.env);

  const child = spawn(process.execPath, [DIST, ...(opts.args ?? [])], { env, cwd: dir });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => (stdout += d));
  child.stderr.on('data', (d) => (stderr += d));
  const code = await new Promise<number | null>((r) => child.on('close', r));
  return { code, stdout, stderr, outputs: parseOutputs(readFileSync(outputFile, 'utf8')) };
}
