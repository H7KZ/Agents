import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifySecret } from '../../plugins/h7/scripts/rules-git.ts';
import { decide, type Options } from './support.ts';

const ADVICE = 'Run the hooks and fix what they report. If a hook is wrong, ask the user before bypassing it.';

/** "decision:rule" plus the reason, or null. */
function verdict(command: string, options: Options = {}): { id: string; reason: string } | null {
  const d = decide(command, options);
  return d === null ? null : { id: `${d.decision}:${d.rule}`, reason: d.reason };
}
const id = (command: string, options?: Options): string | null => verdict(command, options)?.id ?? null;

describe('rules-git edges: skipping hooks', () => {
  const HOOKED = ['commit', 'push', 'merge', 'rebase', 'am', 'cherry-pick', 'revert', 'pull', 'checkout', 'switch'];

  it('every hook-running subcommand is blocked under HUSKY=0 and a SKIP list; others are not', () => {
    for (const sub of HOOKED) {
      assert.deepEqual(verdict(`HUSKY=0 git ${sub}`, { branch: 'feature' }), { id: 'block:skip-git-hooks', reason: `HUSKY=0 disables git hooks. ${ADVICE}` }, sub);
      assert.deepEqual(verdict(`SKIP=lint,test git ${sub}`, { branch: 'feature' }), { id: 'block:skip-git-hooks', reason: `SKIP=lint,test disables pre-commit hooks. ${ADVICE}` }, sub);
    }
    for (const sub of ['status', 'log', 'diff', 'add', 'fetch']) {
      assert.equal(id(`HUSKY=0 git ${sub}`), null, sub);
      assert.equal(id(`SKIP=x git ${sub}`), null, sub);
    }
    assert.equal(id('HUSKY=1 git commit -m x'), null);
    assert.equal(id('SKIP= git commit -m x'), null);
  });

  it('flag blocks say what they saw', () => {
    assert.deepEqual(verdict('git commit --no-verify'), { id: 'block:skip-git-hooks', reason: `--no-verify skips git hooks. ${ADVICE}` });
    assert.deepEqual(verdict('git commit -n'), { id: 'block:skip-git-hooks', reason: `git commit -n skips git hooks. ${ADVICE}` });
    assert.equal(id('git push --no-v origin feature', { branch: 'feature' }), 'block:skip-git-hooks');
    assert.equal(id('git push -n origin feature', { branch: 'feature' }), null);
    assert.equal(id('git merge -n x'), null);
  });

  it('commit options that take a value swallow the next word', () => {
    for (const flag of ['--message', '--file', '--reuse-message', '--reedit-message', '--template', '--author', '--date', '--cleanup', '--fixup', '--squash', '--trailer']) {
      assert.equal(id(`git commit ${flag} --no-verify`), null, flag);
      assert.equal(id(`git commit ${flag} x --no-verify`), 'block:skip-git-hooks', flag);
    }
    for (const letter of ['m', 'F', 'C', 'c', 't']) assert.equal(id(`git commit -${letter} -n`), null, letter);
    assert.equal(id('git commit -Sn'), null);
    assert.equal(id('git commit -un'), null);
    assert.equal(id('git commit -S -n'), 'block:skip-git-hooks');
    assert.equal(id('git commit --all --no-verify'), 'block:skip-git-hooks');
    assert.equal(id('git commit --al -n'), 'block:skip-git-hooks');
  });

  it('push options that take a value swallow the next word, and abbreviations resolve', () => {
    const opts: Options = { branch: 'feature' };
    for (const flag of ['--repo', '--receive-pack', '--exec', '--push-option', '-o']) assert.equal(id(`git push ${flag} --force origin main`, opts), 'ask:push-protected', flag);
    for (const [flag, expected] of [['--forc', 'block:force-push-protected'], ['--force-w', 'block:force-push-protected'], ['--force-i', 'block:force-push-protected'], ['--mirr', 'block:force-push-protected'], ['--dele', 'block:push-delete-protected']] as const) {
      assert.equal(id(`git push ${flag} origin main`, opts), expected, flag);
    }
    assert.equal(id('git push --bran origin', opts), 'ask:push-protected');
    assert.equal(id('git push --all origin', opts), 'ask:push-protected');
    assert.equal(id('git push --tags origin', opts), null);
    assert.equal(id('git push --tag origin', opts), null);
  });
});

