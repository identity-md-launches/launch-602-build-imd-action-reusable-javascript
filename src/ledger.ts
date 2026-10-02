// A GitHub Contents API compare-and-swap ledger shared by every CI run using
// one wallet. Reserving before signing closes the paid-by snapshot race.
// Reservations remain for 24 hours even if submission fails: this fails safe.
import { randomUUID } from 'node:crypto';
import type { ImdApi } from './api.js';
import { checkApiUrl } from './api.js';
import { UINT_RE } from './hex.js';
import { PaymentRefused } from './payment.js';
import { DAY_MS, checkDailyCap } from './spend.js';

interface Reservation {
  id: string;
  orderId: string;
  runKey: string;
  at: number;
  amount: string;
}

interface Ledger {
  version: 1;
  reservations: Reservation[];
}

interface LedgerResponse {
  sha: string;
  content: string;
  encoding: string;
}

const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_RE = /^[0-9a-f]{40}$/i;
const MAX_ATTEMPTS = 20;

export function validateLedgerRepo(repo: string): string {
  if (!REPO_RE.test(repo)) throw new Error('spend-ledger-repo must be a GitHub owner/repo');
  return repo;
}

function parseLedger(data: LedgerResponse): Ledger {
  if (!SHA_RE.test(data?.sha ?? '') || data?.encoding !== 'base64' || typeof data.content !== 'string') {
    throw new PaymentRefused('refusing to pay: spend ledger response is malformed');
  }
  let ledger: any;
  try {
    ledger = JSON.parse(Buffer.from(data.content.replace(/\s/g, ''), 'base64').toString('utf8'));
  } catch {
    throw new PaymentRefused('refusing to pay: spend ledger is not valid JSON');
  }
  if (ledger?.version !== 1 || !Array.isArray(ledger.reservations)) {
    throw new PaymentRefused('refusing to pay: spend ledger has an unsupported format');
  }
  for (const r of ledger.reservations) {
    if (
      typeof r?.id !== 'string' || typeof r.orderId !== 'string' || typeof r.runKey !== 'string' ||
      !Number.isSafeInteger(r.at) || typeof r.amount !== 'string' || !UINT_RE.test(r.amount)
    ) throw new PaymentRefused('refusing to pay: spend ledger contains an invalid reservation');
  }
  return ledger as Ledger;
}

/** Reserve one quote in a wallet ledger using an atomic GitHub file update. */
export async function reserveDailySpend(
  api: ImdApi,
  opts: {
    address: string;
    amount: bigint;
    cap: bigint;
    decimals: number;
    orderId: string;
    runKey: string;
    repo: string;
    token: string;
  },
): Promise<bigint> {
  const base = checkApiUrl(process.env.GITHUB_API_URL || 'https://api.github.com');
  const repo = validateLedgerRepo(opts.repo);
  const path = `/repos/${repo}/contents/.imd-spend-ledger/${opts.address.toLowerCase()}.json`;
  const url = `${base}${path}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${opts.token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const id = randomUUID();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const now = Date.now();
    const get = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    let sha: string | undefined;
    let ledger: Ledger = { version: 1, reservations: [] };
    if (get.status === 200) {
      const data = (await get.json()) as LedgerResponse;
      ledger = parseLedger(data);
      sha = data.sha;
    } else if (get.status !== 404) {
      throw new PaymentRefused(`refusing to pay: spend ledger read returned ${get.status}`);
    }

    const active = ledger.reservations.filter((r) => now - r.at < DAY_MS);
    if (active.some((r) => r.id === id)) {
      return active.reduce((sum, r) => sum + BigInt(r.amount), 0n) - opts.amount;
    }
    if (opts.runKey && active.some((r) => r.runKey === opts.runKey)) {
      throw new PaymentRefused('refusing to pay: this GitHub job already reserved a payment');
    }
    const reserved = active.reduce((sum, r) => sum + BigInt(r.amount), 0n);
    const spent = await checkDailyCap(api, {
      address: opts.address,
      amount: reserved + opts.amount,
      cap: opts.cap,
      decimals: opts.decimals,
      orderId: opts.orderId,
      now,
      excludeOrderIds: new Set(active.map((r) => r.orderId)),
    });
    const next: Ledger = {
      version: 1,
      reservations: [...active, { id, orderId: opts.orderId, runKey: opts.runKey, at: now, amount: opts.amount.toString() }],
    };
    const body: Record<string, string> = {
      message: 'Reserve IMD wallet spend',
      content: Buffer.from(JSON.stringify(next)).toString('base64'),
    };
    if (sha) body.sha = sha;
    let put: Response;
    try {
      put = await fetch(url, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      continue; // The write may have committed; the stable id is checked on the next read.
    }
    if (put.status === 200 || put.status === 201) return spent + reserved;
    if (put.status === 409 || put.status === 422) continue; // Lost the compare-and-swap; re-read both ledgers.
    throw new PaymentRefused(`refusing to pay: spend ledger update returned ${put.status}`);
  }
  throw new PaymentRefused(`refusing to pay: could not reserve the daily cap after ${MAX_ATTEMPTS} attempts`);
}
