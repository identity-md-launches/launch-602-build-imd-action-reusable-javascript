// Verifying an x402 challenge and building the two signatures IMD expects.
// Everything that decides how much is paid, and to whom, is checked here
// before a signature is produced.
import { randomBytes } from 'node:crypto';
import { canonicalJson, sha256Hex } from './canonical.js';
import type { TypedData } from './eip712.js';
import { HEX32_RE, UINT_RE, isAddress, sameAddress, toChecksumAddress } from './hex.js';

/** IMD on Ethereum mainnet. Pinned: a challenge for any other token is refused. */
export const IMD_TOKEN = '0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7';
/** IMD uses 18 decimal places; pricing metadata must not redefine this unit. */
export const IMD_DECIMALS = 18;
export const NETWORK = 'eip155:1';
export const CHAIN_ID = 1;
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
/** x402 "exact" Permit2 proxy: the only spender a permit is signed for. */
export const X402_PERMIT2_PROXY = '0x402085c248EeA27D92E8b30b2C58ed07f9E20001';
/** The permit deadline ends at least this many seconds before the quote expires. */
export const DEADLINE_MARGIN_SECONDS = 5;

export interface PolicyPayment {
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  decimals: number;
}

export interface Capability {
  action: string;
  payment: PolicyPayment;
  quoteTtlSeconds: number;
}

export interface Quote {
  id: string;
  action: string;
  expiresAt: number;
  quoteHash: string;
  payment: PolicyPayment & { scheme: string };
  unitAmount?: string;
  runs?: number;
}

export interface Requirement {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

export interface Challenge {
  x402Version: number;
  resource: { url?: string; description?: string; mimeType?: string };
  accepts: Requirement[];
  quote: Quote;
  resourceUrl: string;
  requesterScopeHash: string;
  input?: unknown;
}

export interface PaymentPayload {
  x402Version: 2;
  resource: { url?: string; description?: string; mimeType?: string };
  accepted: Requirement;
  payload: {
    signature: string;
    permit2Authorization: {
      from: string;
      permitted: { token: string; amount: string };
      spender: string;
      nonce: string;
      deadline: string;
      witness: { to: string; validAfter: string };
    };
  };
}

export class PaymentRefused extends Error {}

function refuse(message: string): never {
  throw new PaymentRefused(`refusing to pay: ${message}`);
}

/** Parse a decimal token amount such as "0.5" into atomic units. */
export function parseUnits(value: string, decimals: number): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`"${value}" is not a decimal amount`);
  const frac = m[2] ?? '';
  if (frac.length > decimals) throw new Error(`"${value}" has more than ${decimals} decimal places`);
  return BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

export function formatUnits(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const frac = (value % base).toString().padStart(decimals, '0').replace(/0+$/, '');
  return frac ? `${value / base}.${frac}` : `${value / base}`;
}

/** Find and sanity-check the capability entry for an action. */
export function capabilityFor(capabilities: any, action: string): Capability {
  const entry = Array.isArray(capabilities?.actions)
    ? capabilities.actions.find((a: any) => a?.action === action)
    : undefined;
  if (!entry) throw new Error(`action ${action} is not offered by GET /requests/capabilities`);
  const p = entry.payment;
  if (!p || p.network !== NETWORK || !sameAddress(p.asset, IMD_TOKEN) || !isAddress(p.payTo) || !UINT_RE.test(p.amount)) {
    refuse('capabilities do not describe an IMD payment on Ethereum mainnet');
  }
  if (p.decimals !== IMD_DECIMALS) refuse('capabilities list invalid IMD token decimals');
  return entry as Capability;
}

/**
 * Check the 402 challenge against capabilities and the saved quote. Returns
 * the amount to pay in atomic units. Any mismatch in asset, payTo or amount
 * (including look-alike addresses) refuses.
 */
export function verifyChallenge(
  challenge: Challenge,
  ctx: { orderId: string; action: string; capability: Capability; nowSeconds: number },
): bigint {
  if (challenge?.x402Version !== 2) refuse('challenge is not x402 version 2');
  const req = challenge.accepts?.[0];
  if (!req) refuse('challenge has no payment requirements');
  const quote = challenge.quote;
  if (!quote) refuse('challenge has no quote');
  const cap = ctx.capability.payment;

  if (quote.id !== ctx.orderId) refuse('challenge quote is for a different order');
  if (quote.action !== ctx.action) refuse(`challenge quote is for ${quote.action}, not ${ctx.action}`);
  if (req.scheme !== 'exact' || quote.payment?.scheme !== 'exact') refuse('payment scheme is not "exact"');
  if (req.extra?.assetTransferMethod !== undefined && req.extra.assetTransferMethod !== 'permit2') {
    refuse('payment does not use Permit2');
  }
  if (req.network !== NETWORK || quote.payment.network !== NETWORK) refuse('payment is not on Ethereum mainnet');

  for (const [label, value] of [['challenge', req.asset], ['quote', quote.payment.asset], ['capabilities', cap.asset]]) {
    if (!sameAddress(value, IMD_TOKEN)) refuse(`${label} asset ${String(value)} is not IMD ${IMD_TOKEN}`);
  }
  if (!sameAddress(req.payTo, quote.payment.payTo)) refuse('challenge payTo differs from the quote');
  if (!sameAddress(req.payTo, cap.payTo)) refuse('challenge payTo differs from GET /requests/capabilities');

  if (!UINT_RE.test(String(req.amount)) || !UINT_RE.test(String(quote.payment.amount))) refuse('amount is not a decimal integer');
  const amount = BigInt(req.amount);
  if (amount !== BigInt(quote.payment.amount)) refuse('challenge amount differs from the quoted amount');
  if (quote.payment.decimals !== cap.decimals) refuse('token decimals differ from capabilities');
  // Per-run actions (schedules) quote unitAmount x runs; everything else is one unit.
  const unit = BigInt(quote.unitAmount ?? quote.payment.amount);
  const runs = BigInt(quote.runs ?? 1);
  if (unit !== BigInt(cap.amount)) refuse('quoted unit price differs from GET /requests/capabilities');
  if (amount !== unit * runs) refuse('quoted amount is not unit price x runs');
  if (amount === 0n) refuse('amount is zero');

  if (!HEX32_RE.test(challenge.requesterScopeHash ?? '')) refuse('requesterScopeHash is not 32 bytes of hex');
  if (!HEX32_RE.test(quote.quoteHash ?? '')) refuse('quoteHash is not 32 bytes of hex');
  if (typeof challenge.resourceUrl !== 'string' || !challenge.resourceUrl) refuse('challenge has no resourceUrl');
  if (challenge.resource?.url !== undefined && challenge.resource.url !== challenge.resourceUrl) {
    refuse('challenge resource.url differs from resourceUrl');
  }
  if (!Number.isSafeInteger(quote.expiresAt) || quote.expiresAt - DEADLINE_MARGIN_SECONDS <= ctx.nowSeconds + 10) {
    refuse('quote expires too soon to sign a payment');
  }
  return amount;
}

