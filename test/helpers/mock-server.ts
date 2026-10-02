// A local stand-in for api.imd.fun. It speaks the paid-request protocol,
// verifies both signatures the way the real server documents, and records
// every request so tests can assert what was (and was not) sent. Nothing here
// touches a chain or moves tokens.
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { secp256k1 } from '@noble/curves/secp256k1';
import { typedDataDigest, type TypedData } from '../../src/eip712.js';
import { hexToBytes } from '../../src/hex.js';
import {
  IMD_TOKEN,
  X402_PERMIT2_PROXY,
  permit2TypedData,
  quoteApprovalTypedData,
  type Challenge,
  type PaymentPayload,
} from '../../src/payment.js';
import { addressFromPublicKey } from '../../src/wallet.js';

export const PAY_TO = '0x4e0fa57bde726079356537e2f34d671e9f41adbc';
export const PRICE = '500000000000000000';

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: any;
}

export interface MockOptions {
  /** Edit the challenge before it is sent (to simulate a malicious server). */
  tamperChallenge?: (c: Challenge) => void;
  /** Blockers returned by the first N calls to /requests/check. */
  noisyChecks?: number;
  /** History returned by GET /requests/paid-by/:address. */
  paidBy?: any[];
  /** Edit capabilities (for a faulty or malicious API). */
  tamperCapability?: (payment: any) => void;
  /** Edit the signed submit outcome before it is sent. */
  tamperSubmit?: (result: any) => void;
  /** Hold the first N ledger reads until all have arrived, forcing a write race. */
  ledgerReadBarrier?: number;
}

export interface Mock {
  url: string;
  requests: Recorded[];
  payments: { payer: string; payment: PaymentPayload }[];
  close(): Promise<void>;
}

function recover(data: TypedData, signature: string): string {
  const bytes = hexToBytes(signature);
  if (bytes.length !== 65) throw new Error('signature must be 65 bytes');
  const sig = secp256k1.Signature.fromCompact(bytes.slice(0, 64)).addRecoveryBit(bytes[64]! - 27);
  return addressFromPublicKey(sig.recoverPublicKey(typedDataDigest(data)).toRawBytes(false));
}

function exactKeys(obj: any, keys: string[], where: string): void {
  const actual = Object.keys(obj ?? {}).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...keys].sort())) {
    throw new Error(`invalid_payment_shape at ${where}: ${actual.join(',')}`);
  }
}

/** The strict shape check the real server applies (no extra fields anywhere). */
function checkShape(p: any): void {
  exactKeys(p, ['x402Version', 'resource', 'accepted', 'payload'], 'payment');
  exactKeys(p.payload, ['signature', 'permit2Authorization'], 'payload');
  const a = p.payload.permit2Authorization;
  exactKeys(a, ['from', 'permitted', 'spender', 'nonce', 'deadline', 'witness'], 'permit2Authorization');
  exactKeys(a.permitted, ['token', 'amount'], 'permitted');
  exactKeys(a.witness, ['to', 'validAfter'], 'witness');
  for (const v of [a.permitted.amount, a.nonce, a.deadline, a.witness.validAfter]) {
    if (typeof v !== 'string' || !/^(0|[1-9][0-9]*)$/.test(v)) throw new Error('numbers must be decimal strings');
  }
}

