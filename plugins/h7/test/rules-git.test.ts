import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { secretKind } from '../scripts/rules-git.ts';
import { decide, ruleOf, type Calls } from './support.ts';

const BLOCK_FORCE = 'block:force-push-protected';
const BLOCK_HOOKS = 'block:skip-git-hooks';
const BLOCK_DIRTY = 'block:destructive-git-dirty';
const BLOCK_SECRET = 'block:secrets-commit';
const ASK_SECRET = 'ask:secrets-ambiguous';
const ASK_PUSH = 'ask:push-protected';
const BLOCK_DELETE = 'block:push-delete-protected';

function table(options: Parameters<typeof ruleOf>[1], rows: [string, string | null][]): void {
  for (const [command, expected] of rows) {
    assert.equal(ruleOf(command, options), expected, command);
  }
}

describe('force push', () => {
  it('blocks every force spelling to protected branches', () => {
    table({ branch: 'feature' }, [
      ['git push --force origin main', BLOCK_FORCE],
      ['git push -f origin master', BLOCK_FORCE],
      ['git push origin main --force', BLOCK_FORCE],
      ['git push --force-with-lease origin main', BLOCK_FORCE],
      ['git push --force-with-lease=main:abc123 origin main', BLOCK_FORCE],
      ['git push --force-if-includes origin main', BLOCK_FORCE],
      ['git push origin +main', BLOCK_FORCE],
      ['git push origin +feature:main', BLOCK_FORCE],
      ['git push origin +HEAD:refs/heads/main', BLOCK_FORCE],
      ['git push -uf origin production', BLOCK_FORCE],
      ['git push -f origin prod', BLOCK_FORCE],
      ['git push -f origin release/1.2', BLOCK_FORCE],
      ['git push -f origin refs/heads/main', BLOCK_FORCE],
      ['git push -f origin HEAD:main', BLOCK_FORCE],
      ['git push -f origin refs/heads/*:refs/heads/*', BLOCK_FORCE],
      ['git push --mirror origin', BLOCK_FORCE],
      ['git -C . push --force origin main', BLOCK_FORCE],
      ['git push -o ci.skip -f origin main', BLOCK_FORCE],
      ['/usr/bin/git.exe push --force origin main', BLOCK_FORCE],
      ['sudo git push -f origin main', BLOCK_FORCE],
    ]);
  });

  it('uses the current branch when no refspec is given', () => {
    assert.equal(ruleOf('git push --force', { branch: 'main' }), BLOCK_FORCE);
    assert.equal(ruleOf('git push --force origin', { branch: 'master' }), BLOCK_FORCE);
    assert.equal(ruleOf('git push -f origin HEAD', { branch: 'main' }), BLOCK_FORCE);
    assert.equal(ruleOf('git push --force', { branch: 'feature' }), null);
    assert.equal(ruleOf('git push --force', { branch: null }), null);
    assert.equal(ruleOf('git push -f origin HEAD', { branch: null }), null);
  });

  it('uses the remote HEAD branch when resolvable', () => {
    assert.equal(ruleOf('git push -f origin trunk', { defaultBranch: 'trunk' }), BLOCK_FORCE);
    assert.equal(ruleOf('git push -f origin trunk', { defaultBranch: null }), null);
    assert.equal(ruleOf('git push -f origin develop', { defaultBranch: 'trunk' }), null);
  });

  it('allows force pushes to other branches, tags and refs', () => {
    table({ branch: 'feature' }, [
      ['git push --force origin feature', null],
      ['git push -f origin HEAD:feature/x', null],
      ['git push --force-with-lease origin my-main', null],
      ['git push origin +feature', null],
      ['git push -f origin v1.0', null],
      ['git push -f origin refs/tags/v1', null],
      ['git push -f --tags', null],
      ['git push -f --delete origin feature', null],
      ['git push origin feature', null],
      ['git push', null],
    ]);
  });

  it('passes the push remote to default branch resolution once', () => {
    const calls: Calls = { list: [] };
    ruleOf('git push -f upstream trunk other', { calls });
    assert.equal(calls.list.filter((c) => c === 'defaultBranch').length, 2);
  });
});

