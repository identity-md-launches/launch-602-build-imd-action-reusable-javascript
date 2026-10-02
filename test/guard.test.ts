import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { refusalReason, type Repo } from '../src/guard.js';

const repo = (full_name: string, fork = false) => ({ full_name, fork });
const pr = (head: Repo, base: Repo = repo('owner/repo')) => ({ pull_request: { head: { repo: head }, base: { repo: base } } });

describe('refusalReason', () => {
  it('refuses pull_request_target outright', () => {
    assert.match(refusalReason('pull_request_target', pr(repo('owner/repo'))) ?? '', /pull_request_target/);
  });

  it('refuses a pull request from a fork', () => {
    assert.match(refusalReason('pull_request', pr(repo('attacker/repo', true))) ?? '', /fork/);
  });

  it('refuses a cross-repository head even without the fork flag', () => {
    assert.ok(refusalReason('pull_request', pr(repo('someone/else'))));
  });

  it('refuses when the head repository was deleted', () => {
    assert.ok(refusalReason('pull_request', pr(null)));
  });

  it('refuses when PR metadata or either repository name is missing', () => {
    assert.ok(refusalReason('pull_request', {}));
    assert.ok(refusalReason('pull_request', { pull_request: undefined }));
    assert.ok(refusalReason('pull_request', pr(repo('owner/repo'), null)));
  });

  it('refuses review events on fork pull requests', () => {
    assert.ok(refusalReason('pull_request_review', pr(repo('attacker/repo', true))));
  });

  it('refuses workflow_run triggered by a fork pull request', () => {
    const payload = {
      workflow_run: { event: 'pull_request', head_repository: repo('attacker/repo', true), repository: repo('owner/repo') },
    };
    assert.ok(refusalReason('workflow_run', payload));
  });

  it('allows same-repository pull requests, issues and manual dispatch', () => {
    assert.equal(refusalReason('pull_request', pr(repo('owner/repo'))), null);
    assert.equal(refusalReason('pull_request', pr(repo('Owner/Repo', true), repo('owner/repo', true))), null);
    assert.equal(refusalReason('issues', { repository: repo('owner/repo') }), null);
    assert.equal(refusalReason('workflow_dispatch', {}), null);
  });
});
