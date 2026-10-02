// Spending caps, enforced before any signature is made.
//
// The per-request cap is purely local. The per-day cap needs memory across CI
// runs, which ephemeral runners do not have, so it reads the wallet's own
// payment history from GET /requests/paid-by/:address and fails closed when
// that history is unavailable.
import type { ImdApi } from './api.js';
import { UINT_RE } from './hex.js';
import { PaymentRefused, formatUnits } from './payment.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** Order statuses that never moved tokens. */
const NOT_SPENT = new Set(['quoted', 'expired', 'payment_failed']);

export function checkPerRequestCap(amount: bigint, cap: bigint, decimals: number): void {
  if (amount > cap) {
    throw new PaymentRefused(
      `refusing to pay: quote is ${formatUnits(amount, decimals)} IMD, above max-imd ${formatUnits(cap, decimals)} IMD`,
    );
  }
}

/** Sum what a wallet spent in the last 24 hours, from its paid-by history. */
export function spentInLastDay(history: any, now: number, excludeOrderId: string, fallbackAmount: bigint): bigint {
  if (!history || !Array.isArray(history.orders)) throw new Error('paid-by history has no orders list');
  let total = 0n;
  for (const order of history.orders) {
    if (!order || order.orderId === excludeOrderId || NOT_SPENT.has(order.status)) continue;
    const when = Date.parse(order.paidAt ?? order.createdAt ?? '');
    // An undated entry counts: unknown is treated as spent today.
    if (Number.isFinite(when) && now - when > DAY_MS) continue;
    const amount = order.payment?.amount ?? order.amount;
    // Unknown amounts count as one quoted price rather than zero.
    total += typeof amount === 'string' && UINT_RE.test(amount) ? BigInt(amount) : fallbackAmount;
  }
  return total;
}

export async function checkDailyCap(
  api: ImdApi,
  opts: { address: string; amount: bigint; cap: bigint; decimals: number; orderId: string; now?: number },
): Promise<bigint> {
  const res = await api.raw('GET', `/requests/paid-by/${opts.address.toLowerCase()}`, { auth: false });
  if (res.status !== 200) {
    throw new PaymentRefused(`refusing to pay: could not read today's spending (paid-by returned ${res.status})`);
  }
  const spent = spentInLastDay(res.body, opts.now ?? Date.now(), opts.orderId, opts.amount);
  if (spent + opts.amount > opts.cap) {
    const f = (v: bigint) => formatUnits(v, opts.decimals);
    throw new PaymentRefused(
      `refusing to pay: ${f(spent)} IMD spent in the last 24h + ${f(opts.amount)} IMD exceeds max-imd-per-day ${f(opts.cap)} IMD`,
    );
  }
  return spent;
}