describe('rules-git edges: destructive git', () => {
  const dirty: Options = { dirty: true, untracked: ['u'], ignored: ['i'] };

  it('value options swallow a following flag so it cannot count', () => {
    for (const cmd of ['git checkout --orphan --force', 'git checkout --conflict -f', 'git checkout --pathspec-from-file --force', 'git checkout -b -f', 'git checkout -B -f', 'git switch --orphan --discard-changes', 'git switch --conflict -f', 'git switch -c -f', 'git switch -C -f', 'git clean -e -f', 'git clean --exclude -f']) {
      assert.equal(id(cmd, dirty), null, cmd);
    }
    for (const cmd of ['git restore -s --staged a.txt', 'git restore --source --staged a.txt', 'git restore --pathspec-from-file --staged a.txt']) {
      assert.equal(id(cmd, dirty), 'block:destructive-git-dirty', cmd);
    }
    for (const cmd of ['git checkout -f', 'git switch -f x', 'git clean -f', 'git restore a.txt']) assert.equal(id(cmd, dirty), 'block:destructive-git-dirty', cmd);
  });

  it('abbreviated long options still count', () => {
    assert.equal(id('git reset --har', dirty), 'block:destructive-git-dirty');
    assert.equal(id('git checkout --forc', dirty), 'block:destructive-git-dirty');
    assert.equal(id('git switch --discard main', dirty), 'block:destructive-git-dirty');
    assert.equal(id('git clean -f --dry', dirty), null);
    assert.equal(id('git clean --forc --dry-', dirty), null);
    assert.equal(id('git restore --stag a.txt', dirty), null);
    assert.equal(id('git restore --stag --workt a.txt', dirty), 'block:destructive-git-dirty');
    assert.equal(id('git restore -S -W a.txt', dirty), 'block:destructive-git-dirty');
    assert.equal(id('git restore -S a.txt', dirty), null);
  });

  it('each block names what would be lost', () => {
    const reason = (cmd: string, opts: Options = dirty) => verdict(cmd, opts)?.reason;
    assert.match(reason('git reset --hard') as string, /^git reset --hard would destroy uncommitted changes\. Commit them or run "git stash push -u" first; the command is allowed once the worktree is clean\.$/);
    assert.match(reason('git clean -f') as string, /^git clean -f would destroy untracked files\. /);
    assert.match(reason('git checkout -f') as string, /^git checkout \(discards file changes\) would destroy uncommitted changes\. /);
    assert.match(reason('git switch --discard-changes x') as string, /^git switch --discard-changes would destroy uncommitted changes\. /);
    assert.match(reason('git restore a') as string, /^git restore \(discards file changes\) would destroy uncommitted changes\. /);
  });

  it('git clean with ignored files: -x and -X look at ignored ones, plain -f does not', () => {
    const onlyIgnored: Options = { untracked: [], ignored: ['build/x'] };
    assert.equal(id('git clean -f', onlyIgnored), null);
    assert.equal(id('git clean -fx', onlyIgnored), 'block:destructive-git-dirty');
    assert.equal(id('git clean -fX', onlyIgnored), 'block:destructive-git-dirty');
    assert.equal(id('git clean -fd', { untracked: [], ignored: [] }), null);
    assert.equal(id('git clean -fd', { untracked: ['a'] }), 'block:destructive-git-dirty');
    assert.equal(id('git clean -fx', { untracked: ['a'], ignored: [] }), 'block:destructive-git-dirty');
    assert.equal(id('git clean -n', dirty), null);
    assert.equal(id('git clean -fn', dirty), null);
    assert.equal(id('git clean -f --dry-run', dirty), null);
    assert.equal(id('git clean -d', dirty), null);
  });

  it('a clean tree is never blocked', () => {
    for (const cmd of ['git reset --hard', 'git checkout -f', 'git switch -f x', 'git restore a', 'git clean -f']) assert.equal(id(cmd, { dirty: false, untracked: [], ignored: [] }), null, cmd);
  });

  it('history rewrites say what they are', () => {
    assert.deepEqual(verdict('git stash drop'), { id: 'ask:git-stash-drop', reason: 'git stash drop permanently discards stashed work. Confirm with the user.' });
    assert.deepEqual(verdict('git stash clear'), { id: 'ask:git-stash-drop', reason: 'git stash clear permanently discards stashed work. Confirm with the user.' });
    assert.equal(id('git stash pop'), null);
    assert.equal(id('git stash'), null);
    assert.equal(id('git reset drop'), null);
    assert.deepEqual(verdict('git filter-branch --all'), { id: 'ask:git-history-rewrite', reason: 'git filter-branch rewrites history across the repository. Confirm with the user.' });
    assert.deepEqual(verdict('git filter-repo --force'), { id: 'ask:git-history-rewrite', reason: 'git filter-repo rewrites history across the repository. Confirm with the user.' });
    assert.deepEqual(verdict('git reflog expire --expire=now --all'), { id: 'ask:git-history-rewrite', reason: 'git reflog expire --expire=now removes the recovery net. Confirm with the user.' });
    assert.equal(id('git reflog expire --expire-unreachable=now'), 'ask:git-history-rewrite');
    assert.equal(id('git reflog expire --expire=90.days'), null);
    assert.equal(id('git reflog show'), null);
    assert.equal(id('git reflog delete --expire=now'), null);
    assert.equal(id('git status --expire=now'), null);
    assert.deepEqual(verdict('git gc --prune=now'), { id: 'ask:git-history-rewrite', reason: 'git gc --prune=now permanently drops unreachable objects. Confirm with the user.' });
    assert.equal(id('git gc --prune=2.weeks'), null);
    assert.equal(id('git gc'), null);
    assert.equal(id('git repack --prune=now'), null);
  });

  it('forced branch moves and update-ref on protected branches', () => {
    for (const flag of ['--force', '-f', '-M', '-C']) {
      assert.deepEqual(verdict(`git branch ${flag} main HEAD~1`), { id: 'ask:git-protected-ref', reason: 'This force-moves a protected branch. Confirm with the user.' }, flag);
    }
    assert.equal(id('git branch -f feature HEAD~1'), null);
    assert.equal(id('git branch main'), null);
    assert.equal(id('git branch -f release/1.0 x'), 'ask:git-protected-ref');
    assert.equal(id('git tag -f main'), null);
    assert.deepEqual(verdict('git update-ref refs/heads/main abc'), { id: 'ask:git-protected-ref', reason: 'git update-ref rewrites protected branch "refs/heads/main". Confirm with the user.' });
    assert.equal(id('git update-ref refs/heads/feature abc'), null);
    assert.equal(id('git update-ref refs/tags/main abc'), null);
    assert.equal(id('git update-ref HEAD abc'), null);
  });
});

