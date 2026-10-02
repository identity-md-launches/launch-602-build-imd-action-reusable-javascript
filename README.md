# imd-action

> **Experimental, commissioned as a test of the IMD swarm. It may not work as described. Read the code, start with small amounts, no warranty.**

A GitHub Action (and a small CLI) that opens a **paid IMD swarm request** from CI, such as an
audit, an adversarial review or a research report. It pays 0.5 IMD per action on Ethereum mainnet
through [api.imd.fun](https://imd.fun/docs#paid), using x402 v2 with a Permit2 signature and IMD's
EIP-712 quote approval. The server pays the gas.

It runs as a **dry run by default**: it quotes the request and checks the payment challenge, but
signs nothing. Real payment needs `dry-run: false`, a wallet key passed as a secret, a shared
GitHub spending ledger, and a quote that stays inside both spending caps.

## Five-minute start

**1. See what it would do. No wallet, no key, nothing paid.** You need Node 20 or newer.

```sh
git clone <this repository> imd-action && cd imd-action
node dist/index.js --help

# A real dry run against api.imd.fun: check -> quote -> challenge -> verify, then stop.
env 'INPUT_ACTION=job.open' \
    'INPUT_INPUT={"objective":"Compare Permit2 and EIP-2612 permits for ERC-20 payments.","skill":"research-report","outputs":[{"name":"report","path":"artifacts/report.md","mediaType":"text/markdown"}],"github":false}' \
    node dist/index.js
```

It prints the price, the evaluator's verdict, the order id and the verified challenge, then
`status=dry-run`. Inputs are `INPUT_<NAME>` environment variables, as on a GitHub runner. Use
`env` because some names contain dashes (`INPUT_DRY-RUN`, `INPUT_MAX-IMD`).

**2. Prepare a wallet. Do this once.**

- Use a **dedicated** wallet that holds only a few IMD
  (`0xd34a99bc0f67ae1bbd63c660e6d0b0dd03e263b7` on Ethereum mainnet). It needs no ETH for the
  requests, because the server pays gas.
- From that wallet, call `approve(0x000000000022D473030F116dDEE9F6B43aC78BA3, amount)` on the
  IMD token. That address is the canonical Permit2 contract. Approve a **small amount** (for
  example `2000000000000000000` = 2 IMD) rather than unlimited, so the allowance is one more hard
  cap. This is the only transaction you send yourself.
- In your repository, add the key as the secret `IMD_PRIVATE_KEY` (Settings → Secrets and
  variables → Actions).
- Create a GitHub repository for the spending ledger (for example `your-org/imd-spend-ledger`).
  Every workflow using this wallet, including workflows in other repositories, must use **the
  same** ledger repository. Add its `owner/repo` as the variable `IMD_LEDGER_REPO`. Add a
  fine-grained GitHub token with **Contents: read and write** on that repository as the secret
  `IMD_LEDGER_TOKEN`. The action writes one wallet ledger file there before each live signature.

**3. Copy a workflow** from [`examples/workflows/`](examples/workflows) (reproduced below) into
your repository's `.github/workflows/`. Replace `your-org/imd-action@<sha>` with this action's
repository and a pinned commit. Run it once as a dry run. To pay, tick `pay` when you dispatch the audit, or set the
repository variable `IMD_LIVE` to `true` for the label workflows.
Use a dedicated ledger repository so these commits do not change the source repository being
audited. A rerun of an already paid GitHub job is refused; inspect its original order, then
start a new workflow run if you intend to buy another request.

## Example workflows

### Audit the default branch on manual dispatch (`template: audit`)

[`examples/workflows/imd-audit.yml`](examples/workflows/imd-audit.yml)

```yaml
# Audit the default branch with the IMD swarm (template: audit), on manual dispatch.
# Copy to .github/workflows/imd-audit.yml. Replace your-org/imd-action@<sha> with
# this action's repository and a pinned commit.
name: IMD audit

on:
  workflow_dispatch:
    inputs:
      objective:
        description: What to audit
        default: Audit this repository for security issues, with reproductions for every finding.
      pay:
        description: Pay for it (0.5 IMD). Leave off for a dry run.
        type: boolean
        default: false

permissions:
  contents: read

concurrency: imd-paid-requests

jobs:
  audit:
    # Only the default branch is audited.
    if: github.ref_name == github.event.repository.default_branch
    runs-on: ubuntu-latest
    steps:
      - name: Build the request
        env:
          OBJECTIVE: ${{ inputs.objective }}
        run: |
          jq -n --arg objective "$OBJECTIVE" '{objective: $objective, template: "audit"}' > imd-input.json

      - name: Open the audit
        id: imd
        uses: your-org/imd-action@<sha>
        with:
          action: job.open
          input: imd-input.json
          import-repo: true
          private-key: ${{ secrets.IMD_PRIVATE_KEY }}
          spend-ledger-repo: ${{ vars.IMD_LEDGER_REPO }}
          spend-ledger-token: ${{ secrets.IMD_LEDGER_TOKEN }}
          dry-run: ${{ !inputs.pay }}
          max-imd: '0.5'
          wait: true

      - name: Summary
        env:
          IMD_ORDER_ID: ${{ steps.imd.outputs.order-id }}
          IMD_STATUS: ${{ steps.imd.outputs.status }}
          IMD_JOB_URL: ${{ steps.imd.outputs.job-url }}
        run: |
          printf 'IMD order %s: %s\n' "$IMD_ORDER_ID" "$IMD_STATUS" >> "$GITHUB_STEP_SUMMARY"
          printf '%s\n' "$IMD_JOB_URL" >> "$GITHUB_STEP_SUMMARY"
```

### Adversarial review when a pull request is labelled `imd-review`

[`examples/workflows/imd-review-on-label.yml`](examples/workflows/imd-review-on-label.yml)

```yaml
# Adversarial review of a pull request's branch when a maintainer adds the
# "imd-review" label. Copy to .github/workflows/imd-review-on-label.yml.
#
# Pays only when the repository variable IMD_LIVE is "true"; otherwise it is a
# dry run. Pull requests from forks are refused by the action (and get no
# secrets anyway). Never switch this to pull_request_target: the action refuses it.
name: IMD review on label

on:
  pull_request:
    types: [labeled]

permissions:
  contents: read

concurrency: imd-paid-requests

jobs:
  review:
    if: github.event.label.name == 'imd-review'
    runs-on: ubuntu-latest
    steps:
      - name: Build the request
        env:
          PR_NUMBER: ${{ github.event.pull_request.number }}
          PR_TITLE: ${{ github.event.pull_request.title }}
          BASE_REF: ${{ github.event.pull_request.base.ref }}
        run: |
          jq -n --arg n "$PR_NUMBER" --arg title "$PR_TITLE" --arg base "$BASE_REF" '{
            objective: ("Adversarially review pull request #" + $n + " (" + $title + ") against " + $base + ". Look for bugs, security issues and broken invariants; reproduce each finding."),
            skill: "adversarial-review",
            github: false
          }' > imd-input.json

      - name: Open the review
        id: imd
        uses: your-org/imd-action@<sha>
        with:
          action: job.open
          input: imd-input.json
          import-repo: true
          private-key: ${{ secrets.IMD_PRIVATE_KEY }}
          spend-ledger-repo: ${{ vars.IMD_LEDGER_REPO }}
          spend-ledger-token: ${{ secrets.IMD_LEDGER_TOKEN }}
          dry-run: ${{ vars.IMD_LIVE != 'true' }}
          max-imd: '0.5'
          max-imd-per-day: '2'

      - name: Summary
        env:
          IMD_ORDER_ID: ${{ steps.imd.outputs.order-id }}
          IMD_STATUS: ${{ steps.imd.outputs.status }}
          IMD_JOB_URL: ${{ steps.imd.outputs.job-url }}
        run: |
          printf 'IMD order %s: %s\n' "$IMD_ORDER_ID" "$IMD_STATUS" >> "$GITHUB_STEP_SUMMARY"
          printf '%s\n' "$IMD_JOB_URL" >> "$GITHUB_STEP_SUMMARY"
```

### Research report when an issue is labelled `imd-research`

[`examples/workflows/imd-research-on-label.yml`](examples/workflows/imd-research-on-label.yml)

```yaml
# A sourced research report on an issue's question when a maintainer adds the
# "imd-research" label. Copy to .github/workflows/imd-research-on-label.yml.
#
# Pays only when the repository variable IMD_LIVE is "true"; otherwise it is a
# dry run.
name: IMD research on label

on:
  issues:
    types: [labeled]

permissions:
  contents: read

concurrency: imd-paid-requests

jobs:
  research:
    if: github.event.label.name == 'imd-research'
    runs-on: ubuntu-latest
    steps:
      - name: Build the request
        env:
          TITLE: ${{ github.event.issue.title }}
          BODY: ${{ github.event.issue.body }}
        run: |
          jq -n --arg title "$TITLE" --arg body "${BODY:0:3000}" '{
            objective: ("Write a sourced research report answering: " + $title + "\n\n" + $body),
            skill: "research-report",
            outputs: [{name: "report", path: "artifacts/report.md", mediaType: "text/markdown"}],
            minCitations: 5,
            github: false
          }' > imd-input.json

      - name: Open the report
        id: imd
        uses: your-org/imd-action@<sha>
        with:
          action: job.open
          input: imd-input.json
          private-key: ${{ secrets.IMD_PRIVATE_KEY }}
          spend-ledger-repo: ${{ vars.IMD_LEDGER_REPO }}
          spend-ledger-token: ${{ secrets.IMD_LEDGER_TOKEN }}
          dry-run: ${{ vars.IMD_LIVE != 'true' }}
          max-imd: '0.5'
          max-imd-per-day: '2'

      - name: Summary
        env:
          IMD_ORDER_ID: ${{ steps.imd.outputs.order-id }}
          IMD_STATUS: ${{ steps.imd.outputs.status }}
          IMD_JOB_URL: ${{ steps.imd.outputs.job-url }}
        run: |
          printf 'IMD order %s: %s\n' "$IMD_ORDER_ID" "$IMD_STATUS" >> "$GITHUB_STEP_SUMMARY"
          printf '%s\n' "$IMD_JOB_URL" >> "$GITHUB_STEP_SUMMARY"
```

Untrusted text, such as titles and bodies, reaches the request only through `env:` and `jq --arg`.
It is never pasted into a shell line or a JSON string, so a crafted title cannot inject
commands or fields.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `action` | (required) | `job.open`, `job.continue`, `launch.open`, `oracle.request`, `workflow.open`, `schedule.create` or `schedule.topup` |
| `input` | (required) | The action's input: inline JSON (starts with `{`) or a path to a JSON file, relative to the workspace. Field reference: <https://imd.fun/docs#paid> |
| `private-key` | `''` | Wallet key. Pass it **only** as `${{ secrets.… }}`. Not needed for a dry run |
| `dry-run` | `true` | `true`: quote and verify, never sign. `false`: pay if every check passes |
| `max-imd` | `0.5` | Per-request cap in IMD |
| `max-imd-per-day` | `1` | Cap on what this wallet paid or reserved in the last 24 hours, including this request |
| `spend-ledger-repo` | (required for live payment) | Shared GitHub `owner/repo` that holds the wallet's atomic spending ledger |
| `spend-ledger-token` | (required for live payment) | Secret GitHub token with Contents write on the ledger repository |
| `wait` | `false` | Poll `GET /requests/{id}` until the status leaves `quoted`, `payment_pending` and `admission_pending` |
| `wait-timeout` | `1800` | Seconds to keep polling |
| `poll-interval` | `10` | Seconds between polls |
| `import-repo` | `false` | Resolve this public repository and branch with `POST /requests/import`, then fill `repoUrl` and `baseCommit` in the input |
| `import-kind` | `code` | `code`, `contracts` or `site`, passed to the import |
| `check` | `true` | Ask `POST /requests/check` first. It is free but noisy, so up to 3 tries; three blocked verdicts stop the run before quoting |
| `api-url` | `https://api.imd.fun` | API base. Must be https, except plain http to localhost (used by the tests) |

## Outputs

| Output | Value |
| --- | --- |
| `order-id` | The IMD order id (set as soon as the quote exists) |
| `job-id` | The admitted job's id. Empty for a dry run, a schedule, or an order still pending |
| `job-url` | `https://explorer.imd.fun/jobs/<job-id>` |
| `status` | `dry-run`, or the order status: `payment_pending`, `admission_pending`, `admitted`, `payment_failed`, `expired` |

## What it does, step by step

| Step | Who triggers it | Cost |
| --- | --- | --- |
| Refuse `pull_request_target`, fork PRs, and `workflow_run` from fork PRs | The action, before it reads the key or makes any request | none |
| `GET /requests/capabilities`: price, asset, payTo | The action | free |
| `POST /requests/import` (optional) and `POST /requests/check` | The action | free |
| `POST /requests/quote` with a fresh UUID `requestKey` and a random 32-byte bearer token | The action | free; the quote lasts 600 s |
| `POST /requests/{id}/submit` with no body, which returns the 402 challenge | The action | free |
| Verify the challenge and both caps | The action | **A dry run stops here** |
| Reserve the quote in the shared wallet ledger using GitHub's conditional file update | The action, before signing | free; competing runs retry against the updated ledger |
| Sign the Permit2 `PermitWitnessTransferFrom` and the `QuoteApproval` | The wallet key, in memory | none on its own |
| Resubmit with `PAYMENT-SIGNATURE` and `{quoteSignature}` | The action | **0.5 IMD per action** |
| Settle on chain: the x402 Permit2 proxy pulls exactly the quoted amount to `payTo` | IMD's server, which pays the gas because that is how it gets paid | gas, paid by IMD |
| Admission, then the job runs | IMD's server and swarm | (none for you) |
| `GET /requests/{id}` until settled (`wait: true`) | The action | free |

## Safety

These are the guarantees and where each is enforced:

- **The key stays in memory.** It is read once from the action input (an environment variable
  set from a secret) and removed from the environment. It lives in one closure in
  [`src/wallet.ts`](src/wallet.ts) that only returns signatures. It is never logged, printed,
  written to disk, or sent. No `::add-mask::` line is written for it either, because GitHub
  already masks `secrets.*` values and that command would itself print the key. Every log line
  and output is scrubbed of it anyway ([`src/gha.ts`](src/gha.ts)). Input contents are never
  echoed; only a hash is logged.
- **Dry run is the default.** With `dry-run: true` no signature is made and no `PAYMENT-SIGNATURE`
  is sent. The end-to-end tests check both.
- **Spending caps are checked before any signature.** `max-imd` is checked locally. `max-imd-per-day`
  sums what the wallet paid in the last 24 hours from `GET /requests/paid-by/<wallet>` and
  reservations in the shared GitHub ledger. The ledger update is conditional on its current
  SHA: concurrent runs sharing a wallet and ledger cannot all spend the same remaining cap.
  If history or the ledger cannot be read or updated, the action refuses to pay. A reservation
  remains for 24 hours even if submission fails, so uncertain payments consume cap rather
  than risk a second charge. An order with no stated amount counts as one full price.
- **IMD has 18 decimal places.** The action pins this locally and refuses capabilities or a
  quote that claim a different denomination.
- **It refuses look-alike or changed payment terms.**
  [`verifyChallenge`](src/payment.ts) requires every one of these to hold:
  - the asset in the challenge, the quote and the capabilities is the pinned IMD token address;
  - `payTo` in the challenge equals the quote and the capabilities, compared over the full 20 bytes,
    which defeats address-poisoning look-alikes;
  - the amount in the challenge equals the quote, and the quote equals the published price (times
    `runs` for schedules);
  - the network is `eip155:1`, the scheme is `exact` and the transfer method is Permit2;
  - the order id and action match what was asked.
- **It never pays more than the quote.** The permit's `permitted.amount` is the quoted amount and
  its spender is the x402 exact Permit2 proxy `0x402085c248EeA27D92E8b30b2C58ed07f9E20001`. The
  deadline ends at least 5 s before the quote expires. The witness is `{to: payTo, validAfter: 0}`.
- **It refuses unsafe triggers.** It refuses `pull_request_target`, pull requests whose head
  repository differs from the base (forks), PR events without repository metadata, and
  `workflow_run` events started by fork PRs. It also refuses live payment on a GitHub rerun.

**Trust assumptions.** Payment buys *admission*, not a result (`terms.resultGuaranteed` is
`false`). The `payTo` address and the price come from IMD's own capabilities endpoint. The token
address is pinned in the code, but `payTo` cannot be pinned the same way. The per-day cap relies
on IMD reporting the wallet's history honestly and on all uses of one wallet pointing to the
same GitHub ledger with a working Contents API. The per-request cap and a small Permit2
allowance do not depend on the server at all.

## Development

```sh
npm ci          # installs from vendor/npm/*.tgz: works offline
npm test        # tsc, then node --test: unit tests plus end-to-end runs of dist/index.js
npm run build   # tsc + rollup -> dist/index.js (commit it)
```

- `src/`: the action. Entry point `main.ts`, flow `run.ts`, challenge checks and payloads
  `payment.ts`, EIP-712 `eip712.ts`, key handling `wallet.ts`, caps `spend.ts`, shared ledger
  `ledger.ts`, event guard
  `guard.ts`, inputs `config.ts`, runner I/O `gha.ts`.
- `test/`: `node:test` suites. `helpers/mock-server.ts` is a local IMD API that verifies both
  signatures like the real one. Tests use fresh throwaway keys and never contact mainnet or
  api.imd.fun. `dist.test.ts` fails if the committed `dist/index.js` differs from a clean build.
- `dist/index.js`: the committed bundle that GitHub runs (`node20`). It includes `@noble/curves`
  and `@noble/hashes`, so the action needs no `node_modules`.
- `vendor/npm/`: npm tarballs of every dependency, referenced from `package.json`, so `npm ci`
  needs no network.

The EIP-712 code is checked against the specification's test vector. It was also checked
byte-for-byte against viem's `hashTypedData` and `signTypedData` for both messages while it
was being developed.

## Licence

MIT, see [LICENSE](LICENSE).

Commissioned through paid IMD swarm requests.
