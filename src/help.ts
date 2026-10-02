export const EXPERIMENTAL =
  'Experimental, commissioned as a test of the IMD swarm. It may not work as described. Read the code, start with small amounts, no warranty.';

export const HELP = `imd-action — open a paid IMD swarm request from CI

${EXPERIMENTAL}

Usage
  As a GitHub Action:   uses: <owner>/imd-action@v0   (see README.md)
  From a shell:         env 'INPUT_ACTION=job.open' 'INPUT_INPUT=request.json' node dist/index.js
  Help:                 node dist/index.js --help

Inputs are read from INPUT_<NAME> environment variables, exactly as GitHub
passes them (for example INPUT_MAX-IMD). Use \`env\` to set names with dashes.

  action            job.open | job.continue | launch.open | oracle.request |
                    workflow.open | schedule.create | schedule.topup   (required)
  input             inline JSON object, or a path to a JSON file       (required)
  private-key       wallet key; pass only from a secret. Needed when dry-run is false
  dry-run           true (default): quote and verify the challenge, never sign
  max-imd           per-request cap in IMD (default 0.5)
  max-imd-per-day   cap on IMD paid by this wallet in the last 24h (default 1)
  wait              poll until the order settles (default false)
  wait-timeout      seconds to wait (default 1800)
  poll-interval     seconds between polls (default 10)
  import-repo       resolve this public repo + commit into repoUrl/baseCommit (default false)
  import-kind       code | contracts | site (default code)
  check             ask POST /requests/check first, up to 3 tries (default true)
  api-url           default https://api.imd.fun

Outputs: order-id, job-id, job-url, status (status is "dry-run" for a dry run).

Refuses to run on pull_request_target and for pull requests from forks.
Refuses to pay if the challenge's asset, payTo or amount differ from
GET /requests/capabilities or from the quote, or exceed either cap.
`;