describe('push to protected branches (ask)', () => {
  it('asks for non-force pushes to protected branches', () => {
    table({ branch: 'feature' }, [
      ['git push origin main', ASK_PUSH],
      ['git push origin HEAD:master', ASK_PUSH],
      ['git push origin release/2024', ASK_PUSH],
      ['git push --all origin', ASK_PUSH],
      ['git push origin feature main', ASK_PUSH],
      ['git push origin refs/heads/production', ASK_PUSH],
    ]);
    assert.equal(ruleOf('git push', { branch: 'main' }), ASK_PUSH);
    assert.equal(ruleOf('git push origin', { branch: 'master' }), ASK_PUSH);
    assert.equal(ruleOf('git push origin trunk', { defaultBranch: 'trunk' }), ASK_PUSH);
  });

  it('blocks deleting protected branches', () => {
    table({ branch: 'feature' }, [
      ['git push origin --delete main', BLOCK_DELETE],
      ['git push origin -d release/1', BLOCK_DELETE],
      ['git push origin :main', BLOCK_DELETE],
      ['git push origin :refs/heads/master', BLOCK_DELETE],
      ['git push origin +:main', BLOCK_FORCE],
      ['git push -f origin --delete main', BLOCK_FORCE],
      ['git push origin --delete feature', null],
      ['git push origin :feature', null],
      ['git push --delete origin v1', null],
    ]);
  });

  it('ignores tags and non-branch refs', () => {
    table({ branch: 'main' }, [
      ['git push --tags', null],
      ['git push origin --tags', null],
      ['git push origin refs/tags/v1', null],
      ['git push origin refs/notes/commits', null],
      ['git push origin :refs/tags/v1', null],
    ]);
  });

  it('prefers blocking over asking and reports the first ask otherwise', () => {
    assert.equal(ruleOf('git push origin main && git push -f origin master', { branch: 'f' }), BLOCK_FORCE);
    const d = decide('git push origin main release/1', { branch: 'f' });
    assert.match(d?.reason ?? '', /"main"/);
  });
});

describe('skipping git hooks', () => {
  it('blocks --no-verify, -n on commit, hooksPath overrides and env switches', () => {
    table({}, [
      ['git commit -m x --no-verify', BLOCK_HOOKS],
      ['git push --no-verify', BLOCK_HOOKS],
      ['git merge --no-verify x', BLOCK_HOOKS],
      ['git commit -n -m x', BLOCK_HOOKS],
      ['git commit -anm x', BLOCK_HOOKS],
      ['git commit -m x -n', BLOCK_HOOKS],
      ['git -c core.hooksPath=/dev/null commit -m x', BLOCK_HOOKS],
      ['git -c core.hookspath=../outside commit', BLOCK_HOOKS],
      ['git -c core.hooksPath= push', 'ask:skip-git-hooks'],
      ['git -c core.hooksPath=.husky commit -m x', null],
      ['HUSKY=0 git commit -m x', BLOCK_HOOKS],
      ['SKIP=eslint git commit -m x', BLOCK_HOOKS],
      ['env HUSKY=0 git commit -m x', BLOCK_HOOKS],
      ['export HUSKY=0 && git commit -m x', BLOCK_HOOKS],
      ['HUSKY=0; git push', BLOCK_HOOKS],
      ['$env:HUSKY = "0"; git commit -m x', BLOCK_HOOKS],
    ]);
  });

  it('allows look-alikes', () => {
    table({}, [
      ['git commit -m "--no-verify"', null],
      ['git commit -m "x" -- -n', null],
      ['git commit -m x', null],
      ['git commit -am "fix: n"', null],
      ['git commit -mn', null],
      ['git push -n origin feature', null],
      ['git status -n', null],
      ['git -c user.name=x commit -m y', null],
      ['HUSKY=1 git commit -m x', null],
      ['SKIP= git commit -m x', null],
      ['HUSKY=0 git status', null],
      ['SKIP=x git log', null],
      ['HUSKY=0 npm test', null],
      ['git commit -S -m x', null],
      ['git commit -F msg.txt', null],
    ]);
  });

  it('does not let a quoted message hide or fake flags', () => {
    assert.equal(ruleOf('git commit -m "a b" --no-verify', {}), BLOCK_HOOKS);
    assert.equal(ruleOf("git commit -m 'run git push --force origin main'", {}), null);
  });

  it('blocks flags passed through nested shells and substitutions', () => {
    assert.equal(ruleOf('bash -c "git commit -m x --no-verify"', {}), BLOCK_HOOKS);
    assert.equal(ruleOf('echo $(git commit -n -m x)', {}), BLOCK_HOOKS);
  });
});