describe('rules-git edges: push targets', () => {
  const opts: Options = { branch: 'feature' };

  it('branch names, ref forms and the remote default', () => {
    assert.equal(id('git push origin HEAD:refs/heads/main', opts), 'ask:push-protected');
    assert.equal(id('git push origin feature:refs/heads/main', opts), 'ask:push-protected');
    assert.equal(id('git push origin refs/tags/main', opts), null);
    assert.equal(id('git push origin refs/for/main', opts), null);
    assert.equal(id('git push origin xrefs/heads/other', opts), null);
    assert.equal(id('git push origin :main', opts), 'block:push-delete-protected');
    assert.equal(id('git push origin :refs/heads/main', opts), 'block:push-delete-protected');
    assert.equal(id('git push origin --delete main', opts), 'block:push-delete-protected');
    assert.equal(id('git push -d origin main', opts), 'block:push-delete-protected');
    assert.equal(id('git push origin :feature', opts), null);
    assert.equal(id('git push origin refs/heads/', opts), null);
    assert.equal(id('git push origin HEAD', { branch: 'main' }), 'ask:push-protected');
    assert.equal(id('git push origin HEAD', { branch: null }), null);
    assert.equal(id('git push', { branch: 'main' }), 'ask:push-protected');
    assert.equal(id('git push --tags', { branch: 'main' }), null);
    assert.equal(id('git push --delete origin feature', { branch: 'main' }), null);
    assert.equal(id('git push', { branch: 'feature', defaultBranch: 'feature' }), 'ask:push-protected');
    assert.equal(id('git push fork +x', { branch: 'feature', defaultBranch: 'trunk' }), null);
    assert.equal(id('git push -f fork trunk', { branch: 'feature', defaultBranch: 'trunk' }), 'block:force-push-protected');
    assert.equal(id('git push --force', { branch: 'prod' }), 'block:force-push-protected');
    assert.equal(id('git push --force origin release/2', { branch: 'feature' }), 'block:force-push-protected');
    assert.equal(id('git push --force origin releases/2', { branch: 'feature' }), null);
  });

  it('messages carry the branch', () => {
    assert.deepEqual(verdict('git push origin main', opts), { id: 'ask:push-protected', reason: 'This pushes directly to protected branch "main". Prefer a feature branch and a PR.' });
    assert.deepEqual(verdict('git push origin :main', opts), { id: 'block:push-delete-protected', reason: 'This deletes protected branch "main" on the remote. Ask the user to do it.' });
    assert.match(verdict('git push -f origin main', opts)?.reason as string, /^Force push to protected branch "main" can destroy shared history\. Push to a feature branch and open a PR, or use a revert commit\.$/);
  });
});

