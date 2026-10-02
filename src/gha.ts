// A small stand-in for @actions/core: inputs, outputs, masking and logging.
// Every line written goes through redact(), so a registered secret can never
// reach the log even if it shows up inside a server error message.
import { appendFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const secrets: string[] = [];

/**
 * Register a value that must never be printed: every log line and output is
 * scrubbed of it. With `mask`, the GitHub runner is also asked to mask it, but
 * only inside Actions, since the ::add-mask:: line itself contains the value.
 * The private key is never passed with `mask`: GitHub already masks values
 * that come from `secrets.*`, and no line we write may contain the key.
 */
export function registerSecret(value: string, opts: { mask?: boolean } = {}): void {
  const variants = [value, value.startsWith('0x') ? value.slice(2) : `0x${value}`];
  for (const v of variants) {
    if (v.length >= 8 && !secrets.includes(v)) secrets.push(v);
  }
  if (opts.mask && process.env.GITHUB_ACTIONS === 'true') process.stdout.write(`::add-mask::${value}\n`);
}

export function redact(text: string): string {
  let out = text;
  for (const s of secrets) {
    out = out.split(s).join('***');
    out = out.split(s.toLowerCase()).join('***');
  }
  return out;
}

function escapeCommand(text: string): string {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export const log = {
  info(message: string): void {
    process.stdout.write(`${redact(message)}\n`);
  },
  notice(message: string): void {
    process.stdout.write(`::notice::${escapeCommand(redact(message))}\n`);
  },
  warning(message: string): void {
    process.stdout.write(`::warning::${escapeCommand(redact(message))}\n`);
  },
  error(message: string): void {
    process.stdout.write(`::error::${escapeCommand(redact(message))}\n`);
  },
};

export function inputEnvName(name: string): string {
  return `INPUT_${name.replace(/ /g, '_').toUpperCase()}`;
}

export function getInput(name: string, fallback = ''): string {
  const value = process.env[inputEnvName(name)];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

export function getBooleanInput(name: string, fallback: boolean): boolean {
  const raw = getInput(name, fallback ? 'true' : 'false').toLowerCase();
  if (['true', 'yes', '1'].includes(raw)) return true;
  if (['false', 'no', '0'].includes(raw)) return false;
  throw new Error(`input ${name} must be true or false`);
}

/** Read a secret input once and remove it from the environment. */
export function takeSecretInput(name: string): string {
  const env = inputEnvName(name);
  const value = (process.env[env] ?? '').trim();
  delete process.env[env];
  if (value) registerSecret(value);
  return value;
}

export function setOutput(name: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  const safe = redact(value);
  if (file) {
    const delimiter = `ghadelimiter_${randomBytes(8).toString('hex')}`;
    appendFileSync(file, `${name}<<${delimiter}\n${safe}\n${delimiter}\n`);
  } else {
    process.stdout.write(`${name}=${safe}\n`);
  }
}
