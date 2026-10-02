// End-to-end tests of the committed bundle against a local mock server.
// Only throwaway keys are used; nothing reaches mainnet or api.imd.fun.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startMock, type Mock, type MockOptions } from './helpers/mock-server.js';
import { runAction, throwawayKey, type RunResult } from './helpers/run-action.js';
import { createWallet } from '../src/wallet.js';

const INPUT = JSON.stringify({ objective: 'Audit the vault.', template: 'audit' });

const forkPr = {
  action: 'labeled',
  pull_request: {
    number: 7,
    head: { ref: 'evil', sha: 'f'.repeat(40), repo: { full_name: 'attacker/repo', fork: true } },
    base: { ref: 'main', repo: { full_name: 'owner/repo', fork: false } },
  },
  repository: { full_name: 'owner/repo' },
};

const sameRepoPr = {
  action: 'labeled',
  pull_request: {
    number: 8,
    head: { ref: 'feature', sha: 'b'.repeat(40), repo: { full_name: 'owner/repo', fork: false } },
    base: { ref: 'main', repo: { full_name: 'owner/repo', fork: false } },
  },
  repository: { full_name: 'owner/repo' },
};

function withMock(opts: MockOptions, fn: (mock: () => Mock) => void): void {
  let mock: Mock;
  before(async () => {
    mock = await startMock(opts);
  });
  after(async () => mock.close());
  fn(() => mock);
}

function assertKeyNotLeaked(result: RunResult, key: string): void {
  const all = `${result.stdout}${result.stderr}${JSON.stringify(result.outputs)}`;
  assert.ok(!all.toLowerCase().includes(key.slice(2).toLowerCase()), 'private key appeared in output');
}

const paymentAttempts = (mock: Mock) => mock.requests.filter((r) => r.headers['payment-signature']);

describe('refuses unsafe events before doing anything', () => {
  withMock({}, (mock) => {
    it('exits without signing on a fork pull request', async () => {
      const key = throwawayKey();
      const result = await runAction({
        inputs: { action: 'job.open', input: INPUT, 'private-key': key, 'dry-run': 'false', 'api-url': mock().url },
        event: { name: 'pull_request', payload: forkPr },
      });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /::error::refusing to run for a pull request from a fork/);
      assert.equal(mock().requests.length, 0, 'no request may reach the API');
      assert.equal(mock().payments.length, 0);
      assertKeyNotLeaked(result, key);
    });

    it('exits on pull_request_target even for a same-repo pull request', async () => {
      const result = await runAction({
        inputs: { action: 'job.open', input: INPUT, 'private-key': throwawayKey(), 'dry-run': 'false', 'api-url': mock().url },
        event: { name: 'pull_request_target', payload: sameRepoPr },
      });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /pull_request_target/);
      assert.equal(mock().requests.length, 0);
    });

    it('refuses pull request events with missing provenance', async () => {
      for (const payload of [{}, { pull_request: null }]) {
        const key = throwawayKey();
        const result = await runAction({
          inputs: { action: 'job.open', input: INPUT, 'private-key': key, 'dry-run': 'false', 'api-url': mock().url },
          event: { name: 'pull_request', payload },
        });
        assert.equal(result.code, 1);
        assert.match(result.stdout, /repository metadata is missing/);
        assertKeyNotLeaked(result, key);
      }
      const noFile = await runAction({
        inputs: { action: 'job.open', input: INPUT, 'private-key': throwawayKey(), 'dry-run': 'false', 'api-url': mock().url },
        env: { GITHUB_EVENT_NAME: 'pull_request' },
      });
      assert.equal(noFile.code, 1);
      assert.equal(mock().requests.length, 0);
    });
  });
});

describe('dry run (the default)', () => {
  withMock({}, (mock) => {
    it('quotes and verifies but produces no signature', async () => {
      const key = throwawayKey();
      const result = await runAction({
        inputs: { action: 'job.open', input: INPUT, 'private-key': key, 'api-url': mock().url },
      });
      assert.equal(result.code, 0, result.stdout);
      assert.equal(result.outputs.status, 'dry-run');
      assert.match(result.outputs['order-id'] ?? '', /^[0-9a-f-]{36}$/);
      assert.equal(result.outputs['job-id'], '');
      assert.equal(paymentAttempts(mock()).length, 0, 'no PAYMENT-SIGNATURE may be sent');
      assert.equal(mock().payments.length, 0);
      const submits = mock().requests.filter((r) => r.path.endsWith('/submit'));
      assert.equal(submits.length, 1, 'only the free challenge request');
      assert.equal(submits[0]!.body, undefined, 'challenge request has no body (no quoteSignature)');
      assert.match(result.stdout, /Experimental, commissioned as a test of the IMD swarm/);
      assertKeyNotLeaked(result, key);
    });

    it('runs without any key at all', async () => {
      const before = mock().requests.length;
      const result = await runAction({ inputs: { action: 'job.open', input: INPUT, 'api-url': mock().url } });
      assert.equal(result.code, 0, result.stdout);
      assert.equal(result.outputs.status, 'dry-run');
      assert.equal(mock().requests.slice(before).filter((r) => r.headers['payment-signature']).length, 0);
    });
  });
});

