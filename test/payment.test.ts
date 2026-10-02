import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canonicalJson } from '../src/canonical.js';
import {
  DEADLINE_MARGIN_SECONDS,
  IMD_TOKEN,
  PaymentRefused,
  buildAuthorization,
  buildPayment,
  capabilityFor,
  formatUnits,
  parseUnits,
  paymentHash,
  permitDeadline,
  verifyChallenge,
  type Challenge,
} from '../src/payment.js';
import { checkPerRequestCap, spentInLastDay, DAY_MS } from '../src/spend.js';

const PAY_TO = '0x4e0fa57bde726079356537e2f34d671e9f41adbc';
const PRICE = '500000000000000000';
const NOW = 1_800_000_000;
const ORDER = '0b6f8f5e-4a7c-4d1e-9b2a-3c5d7e9f1a2b';

const capabilities = {
  actions: [
    { action: 'job.open', version: 'job-1', payment: { network: 'eip155:1', asset: IMD_TOKEN, amount: PRICE, payTo: PAY_TO, decimals: 18 }, quoteTtlSeconds: 600 },
    { action: 'schedule.create', version: 'schedule-1', payment: { network: 'eip155:1', asset: IMD_TOKEN, amount: PRICE, payTo: PAY_TO, decimals: 18 }, quoteTtlSeconds: 600 },
  ],
};

function challenge(edit?: (c: Challenge) => void): Challenge {
  const c: Challenge = {
    x402Version: 2,
    resource: { url: `https://api.imd.fun/requests/${ORDER}/submit` },
    accepts: [{ scheme: 'exact', network: 'eip155:1', asset: IMD_TOKEN, amount: PRICE, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { assetTransferMethod: 'permit2' } }],
    quote: {
      id: ORDER,
      action: 'job.open',
      expiresAt: NOW + 600,
      quoteHash: 'c'.repeat(64),
      payment: { network: 'eip155:1', asset: IMD_TOKEN, amount: PRICE, payTo: PAY_TO, decimals: 18, scheme: 'exact' },
    },
    resourceUrl: `https://api.imd.fun/requests/${ORDER}/submit`,
    requesterScopeHash: 'd'.repeat(64),
  };
  edit?.(c);
  return c;
}

const verify = (c: Challenge, action = 'job.open') =>
  verifyChallenge(c, { orderId: ORDER, action, capability: capabilityFor(capabilities, action), nowSeconds: NOW });

describe('verifyChallenge', () => {
  it('accepts a matching challenge and returns the quoted amount', () => {
    assert.equal(verify(challenge()), BigInt(PRICE));
  });

  it('accepts addresses in any letter case', () => {
    assert.equal(verify(challenge((c) => (c.accepts[0]!.payTo = PAY_TO.toUpperCase().replace('0X', '0x')))), BigInt(PRICE));
  });

  const refusals: [string, (c: Challenge) => void][] = [
    ['look-alike payTo', (c) => (c.accepts[0]!.payTo = '0x4e0fa57bde726079356537e2f34d671e9f41adbd')],
    ['payTo changed in challenge and quote', (c) => (c.accepts[0]!.payTo = c.quote.payment.payTo = '0x' + '1'.repeat(40))],
    ['another token', (c) => (c.accepts[0]!.asset = '0x' + '2'.repeat(40))],
    ['another token in the quote', (c) => (c.quote.payment.asset = '0x' + '2'.repeat(40))],
    ['amount above the quote', (c) => (c.accepts[0]!.amount = '500000000000000001')],
    ['amount below the quote', (c) => (c.accepts[0]!.amount = '1')],
    ['quote above the price', (c) => (c.accepts[0]!.amount = c.quote.payment.amount = '1000000000000000000')],
    ['another network', (c) => (c.accepts[0]!.network = 'eip155:8453')],
    ['another order', (c) => (c.quote.id = 'ffffffff-ffff-ffff-ffff-ffffffffffff')],
    ['another action', (c) => (c.quote.action = 'launch.open')],
    ['non-permit2 transfer', (c) => (c.accepts[0]!.extra = { assetTransferMethod: 'eip3009' })],
    ['expiring quote', (c) => (c.quote.expiresAt = NOW + 10)],
    ['bad quoteHash', (c) => (c.quote.quoteHash = 'zz')],
    ['resource url mismatch', (c) => (c.resource.url = 'https://evil.example/')],
  ];
  for (const [name, edit] of refusals) {
    it(`refuses ${name}`, () => {
      assert.throws(() => verify(challenge(edit)), PaymentRefused);
    });
  }

  it('allows per-run pricing only as unit price x runs', () => {
    const ok = challenge((c) => {
      c.quote.action = 'schedule.create';
      c.quote.unitAmount = PRICE;
      c.quote.runs = 3;
      c.accepts[0]!.amount = c.quote.payment.amount = (BigInt(PRICE) * 3n).toString();
    });
    assert.equal(verify(ok, 'schedule.create'), BigInt(PRICE) * 3n);
    const bad = challenge((c) => {
      c.quote.action = 'schedule.create';
      c.quote.unitAmount = PRICE;
      c.quote.runs = 3;
      c.accepts[0]!.amount = c.quote.payment.amount = (BigInt(PRICE) * 4n).toString();
    });
    assert.throws(() => verify(bad, 'schedule.create'), PaymentRefused);
  });

  it('refuses capabilities that point at another token', () => {
    const caps = structuredClone(capabilities);
    caps.actions[0]!.payment.asset = '0x' + '3'.repeat(40);
    assert.throws(() => capabilityFor(caps, 'job.open'), PaymentRefused);
  });
});