describe('destructive git commands with a dirty worktree', () => {
  const dirty = { dirty: true };
  const clean = { dirty: false };
  const cases = [
    'git reset --hard',
    'git reset --hard HEAD~1',
    'git checkout -- .',
    'git checkout -- src/a.ts',
    'git checkout HEAD -- src/a.ts',
    'git checkout .',
    'git checkout main .',
    'git checkout -f',
    'git checkout --force main',
    'git switch --discard-changes main',
    'git switch -f main',
    'git switch --force main',
    'git restore .',
    'git restore src/a.ts',
    'git restore --worktree src/a.ts',
    'git restore --staged --worktree a',
    'git restore -SW a',
    'git restore -s HEAD~1 a',
    'git -C sub reset --hard',
  ];

  it('blocks them when dirty and allows them when clean', () => {
    for (const command of cases) {
      assert.equal(ruleOf(command, dirty), BLOCK_DIRTY, command);
      assert.equal(ruleOf(command, clean), null, command);
    }
  });

  it('allows safe variants regardless of state', () => {
    for (const command of [
      'git reset --soft HEAD~1',
      'git reset HEAD file',
      'git reset',
      'git clean -n',
      'git clean -fn',
      'git clean --dry-run -f',
      'git clean',
      'git checkout main',
      'git checkout -b feature',
      'git checkout -b feature origin/main',
      'git checkout -B feature',
      'git switch main',
      'git switch -c x',
      'git restore --staged a',
      'git restore -S a',
      'git stash',
      'git stash push -u',
      'git stash pop',
      'git stash list',
      'git status',
      'git',
    ]) {
      assert.equal(ruleOf(command, dirty), null, command);
    }
  });

  it('does not query git status for harmless commands', () => {
    const calls: Calls = { list: [] };
    ruleOf('git status && git log && git reset --soft HEAD', { calls, dirty: true });
    assert.ok(!calls.list.includes('trackedDirty'));
  });

  it('explains how to proceed', () => {
    const d = decide('git reset --hard', dirty);
    assert.match(d?.reason ?? '', /git reset --hard would destroy uncommitted changes/);
    assert.match(d?.reason ?? '', /git stash push -u/);
  });
});