describe('live payment against the mock', () => {
  withMock({ noisyChecks: 2 }, (mock) => {
    it('signs a valid payment, waits for admission and sets outputs', async () => {
      const key = throwawayKey();
      const result = await runAction({
        inputs: {
          action: 'job.open',
          input: INPUT,
          'private-key': key,
          'dry-run': 'false',
          wait: 'true',
          'poll-interval': '0.05',
          'api-url': mock().url,
        },
      });
      assert.equal(result.code, 0, result.stdout);
      assert.match(result.stdout, /Check passed on attempt 3/);
      assert.equal(mock().payments.length, 1);
      assert.equal(mock().payments[0]!.payer, createWallet(key).address);
      assert.deepEqual(result.outputs, {
        'order-id': result.outputs['order-id'],
        status: 'admitted',
        'job-id': 'job-123',
        'job-url': 'https://explorer.imd.fun/jobs/job-123',
      });
      // The key is sent nowhere, in no header and no body.
      const wire = JSON.stringify(mock().requests).toLowerCase();
      assert.ok(!wire.includes(key.slice(2).toLowerCase()));
      assertKeyNotLeaked(result, key);
    });
  });

  withMock({}, (mock) => {
    it('imports the current repository into repoUrl and baseCommit', async () => {
      const result = await runAction({
        inputs: { action: 'job.open', input: INPUT, 'import-repo': 'true', 'api-url': mock().url },
        env: { GITHUB_REPOSITORY: 'owner/repo', GITHUB_REF: 'refs/heads/main', GITHUB_SHA: 'a'.repeat(40) },
      });
      assert.equal(result.code, 0, result.stdout);
      const imp = mock().requests.find((r) => r.path === '/requests/import');
      assert.deepEqual(imp?.body, { url: 'https://github.com/owner/repo/tree/main', kind: 'code' });
      const quote = mock().requests.find((r) => r.path === '/requests/quote');
      assert.equal(quote?.body.input.repoUrl, 'https://github.com/owner/repo.git');
      assert.equal(quote?.body.input.baseCommit, 'a'.repeat(40));
    });
  });

  withMock({}, (mock) => {
    it('refuses a GitHub rerun before creating another order or signing', async () => {
      const key = throwawayKey();
      const inputs = { action: 'job.open', input: INPUT, 'private-key': key, 'dry-run': 'false', 'api-url': mock().url };
      const context = { GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: '1234', GITHUB_JOB: 'audit', GITHUB_SHA: 'a'.repeat(40) };
      const first = await runAction({ inputs, env: { ...context, GITHUB_RUN_ATTEMPT: '1' } });
      assert.equal(first.code, 0, first.stdout);
      const count = mock().requests.length;
      const second = await runAction({ inputs, env: { ...context, GITHUB_RUN_ATTEMPT: '2' } });
      assert.equal(second.code, 1);
      assert.match(second.stdout, /refusing to pay on a GitHub job rerun/);
      assert.equal(mock().requests.length, count);
      assert.equal(mock().payments.length, 1);
      assertKeyNotLeaked(second, key);
    });
  });

  withMock({ ledgerReadBarrier: 3 }, (mock) => {
    it('uses an atomic wallet ledger across concurrent action processes', async () => {
      const key = throwawayKey();
      const inputs = { action: 'job.open', input: INPUT, 'private-key': key, 'dry-run': 'false', 'api-url': mock().url, 'max-imd-per-day': '1' };
      const results = await Promise.all([1, 2, 3].map((n) => runAction({
        inputs,
        env: { GITHUB_REPOSITORY: 'owner/repo', GITHUB_RUN_ID: String(n), GITHUB_JOB: 'audit', GITHUB_RUN_ATTEMPT: '1' },
      })));
      assert.equal(results.filter((r) => r.code === 0).length, 2, results.map((r) => r.stdout).join('\n'));
      assert.equal(results.filter((r) => r.code === 1).length, 1);
      assert.equal(mock().payments.length, 2);
      assert.equal(paymentAttempts(mock()).length, 2);
      for (const result of results) assertKeyNotLeaked(result, key);
    });
  });

  withMock({ tamperSubmit: (outcome) => { outcome.status = '$(touch /tmp/imd-summary-pwned)'; } }, (mock) => {
    it('rejects a malformed API status instead of exporting it', async () => {
      const result = await runAction({
        inputs: { action: 'job.open', input: INPUT, 'private-key': throwawayKey(), 'dry-run': 'false', 'api-url': mock().url },
      });
      assert.equal(result.code, 1);
      assert.match(result.stdout, /invalid order status/);
      assert.equal(result.outputs.status, undefined);
      assert.equal(mock().payments.length, 1);
    });
  });
});