export async function startMock(opts: MockOptions = {}): Promise<Mock> {
  const requests: Recorded[] = [];
  const payments: Mock['payments'] = [];
  const orders = new Map<string, { token: string; action: string; input: any; challenge?: Challenge; status: string; polls: number }>();
  const ledgerFiles = new Map<string, { sha: string; content: string }>();
  let ledgerRevision = 0;
  let ledgerReads = 0;
  let releaseLedgerReads: (() => void) | undefined;
  const ledgerReadGate = new Promise<void>((resolve) => { releaseLedgerReads = resolve; });
  let checks = 0;
  let base = '';

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? JSON.parse(text) : undefined;
    const path = req.url ?? '/';
    requests.push({ method: req.method ?? '', path, headers: req.headers, body });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    };
    const token = /^Bearer ([0-9a-f]{64})$/.exec(req.headers.authorization ?? '')?.[1];

    try {
      // Minimal GitHub Contents API: SHA is a compare-and-swap precondition.
      if (/^\/repos\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/contents\/\.imd-spend-ledger\/[0-9a-fx]+\.json$/.test(path)) {
        if (req.headers.authorization !== 'Bearer throwaway-ledger-token') return send(401, { message: 'Bad credentials' });
        const file = ledgerFiles.get(path);
        if (req.method === 'GET') {
          if (opts.ledgerReadBarrier && ++ledgerReads <= opts.ledgerReadBarrier) {
            if (ledgerReads === opts.ledgerReadBarrier) releaseLedgerReads?.();
            await ledgerReadGate;
          }
          return file ? send(200, { sha: file.sha, content: file.content, encoding: 'base64' }) : send(404, { message: 'Not Found' });
        }
        if (req.method === 'PUT') {
          if ((file?.sha ?? undefined) !== body?.sha) return send(409, { message: 'Conflict' });
          const sha = (++ledgerRevision).toString(16).padStart(40, '0');
          ledgerFiles.set(path, { sha, content: body.content });
          return send(file ? 200 : 201, { content: { sha } });
        }
      }
      if (req.method === 'GET' && path === '/requests/capabilities') {
        const payment = { network: 'eip155:1', asset: IMD_TOKEN, amount: PRICE, payTo: PAY_TO, decimals: 18 };
        opts.tamperCapability?.(payment);
        return send(200, {
          actions: ['job.open', 'job.continue', 'workflow.open'].map((action) => ({ action, version: '1', payment, quoteTtlSeconds: 600 })),
        });
      }
      if (req.method === 'POST' && path === '/requests/check') {
        checks++;
        const blockers = checks <= (opts.noisyChecks ?? 0) ? [{ code: 'noise', detail: 'flaky judge' }] : [];
        return send(200, { action: body.action, blockers, suggestions: [] });
      }
      if (req.method === 'POST' && path === '/requests/import') {
        const m = /^https:\/\/github\.com\/([^/]+\/[^/]+)(?:\/tree\/(.+))?$/.exec(body.url);
        if (!m) return send(200, { ok: false, problems: [{ message: 'not a GitHub URL' }] });
        return send(200, {
          ok: true,
          source: { repoUrl: `https://github.com/${m[1]}.git`, baseCommit: 'a'.repeat(40), ref: m[2] ?? 'main', sizeKb: 10 },
        });
      }
      if (req.method === 'GET' && path.startsWith('/requests/paid-by/')) {
        const payer = path.split('/').pop();
        return send(200, { payer, count: (opts.paidBy ?? []).length, orders: opts.paidBy ?? [] });
      }
      if (!token) return send(401, { error: 'request_token_required' });

      if (req.method === 'POST' && path === '/requests/quote') {
        const id = crypto.randomUUID();
        orders.set(id, { token, action: body.action, input: body.input, status: 'quoted', polls: 0 });
        return send(201, { created: true, order: { id, status: 'quoted' } });
      }
      const m = /^\/requests\/([0-9a-f-]{36})(\/submit)?$/.exec(path);
      const order = m ? orders.get(m[1]!) : undefined;
      if (!m || !order || order.token !== token) return send(404, { error: 'not_found' });
      const id = m[1]!;

      if (req.method === 'POST' && m[2]) {
        const header = req.headers['payment-signature'];
        if (!header) {
          const resourceUrl = `${base}/requests/${id}`;
          const challenge: Challenge = {
            x402Version: 2,
            resource: { url: resourceUrl, description: `One ${order.action} request`, mimeType: 'application/json' },
            accepts: [
              { scheme: 'exact', network: 'eip155:1', asset: IMD_TOKEN, amount: PRICE, payTo: PAY_TO, maxTimeoutSeconds: 300, extra: { assetTransferMethod: 'permit2' } },
            ],
            quote: {
              id,
              action: order.action,
              expiresAt: Math.floor(Date.now() / 1000) + 600,
              quoteHash: 'c'.repeat(64),
              payment: { network: 'eip155:1', asset: IMD_TOKEN, amount: PRICE, payTo: PAY_TO, decimals: 18, scheme: 'exact' },
            },
            resourceUrl,
            requesterScopeHash: 'd'.repeat(64),
            input: order.input,
          };
          opts.tamperChallenge?.(challenge);
          order.challenge = challenge;
          return send(402, challenge);
        }
        const ch = order.challenge;
        if (!ch) return send(409, { error: 'order_not_payable' });
        const payment = JSON.parse(Buffer.from(String(header), 'base64').toString('utf8')) as PaymentPayload;
        try {
          checkShape(payment);
        } catch (e) {
          return send(400, { error: 'invalid_payment_shape', detail: (e as Error).message });
        }
        const auth = payment.payload.permit2Authorization;
        if (JSON.stringify(payment.accepted) !== JSON.stringify(ch.accepts[0])) return send(400, { error: 'payment_terms_mismatch' });
        if (auth.spender !== X402_PERMIT2_PROXY || auth.permitted.amount !== PRICE || auth.witness.to.toLowerCase() !== PAY_TO) {
          return send(400, { error: 'payment_terms_mismatch' });
        }
        if (Number(auth.deadline) > ch.quote.expiresAt - 5) return send(400, { error: 'invalid_payment_window' });
        const payer = recover(permit2TypedData(auth), payment.payload.signature);
        if (payer !== auth.from) return send(402, { error: 'payment_rejected', reason: 'invalid_signature' });
        const approver = recover(quoteApprovalTypedData(ch, payment), body?.quoteSignature ?? '');
        if (approver !== payer) return send(400, { error: 'invalid_quote_approval' });
        payments.push({ payer, payment });
        order.status = 'payment_pending';
        const outcome = { status: order.status, order: { id }, payment: null, admission: null };
        opts.tamperSubmit?.(outcome);
        return send(202, outcome);
      }
      if (req.method === 'GET' && !m[2]) {
        order.polls++;
        if (order.status === 'payment_pending') order.status = 'admission_pending';
        else if (order.status === 'admission_pending') order.status = 'admitted';
        const admitted = order.status === 'admitted';
        return send(200, {
          status: order.status,
          order: { id, status: admitted ? 'paid' : order.status },
          payment: admitted ? { status: 'confirmed', paid: true, transactionHash: `0x${'e'.repeat(64)}` } : null,
          admission: admitted
            ? { action: order.action, result: { kind: 'job', jobId: 'job-123', launch: false, statusUrl: '/jobs/job-123', resultUrl: '/jobs/job-123/result' } }
            : null,
        });
      }
      return send(404, { error: 'not_found' });
    } catch (e) {
      return send(500, { error: 'mock_error', detail: (e as Error).message });
    }
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    requests,
    payments,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