describe('rules-git edges: secrets', () => {
  const KINDS: [string, 'block' | 'ask', string][] = [
    ['.env', 'block', '.env file'],
    ['.env.local', 'block', '.env file'],
    ['.env.staging.local', 'block', '.env file'],
    ['.env.production', 'block', 'production .env file'],
    ['.env.production.bak', 'block', 'production .env file'],
    ['id_rsa', 'block', 'SSH private key'],
    ['id_ed25519', 'block', 'SSH private key'],
    ['id_ecdsa', 'block', 'SSH private key'],
    ['id_dsa', 'block', 'SSH private key'],
    ['a.p12', 'block', 'PKCS#12 keystore'],
    ['a.pfx', 'block', 'PKCS#12 keystore'],
    ['a.keystore', 'block', 'Java keystore'],
    ['a.jks', 'block', 'Java keystore'],
    ['credentials.json', 'block', 'credentials file'],
    ['.netrc', 'block', 'credentials file'],
    ['.pgpass', 'block', 'credentials file'],
    ['secrets.yml', 'block', 'secrets file'],
    ['secrets.txt', 'block', 'secrets file'],
    ['secrets.prod.yaml', 'block', 'secrets file'],
    ['server.key', 'block', 'private key'],
    ['.env.dev', 'ask', '.env variant'],
    ['.env.test', 'ask', '.env variant'],
    ['cert.pem', 'ask', 'PEM key or certificate'],
    ['.npmrc', 'ask', '.npmrc (may hold a token)'],
    ['prod.tfvars', 'ask', 'Terraform variables file'],
  ];

  it('classifies each kind, in any directory', () => {
    for (const [file, tier, kind] of KINDS) {
      assert.deepEqual(classifySecret(file), { tier, kind }, file);
      assert.deepEqual(classifySecret(`a/b/${file}`), { tier, kind }, file);
      assert.deepEqual(classifySecret(`a\\b\\${file.toUpperCase()}`), { tier, kind }, file);
    }
  });

  it('look-alikes and exempt templates are not secrets', () => {
    for (const file of ['x.env', 'x.env.local', '.envx', 'xid_rsa', 'id_rsax', 'id_rsa.pub', 'a.p12x', 'xa.p12.bak', 'a.keystorex', 'a.jksx', 'xcredentials.json', 'credentials.jsonx', 'x.netrc', '.netrcx', '.pgpassx', 'xsecrets.yml', 'secrets', 'secrets.ts', 'secrets.mjs', 'secrets.cts', 'secrets.tsx', 'secrets.md', 'secrets.py', 'secrets.go', 'secrets.rs', 'secrets.java', 'secrets.rb', 'a.keys', 'a.key.bak', 'x.npmrc', '.npmrcx', 'a.tfvarsx', 'a.pemx', 'x.env.dev', '.env.example', '.env.local.example', 'a.key.sample', '.env.template', 'cert.pem.pub', 'id_rsa.example']) {
      assert.equal(classifySecret(file), null, file);
    }
  });
});