describe('payment payload', () => {
  const c = challenge();
  const auth = buildAuthorization(c, '0x' + 'ab'.repeat(20), { nonce: 42n, deadline: permitDeadline(c, NOW) });
  const payment = buildPayment(c, auth, '0x' + '00'.repeat(65));

  it('has exactly the documented fields, numbers as decimal strings', () => {
    assert.deepEqual(Object.keys(payment).sort(), ['accepted', 'payload', 'resource', 'x402Version']);
    assert.deepEqual(Object.keys(payment.payload).sort(), ['permit2Authorization', 'signature']);
    assert.deepEqual(Object.keys(auth).sort(), ['deadline', 'from', 'nonce', 'permitted', 'spender', 'witness']);
    assert.equal(auth.witness.to.toLowerCase(), PAY_TO);
    assert.equal(auth.witness.validAfter, '0');
    assert.equal(auth.permitted.amount, PRICE);
    assert.equal(auth.nonce, '42');
    assert.equal(auth.spender, '0x402085c248EeA27D92E8b30b2C58ed07f9E20001');
    assert.strictEqual(payment.accepted, c.accepts[0]);
  });

  it('never pays more than the quote', () => {
    assert.equal(BigInt(auth.permitted.amount), BigInt(c.quote.payment.amount));
  });

  it('ends the permit at least 5 s before the quote expires', () => {
    assert.equal(BigInt(auth.deadline), BigInt(NOW + 300));
    const late = challenge((x) => (x.accepts[0]!.maxTimeoutSeconds = 10_000));
    assert.equal(permitDeadline(late, NOW), BigInt(late.quote.expiresAt - DEADLINE_MARGIN_SECONDS));
  });

  it('hashes the key-sorted JSON', () => {
    assert.equal(canonicalJson({ b: 1, a: { d: '2', c: [3, null] } }), '{"a":{"c":[3,null],"d":"2"},"b":1}');
    assert.match(paymentHash(payment), /^0x[0-9a-f]{64}$/);
  });
});

describe('amounts and caps', () => {
  it('parses and formats IMD amounts', () => {
    assert.equal(parseUnits('0.5', 18), 500000000000000000n);
    assert.equal(parseUnits('2', 18), 2000000000000000000n);
    assert.equal(formatUnits(1500000000000000000n, 18), '1.5');
    assert.throws(() => parseUnits('-1', 18));
    assert.throws(() => parseUnits('1e18', 18));
  });

  it('enforces the per-request cap', () => {
    assert.doesNotThrow(() => checkPerRequestCap(500n, 500n, 0));
    assert.throws(() => checkPerRequestCap(501n, 500n, 0), PaymentRefused);
  });

  it('sums only the last 24 hours of spending orders', () => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    const iso = (ms: number) => new Date(ms).toISOString();
    const history = {
      orders: [
        { orderId: 'a', status: 'admitted', createdAt: iso(now - 1000), payment: { amount: '5' } },
        { orderId: 'b', status: 'payment_pending', createdAt: iso(now - 2000) },
        { orderId: 'c', status: 'admitted', createdAt: iso(now - DAY_MS - 1), payment: { amount: '100' } },
        { orderId: 'd', status: 'payment_failed', createdAt: iso(now), payment: { amount: '100' } },
        { orderId: 'self', status: 'quoted', createdAt: iso(now) },
      ],
    };
    // 'b' has no amount: counted as one price (7), not as zero.
    assert.equal(spentInLastDay(history, now, 'self', 7n), 12n);
    assert.throws(() => spentInLastDay({}, now, 'x', 1n));
  });
});
