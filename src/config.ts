// Reads and validates the action inputs. Values are never echoed: errors name
// the input, not its content.
import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { DEFAULT_API_URL, checkApiUrl } from './api.js';
import { getBooleanInput, getInput, takeSecretInput } from './gha.js';
import { validateLedgerRepo } from './ledger.js';

export const ACTIONS = [
  'job.open',
  'job.continue',
  'launch.open',
  'oracle.request',
  'workflow.open',
  'schedule.create',
  'schedule.topup',
] as const;

export interface Config {
  action: string;
  input: Record<string, unknown>;
  privateKey: string;
  maxImd: string;
  maxImdPerDay: string;
  dryRun: boolean;
  wait: boolean;
  waitTimeoutSeconds: number;
  pollIntervalSeconds: number;
  importRepo: boolean;
  importKind: string;
  check: boolean;
  apiUrl: string;
  spendLedgerRepo: string;
  spendLedgerToken: string;
}

function positiveNumber(name: string, fallback: string): number {
  const value = Number(getInput(name, fallback));
  if (!Number.isFinite(value) || value <= 0) throw new Error(`input ${name} must be a positive number`);
  return value;
}

/** `input` is inline JSON when it starts with "{", otherwise a path to a JSON file. */
export function loadInput(raw: string, workspace: string): Record<string, unknown> {
  if (!raw) throw new Error('input is required (inline JSON or a path to a JSON file)');
  let text = raw;
  if (!raw.startsWith('{')) {
    const path = isAbsolute(raw) ? raw : resolve(workspace, raw);
    try {
      text = readFileSync(path, 'utf8');
    } catch {
      throw new Error('input is neither inline JSON nor a readable file path');
    }
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('input is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('input must be a JSON object');
  return parsed as Record<string, unknown>;
}

export function readConfig(): Config {
  // The key is taken (and removed from the environment) first so that no later
  // error path can include it.
  const privateKey = takeSecretInput('private-key');
  const spendLedgerToken = takeSecretInput('spend-ledger-token');
  const action = getInput('action');
  if (!(ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`input action must be one of: ${ACTIONS.join(', ')}`);
  }
  const dryRun = getBooleanInput('dry-run', true);
  if (!dryRun && !privateKey) throw new Error('private-key is required when dry-run is false');
  const spendLedgerRepo = getInput('spend-ledger-repo');
  if (!dryRun && (!spendLedgerToken || !spendLedgerRepo)) {
    throw new Error('spend-ledger-repo and spend-ledger-token are required when dry-run is false');
  }
  if (spendLedgerRepo) validateLedgerRepo(spendLedgerRepo);
  const importKind = getInput('import-kind', 'code');
  if (!['code', 'contracts', 'site'].includes(importKind)) throw new Error('input import-kind must be code, contracts or site');
  return {
    action,
    input: loadInput(getInput('input'), process.env.GITHUB_WORKSPACE || process.cwd()),
    privateKey,
    maxImd: getInput('max-imd', '0.5'),
    maxImdPerDay: getInput('max-imd-per-day', '1'),
    dryRun,
    wait: getBooleanInput('wait', false),
    waitTimeoutSeconds: positiveNumber('wait-timeout', '1800'),
    pollIntervalSeconds: positiveNumber('poll-interval', '10'),
    importRepo: getBooleanInput('import-repo', false),
    importKind,
    check: getBooleanInput('check', true),
    apiUrl: checkApiUrl(getInput('api-url', DEFAULT_API_URL)),
    spendLedgerRepo,
    spendLedgerToken,
  };
}