export function permitDeadline(challenge: Challenge, nowSeconds: number): bigint {
  const latest = challenge.quote.expiresAt - DEADLINE_MARGIN_SECONDS;
  const timeout = challenge.accepts[0]!.maxTimeoutSeconds;
  const wanted = Number.isSafeInteger(timeout) && timeout > 0 ? nowSeconds + timeout : latest;
  return BigInt(Math.min(wanted, latest));
}

export function randomNonce(): bigint {
  return BigInt(`0x${randomBytes(32).toString('hex')}`);
}

export function permit2TypedData(auth: PaymentPayload['payload']['permit2Authorization']): TypedData {
  return {
    domain: { name: 'Permit2', chainId: CHAIN_ID, verifyingContract: PERMIT2 },
    primaryType: 'PermitWitnessTransferFrom',
    types: {
      PermitWitnessTransferFrom: [
        { name: 'permitted', type: 'TokenPermissions' },
        { name: 'spender', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'witness', type: 'Witness' },
      ],
      TokenPermissions: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      Witness: [
        { name: 'to', type: 'address' },
        { name: 'validAfter', type: 'uint256' },
      ],
    },
    message: auth,
  };
}

/** Build the unsigned Permit2 authorization for exactly the quoted amount. */
export function buildAuthorization(
  challenge: Challenge,
  from: string,
  opts: { nonce: bigint; deadline: bigint },
): PaymentPayload['payload']['permit2Authorization'] {
  const req = challenge.accepts[0]!;
  return {
    from: toChecksumAddress(from),
    permitted: { token: toChecksumAddress(req.asset), amount: BigInt(challenge.quote.payment.amount).toString() },
    spender: X402_PERMIT2_PROXY,
    nonce: opts.nonce.toString(),
    deadline: opts.deadline.toString(),
    witness: { to: toChecksumAddress(req.payTo), validAfter: '0' },
  };
}

/** The x402 v2 payment payload, with no fields beyond what IMD accepts. */
export function buildPayment(
  challenge: Challenge,
  auth: PaymentPayload['payload']['permit2Authorization'],
  signature: string,
): PaymentPayload {
  const r = challenge.resource ?? {};
  const resource: PaymentPayload['resource'] = {};
  if (r.url !== undefined) resource.url = r.url;
  if (r.description !== undefined) resource.description = r.description;
  if (r.mimeType !== undefined) resource.mimeType = r.mimeType;
  return {
    x402Version: 2,
    resource,
    accepted: challenge.accepts[0]!,
    payload: { signature, permit2Authorization: auth },
  };
}

export function paymentHash(payment: PaymentPayload): string {
  return `0x${sha256Hex(canonicalJson(payment))}`;
}

export function encodePaymentHeader(payment: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payment), 'utf8').toString('base64');
}

export function quoteApprovalTypedData(challenge: Challenge, payment: PaymentPayload): TypedData {
  const q = challenge.quote;
  return {
    domain: { name: 'IdentityMD Paid Action', version: '1', chainId: CHAIN_ID },
    primaryType: 'QuoteApproval',
    types: {
      QuoteApproval: [
        { name: 'resource', type: 'string' },
        { name: 'requesterScopeHash', type: 'bytes32' },
        { name: 'quoteId', type: 'string' },
        { name: 'quoteHash', type: 'bytes32' },
        { name: 'paymentHash', type: 'bytes32' },
        { name: 'action', type: 'string' },
        { name: 'asset', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'payTo', type: 'address' },
        { name: 'expiresAt', type: 'uint256' },
      ],
    },
    message: {
      resource: challenge.resourceUrl,
      requesterScopeHash: `0x${challenge.requesterScopeHash}`,
      quoteId: q.id,
      quoteHash: `0x${q.quoteHash}`,
      paymentHash: paymentHash(payment),
      action: q.action,
      asset: q.payment.asset,
      amount: q.payment.amount,
      payTo: q.payment.payTo,
      expiresAt: BigInt(q.expiresAt),
    },
  };
}
