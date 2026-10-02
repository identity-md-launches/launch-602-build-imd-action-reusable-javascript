// The paid-request flow: capabilities -> (import) -> check -> quote ->
// challenge -> verify + caps -> [stop here on dry run] -> sign -> submit -> poll.
import { randomUUID } from 'node:crypto';
import { ApiError, ImdApi } from './api.js';
import { canonicalJson, sha256Hex } from './canonical.js';
import { readConfig, type Config } from './config.js';
import { log, setOutput } from './gha.js';
import { readEventPayload, refusalReason } from './guard.js';
import { EXPERIMENTAL } from './help.js';
import {
  buildAuthorization,
  buildPayment,
  capabilityFor,
  encodePaymentHeader,
  formatUnits,
  parseUnits,
  permit2TypedData,
  permitDeadline,
  quoteApprovalTypedData,
  randomNonce,
  verifyChallenge,
  type Challenge,
} from './payment.js';
import { checkDailyCap, checkPerRequestCap } from './spend.js';
import { createWallet, type Wallet } from './wallet.js';

export const EXPLORER_JOB_URL = 'https://explorer.imd.fun/jobs/';
const PENDING = new Set(['quoted', 'payment_pending', 'admission_pending']);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The public GitHub repository and branch this run is for. */
export function repoContext(payload: any): { url: string; expectedSha?: string } {
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const repo = process.env.GITHUB_REPOSITORY;
  if (server !== 'https://github.com' || !repo) throw new Error('import-repo needs a github.com repository (GITHUB_REPOSITORY)');
  const pr = payload?.pull_request;
  let branch: string | undefined;
  let expectedSha: string | undefined;
  if (pr?.head?.ref) {
    branch = pr.head.ref;
    expectedSha = pr.head.sha;
  } else if (process.env.GITHUB_REF?.startsWith('refs/heads/')) {
    branch = process.env.GITHUB_REF.slice('refs/heads/'.length);
    expectedSha = process.env.GITHUB_SHA;
  }
  return { url: `https://github.com/${repo}${branch ? `/tree/${branch}` : ''}`, expectedSha };
}

async function importRepo(api: ImdApi, cfg: Config, payload: any): Promise<void> {
  const ctx = repoContext(payload);
  const res = await api.json('POST', '/requests/import', { url: ctx.url, kind: cfg.importKind });
  if (!res?.ok || !res.source?.repoUrl || !/^[0-9a-f]{40}$/.test(res.source?.baseCommit ?? '')) {
    throw new ApiError(422, res, '/requests/import');
  }
  cfg.input.repoUrl = res.source.repoUrl;
  cfg.input.baseCommit = res.source.baseCommit;
  log.info(`Imported ${res.source.repoUrl} at ${res.source.baseCommit}`);
  if (ctx.expectedSha && ctx.expectedSha !== res.source.baseCommit) {
    log.warning(`The branch head (${res.source.baseCommit}) differs from this run's commit (${ctx.expectedSha}); using the branch head.`);
  }
}

/** POST /requests/check is noisy: try up to three times before believing a blocker. */
async function runCheck(api: ImdApi, cfg: Config): Promise<void> {
  let last: any;
  for (let attempt = 1; attempt <= 3; attempt++) {
    last = await api.json('POST', '/requests/check', { action: cfg.action, input: cfg.input });
    const blockers = Array.isArray(last?.blockers) ? last.blockers : [];
    if (blockers.length === 0) {
      log.info(`Check passed${attempt > 1 ? ` on attempt ${attempt}` : ''}.`);
      for (const s of Array.isArray(last?.suggestions) ? last.suggestions : []) {
        log.notice(`Suggestion: ${s?.code ?? ''} ${s?.detail ?? ''}`.trim());
      }
      return;
    }
    log.info(`Check attempt ${attempt}/3 reported ${blockers.length} blocker(s).`);
  }
  const lines = (last.blockers as any[]).map((b) => `  - ${b?.code ?? 'blocker'}: ${b?.detail ?? ''}`);
  throw new Error(`POST /requests/check blocked the request three times:\n${lines.join('\n')}`);
}

function admissionResult(status: any): any {
  return status?.admission?.result ?? null;
}

function setResultOutputs(status: any): string {
  const state = String(status?.status ?? 'unknown');
  const result = admissionResult(status);
  const jobId = typeof result?.jobId === 'string' ? result.jobId : '';
  setOutput('status', state);
  setOutput('job-id', jobId);
  setOutput('job-url', jobId ? `${EXPLORER_JOB_URL}${encodeURIComponent(jobId)}` : '');
  if (jobId) log.info(`Job: ${EXPLORER_JOB_URL}${encodeURIComponent(jobId)}`);
  return state;
}

