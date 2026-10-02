// The committed dist/index.js must be exactly what a clean build produces.
// `npm test` compiles with tsc first, so build/src is fresh here.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { it } from 'node:test';
import { rollup } from 'rollup';
import { ROOT } from './helpers/run-action.js';

it('dist/index.js matches a clean build', async () => {
  const { default: config } = await import(join(ROOT, 'rollup.config.mjs'));
  const bundle = await rollup({ ...config, input: join(ROOT, config.input) });
  const { output } = await bundle.generate(config.output);
  await bundle.close();
  const committed = readFileSync(join(ROOT, 'dist', 'index.js'), 'utf8');
  assert.ok(committed === output[0].code, 'dist/index.js is stale: run `npm run build` and commit the result');
});
