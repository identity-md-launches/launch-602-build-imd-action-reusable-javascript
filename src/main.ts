#!/usr/bin/env node
import { log } from './gha.js';
import { HELP } from './help.js';
import { run } from './run.js';

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  process.stdout.write(HELP);
} else {
  run().catch((err: unknown) => {
    log.error(err instanceof Error ? err.message : 'imd-action failed');
    process.exitCode = 1;
  });
}