describe('refuses to pay', () => {
  const cases: { name: string; opts: MockOptions; inputs?: Record<string, string>; message: RegExp }[] = [
    {
      name: 'a look-alike payTo address',
      opts: { tamperChallenge: (c) => (c.accepts[0]!.payTo = '0x4e0fa57bde000000000000000000000f41adbc') },
      message: /payTo differs from the quote/,
    },
    {
      name: 'a payTo changed in both challenge and quote',
      opts: {
        tamperChallenge: (c) => {
          c.accepts[0]!.payTo = c.quote.payment.payTo = '0x1111111111111111111111111111111111111111';
        },
      },
      message: /payTo differs from GET \/requests\/capabilities/,
    },
    {
      name: 'a different asset',
      opts: { tamperChallenge: (c) => (c.accepts[0]!.asset = '0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b8') },
      message: /is not IMD/,
    },
    {
      name: 'more than the quoted amount',
      opts: { tamperChallenge: (c) => (c.accepts[0]!.amount = '600000000000000000') },
      message: /differs from the quoted amount/,
    },
    {
      name: 'a quote above the published price',
      opts: {
        tamperChallenge: (c) => {
          c.accepts[0]!.amount = c.quote.payment.amount = '5000000000000000000';
        },
      },
      message: /unit price differs/,
    },
    {
      name: 'above the per-request cap',
      opts: {},
      inputs: { 'max-imd': '0.4' },
      message: /above max-imd 0\.4 IMD/,
    },
    {
      name: 'capability decimals changed to make 0.5 IMD look like 0.05 IMD',
      opts: {
        tamperCapability: (p) => { p.decimals = 19; },
        tamperChallenge: (c) => { c.quote.payment.decimals = 19; },
      },
      inputs: { 'max-imd': '0.05', 'max-imd-per-day': '0.05' },
      message: /invalid IMD token decimals/,
    },
    {
      name: 'above the per-day cap',
      opts: {
        paidBy: [
          { orderId: 'old-1', status: 'admitted', createdAt: new Date().toISOString(), payment: { amount: '500000000000000000' } },
          { orderId: 'old-2', status: 'admitted', createdAt: new Date().toISOString(), payment: { amount: '500000000000000000' } },
        ],
      },
      message: /exceeds max-imd-per-day 1 IMD/,
    },
  ];

  for (const c of cases) {
    describe(c.name, () => {
      withMock(c.opts, (mock) => {
        it('fails before any signature', async () => {
          const key = throwawayKey();
          const result = await runAction({
            inputs: { action: 'job.open', input: INPUT, 'private-key': key, 'dry-run': 'false', 'api-url': mock().url, ...c.inputs },
          });
          assert.equal(result.code, 1, result.stdout);
          assert.match(result.stdout, c.message);
          assert.equal(paymentAttempts(mock()).length, 0);
          assert.equal(mock().payments.length, 0);
          assertKeyNotLeaked(result, key);
        });
      });
    });
  }
});

describe('command line', () => {
  it('--help prints usage with the experimental label', async () => {
    const result = await runAction({ inputs: {}, args: ['--help'] });
    assert.equal(result.code, 0);
    assert.match(
      result.stdout,
      /Experimental, commissioned as a test of the IMD swarm\. It may not work as described\. Read the code, start with small amounts, no warranty\./,
    );
    assert.match(result.stdout, /dry-run/);
  });

  it('rejects a non-https API URL', async () => {
    const result = await runAction({ inputs: { action: 'job.open', input: INPUT, 'api-url': 'http://api.imd.fun' } });
    assert.equal(result.code, 1);
    assert.match(result.stdout, /api-url must use https/);
  });

  it('never echoes a malformed key', async () => {
    const bad = `0x${'ab'.repeat(31)}zz`;
    const result = await runAction({ inputs: { action: 'job.open', input: INPUT, 'private-key': bad, 'dry-run': 'false' } });
    assert.equal(result.code, 1);
    assert.ok(!result.stdout.includes('abababab'));
  });
});