describe('secrets', () => {
  it('classifies file names', () => {
    for (const name of ['.env', '.env.local', '.env.production', 'config/.env', 'a\\b\\.env', 'server.pem', 'k.KEY', 'id_rsa', 'id_ecdsa', 'id_dsa', 'id_ed25519', 'x.p12', 'x.pfx', 'x.jks', 'x.keystore', '.netrc', '.pgpass', '.npmrc', 'prod.tfvars', '.env.development', '.env.test', 'credentials.json', 'secrets.json', 'secrets.yaml', 'secrets.yml', 'secrets.prod.yaml', 'dir/secrets.prod.json']) {
      assert.notEqual(secretKind(name), null, name);
    }
    for (const name of ['.env.example', '.env.sample', '.env.template', '.env.local.example', 'id_rsa.pub', 'id_ed25519.pub', 'id_rsa.bak', 'secrets.ts', 'environment.ts', 'env.ts', 'secrets.md', 'secrets.json.md', 'mysecrets.json', 'credentials.jsonc', 'monkey.ts', 'README.md', '.envrc', '.environment']) {
      assert.equal(secretKind(name), null, name);
    }
  });

  it('property: file names without secret-like parts are never flagged', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{1,8}\.(ts|md|json|txt)$/).filter((n) => !/^(credentials|secrets)\.json$/.test(n)), (name) => {
        assert.equal(secretKind(name), null);
      }),
    );
  });

  it('blocks committing staged secrets, but not deletions or examples', () => {
    assert.equal(ruleOf('git commit -m x', { staged: ['src/a.ts', '.env'] }), BLOCK_SECRET);
    assert.equal(ruleOf('git commit -m x', { staged: ['src/a.ts', '.env.example'] }), null);
    assert.equal(ruleOf('git commit -m x', { staged: [] }), null);
    assert.match(decide('git commit -m x', { staged: ['deploy/id_rsa'] })?.reason ?? '', /SSH private key/);
  });

  it('checks -a files and explicit pathspecs on commit', () => {
    assert.equal(ruleOf('git commit -am x', { modified: ['k.pem'] }), ASK_SECRET);
    assert.equal(ruleOf('git commit -am x', { modified: ['k.key'] }), BLOCK_SECRET);
    assert.equal(ruleOf('git commit -m x', { modified: ['k.pem'] }), null);
    assert.equal(ruleOf('git commit --all -m x', { modified: ['k.key'] }), BLOCK_SECRET);
    assert.equal(ruleOf('git commit -m x .env', {}), BLOCK_SECRET);
    assert.equal(ruleOf('git commit -m x -- credentials.json', {}), BLOCK_SECRET);
  });

  it('checks explicit paths on add, even when ignored or gitignored-looking', () => {
    assert.equal(ruleOf('git add .env', {}), BLOCK_SECRET);
    assert.equal(ruleOf('git add -f .env.local', {}), BLOCK_SECRET);
    assert.equal(ruleOf('git add src/a.ts config/secrets.yaml', {}), BLOCK_SECRET);
    assert.equal(ruleOf('git add *.pem', { untracked: ['k.pem'] }), ASK_SECRET);
    assert.equal(ruleOf('git add -- id_rsa', {}), BLOCK_SECRET);
    assert.equal(ruleOf('git add src/a.ts .env.example', {}), null);
  });

  it('expands broad adds to untracked and modified files', () => {
    assert.equal(ruleOf('git add .', { untracked: ['.env'] }), BLOCK_SECRET);
    assert.equal(ruleOf('git add -A', { modified: ['a/key.key'] }), BLOCK_SECRET);
    assert.equal(ruleOf('git add --all', { untracked: ['x/credentials.json'] }), BLOCK_SECRET);
    assert.equal(ruleOf('git add *', { untracked: ['.env'] }), BLOCK_SECRET);
    assert.equal(ruleOf('git add :/', { untracked: ['.env'] }), BLOCK_SECRET);
    assert.equal(ruleOf('git add -u', { modified: ['.env'] }), BLOCK_SECRET);
    assert.equal(ruleOf('git add -u', { untracked: ['.env'] }), null);
    assert.equal(ruleOf('git add .', { untracked: ['a.ts'], modified: ['b.ts'] }), null);
  });

  it('expands directory pathspecs but not unrelated directories', () => {
    assert.equal(ruleOf('git add config', { untracked: ['config/.env'] }), BLOCK_SECRET);
    assert.equal(ruleOf('git add ./config/', { untracked: ['config/.env'] }), BLOCK_SECRET);
    assert.equal(ruleOf('git add config/.env', { untracked: ['config/.env'] }), BLOCK_SECRET);
    assert.equal(ruleOf('git add src', { untracked: ['config/.env'] }), null);
    assert.equal(ruleOf('git add conf', { untracked: ['config/.env'] }), null);
  });

  it('does not query git for unrelated subcommands', () => {
    const calls: Calls = { list: [] };
    ruleOf('git status', { calls });
    assert.deepEqual(calls.list, []);
  });
});

describe('parseGitCall global options', () => {
  it('skips global options before the subcommand', () => {
    assert.equal(ruleOf('git --no-pager -p -c user.name=x --git-dir .git --work-tree . --namespace n push -f origin main', {}), BLOCK_FORCE);
    assert.equal(ruleOf('git -C /somewhere/else push -f origin main', {}), BLOCK_FORCE);
    assert.equal(ruleOf('git -C', {}), null);
    assert.equal(ruleOf('git -C "$X" push -f origin main', {}), BLOCK_FORCE);
    assert.equal(ruleOf('git -C "" push -f origin main', {}), BLOCK_FORCE);
  });

  it('applies -C to repository state lookups', () => {
    const seen: string[] = [];
    const calls: Calls = { list: seen };
    ruleOf('git -C sub reset --hard', { calls, dirty: true });
    assert.ok(seen.includes('trackedDirty'));
  });
});