async function pay(api: ImdApi, wallet: Wallet, orderId: string, challenge: Challenge): Promise<any> {
  const now = Math.floor(Date.now() / 1000);
  const auth = buildAuthorization(challenge, wallet.address, {
    nonce: randomNonce(),
    deadline: permitDeadline(challenge, now),
  });
  const payment = buildPayment(challenge, auth, wallet.signTypedData(permit2TypedData(auth)));
  const quoteSignature = wallet.signTypedData(quoteApprovalTypedData(challenge, payment));
  // Retries (inside raw) resend the same bytes, which IMD treats as one payment.
  const res = await api.raw('POST', `/requests/${orderId}/submit`, {
    headers: { 'PAYMENT-SIGNATURE': encodePaymentHeader(payment) },
    body: { quoteSignature },
  });
  if (res.status !== 200 && res.status !== 202) throw new ApiError(res.status, res.body, `/requests/${orderId}/submit`);
  return res.body;
}

async function poll(api: ImdApi, orderId: string, initial: any, cfg: Config): Promise<any> {
  let status = initial;
  const deadline = Date.now() + cfg.waitTimeoutSeconds * 1000;
  while (PENDING.has(status?.status)) {
    if (Date.now() >= deadline) {
      log.warning(`Stopped waiting after ${cfg.waitTimeoutSeconds}s; order is still ${status?.status}.`);
      break;
    }
    await sleep(cfg.pollIntervalSeconds * 1000);
    status = await api.json('GET', `/requests/${orderId}`);
    log.info(`Order status: ${status?.status}`);
  }
  return status;
}

export async function run(): Promise<void> {
  log.info(EXPERIMENTAL);

  // The guard runs before the key is even read.
  const payload = readEventPayload();
  const reason = refusalReason(process.env.GITHUB_EVENT_NAME, payload);
  if (reason) throw new Error(reason);

  const cfg = readConfig();
  const wallet = cfg.privateKey ? createWallet(cfg.privateKey) : null;
  cfg.privateKey = '';
  if (wallet) log.info(`Wallet: ${wallet.address}`);
  log.info(cfg.dryRun ? 'Dry run: nothing will be signed or paid.' : 'Live run: payment will be signed if every check passes.');

  const api = new ImdApi(cfg.apiUrl);
  const capability = capabilityFor(await api.json('GET', '/requests/capabilities'), cfg.action);
  const decimals = capability.payment.decimals;
  const perRequestCap = parseUnits(cfg.maxImd, decimals);
  const dailyCap = parseUnits(cfg.maxImdPerDay, decimals);
  log.info(`Price: ${formatUnits(BigInt(capability.payment.amount), decimals)} IMD per ${cfg.action}`);

  if (cfg.importRepo) await importRepo(api, cfg, payload);
  if (cfg.check) await runCheck(api, cfg);

  const quoted = await api.json('POST', '/requests/quote', {
    requestKey: randomUUID(),
    action: cfg.action,
    input: cfg.input,
  });
  const orderId: string = quoted?.order?.id;
  if (typeof orderId !== 'string' || !/^[0-9a-fA-F-]{36}$/.test(orderId)) throw new Error('quote response has no order id');
  setOutput('order-id', orderId);
  log.info(`Order ${orderId} quoted (input sha256 ${sha256Hex(canonicalJson(cfg.input)).slice(0, 16)}…).`);

  const ch = await api.raw<Challenge>('POST', `/requests/${orderId}/submit`);
  if (ch.status !== 402) throw new ApiError(ch.status, ch.body, `/requests/${orderId}/submit`);
  const challenge = ch.body;

  const amount = verifyChallenge(challenge, {
    orderId,
    action: cfg.action,
    capability,
    nowSeconds: Math.floor(Date.now() / 1000),
  });
  checkPerRequestCap(amount, perRequestCap, decimals);
  if (wallet) {
    const spent = await checkDailyCap(api, { address: wallet.address, amount, cap: dailyCap, decimals, orderId });
    log.info(`Spent by this wallet in the last 24h: ${formatUnits(spent, decimals)} IMD (cap ${cfg.maxImdPerDay}).`);
  } else {
    log.info('No private-key given: skipping the per-day check (it needs the wallet address).');
  }
  log.info(
    `Challenge verified: ${formatUnits(amount, decimals)} IMD to ${challenge.quote.payment.payTo}, ` +
      `quote expires ${new Date(challenge.quote.expiresAt * 1000).toISOString()}.`,
  );

  if (cfg.dryRun) {
    log.notice(`Dry run complete. Order ${orderId} would cost ${formatUnits(amount, decimals)} IMD. Set dry-run: false to pay.`);
    setOutput('status', 'dry-run');
    setOutput('job-id', '');
    setOutput('job-url', '');
    return;
  }
  if (!wallet) throw new Error('private-key is required when dry-run is false');

  let status = await pay(api, wallet, orderId, challenge);
  log.info(`Submitted payment; order status: ${status?.status}`);
  if (cfg.wait) status = await poll(api, orderId, status, cfg);

  const state = setResultOutputs(status);
  const result = admissionResult(status);
  if (result?.kind === 'refused') {
    throw new Error(`admission refused: ${JSON.stringify(result.problems ?? []).slice(0, 1000)}`);
  }
  if (state === 'payment_failed' || state === 'expired') throw new Error(`order ended as ${state}`);
}
