// Refuse to run in contexts where untrusted code or untrusted people could
// steer a run that holds the wallet key.
import { readFileSync } from 'node:fs';

export type Repo = { full_name?: string; fork?: boolean } | null | undefined;
export type Payload = {
  pull_request?: { head?: { repo?: Repo }; base?: { repo?: Repo } };
  workflow_run?: { event?: string; head_repository?: Repo; repository?: Repo };
  repository?: Repo;
};

export function readEventPayload(): Payload {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path) return {};
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Payload;
  } catch {
    // An unreadable payload under GitHub Actions is suspicious; fail closed.
    throw new Error('could not read the GitHub event payload');
  }
}

function crossRepo(head: Repo, base: Repo): boolean {
  // A deleted head repository (null) is treated as a fork.
  if (!head || !head.full_name) return true;
  // Without a base name to compare against, trust only an explicit non-fork.
  if (!base?.full_name) return head.fork !== false;
  return head.full_name.toLowerCase() !== base.full_name.toLowerCase();
}

/** Returns a reason to refuse, or null when the event is safe to run from. */
export function refusalReason(eventName: string | undefined, payload: Payload): string | null {
  if (eventName === 'pull_request_target') {
    return 'refusing to run on pull_request_target: it exposes secrets to pull requests from forks';
  }
  if (payload.pull_request && crossRepo(payload.pull_request.head?.repo, payload.pull_request.base?.repo)) {
    return 'refusing to run for a pull request from a fork';
  }
  if (payload.workflow_run && payload.workflow_run.event?.startsWith('pull_request')) {
    const base = payload.workflow_run.repository ?? payload.repository;
    if (crossRepo(payload.workflow_run.head_repository, base)) {
      return 'refusing to run from a workflow_run triggered by a pull request from a fork';
    }
  }
  return null;
}
