import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ROOT } from './helpers/run-action.js';

describe('example workflow summaries', () => {
  for (const name of ['imd-audit.yml', 'imd-review-on-label.yml', 'imd-research-on-label.yml']) {
    it(`${name} prints a hostile status literally`, () => {
      const workflow = readFileSync(join(ROOT, 'examples/workflows', name), 'utf8');
      const summary = workflow.split('      - name: Summary\n')[1];
      assert.ok(summary, 'Summary step is present');
      const block = summary.split('        run: |\n')[1];
      assert.ok(block, 'Summary shell block is present');
      const script = block.split('\n      - name:')[0]!.split('\n')
        .filter((line) => line.startsWith('          ')).map((line) => line.slice(10)).join('\n');
      assert.ok(script, 'Summary shell script is present');
      assert.ok(!script.includes('${{'), 'outputs must not be inserted into shell source');
      const dir = mkdtempSync(join(tmpdir(), 'imd-summary-test-'));
      const marker = join(dir, 'pwned');
      const output = join(dir, 'summary');
      const hostile = `$(touch ${marker})`;
      execFileSync('bash', ['-e', '-c', script], {
        env: {
          PATH: process.env.PATH ?? '',
          GITHUB_STEP_SUMMARY: output,
          IMD_ORDER_ID: 'order-123',
          IMD_STATUS: hostile,
          IMD_JOB_URL: 'https://explorer.imd.fun/jobs/job-123',
        },
      });
      assert.equal(existsSync(marker), false);
      assert.ok(readFileSync(output, 'utf8').includes(hostile));
    });
  }
});
