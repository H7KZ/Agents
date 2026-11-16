import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { classifyCommits, detectGit, redactUrl, remoteHost } from '../../plugins/h7/scripts/detect-git.ts';
import type { Runner } from '../../plugins/h7/scripts/git.ts';

/** A runner that answers only the exact argument lists it was given; everything else fails like git would. */
function fake(answers: Record<string, string>, throwOn: string[] = []): Runner & { calls: string[] } {
  const calls: string[] = [];
  const runner: Runner = (args) => {
    const key = args.join(' ');
    calls.push(key);
    if (throwOn.includes(key)) throw new Error('boom');
    return key in answers ? { status: 0, stdout: `${answers[key]}\n` } : { status: 1, stdout: '' };
  };
  return Object.assign(runner, { calls });
}

const BASE: Record<string, string> = { 'rev-parse --show-toplevel': '/r' };
const BRANCHES = 'branch --format=%(refname:short)';
const REMOTE_BRANCHES = 'branch -r --format=%(refname:short)';
const LOG = 'log -n30 --format=%s';

describe('detect-git: detectGit with an exact runner', () => {
  it('not a repository gives the empty answer and asks nothing else', () => {
    const run = fake({});
    assert.deepEqual(detectGit('/r', run), {
      isRepo: false,
      branch: null,
      dirty: false,
      defaultBranch: null,
      protectedBranches: [],
      remote: null,
      commitConvention: { kind: 'unknown', sampled: 0, matching: 0, examples: [] },
      excludePath: null,
    });
    assert.deepEqual(run.calls, ['rev-parse --show-toplevel']);
  });

  it('a runner that throws on the first question means no repository', () => {
    const run = fake(BASE, ['rev-parse --show-toplevel']);
    assert.equal(detectGit('/r', run).isRepo, false);
  });

  it('a full answer', () => {
    const run = fake({
      ...BASE,
      'branch --show-current': 'feat/x',
      [BRANCHES]: 'main\nfeat/x\n  develop  \n\n',
      [REMOTE_BRANCHES]: 'origin/HEAD\norigin/staging\norigin/release/HEAD\nprod\norigin/release-2\norigin/feat/y',
      'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/trunk',
      'remote get-url origin': 'https://user:tok@github.com/o/r.git',
      'status --porcelain': ' M a.txt',
      [LOG]: 'feat: a\r\nfix(x): b\n\n  chore!: c  \nwip',
      'rev-parse --git-path info/exclude': '.git/info/exclude',
    });
    assert.deepEqual(detectGit('/r', run), {
      isRepo: true,
      branch: 'feat/x',
      dirty: true,
      defaultBranch: { name: 'trunk', source: 'origin-head' },
      protectedBranches: ['develop', 'main', 'release-2', 'staging'],
      remote: { url: 'https://github.com/o/r.git', host: 'github.com' },
      commitConvention: { kind: 'conventional', sampled: 4, matching: 3, examples: ['feat: a', 'fix(x): b', 'chore!: c'] },
      excludePath: '.git/info/exclude',
    });
  });

  it('a bare repository: nothing known, nothing dirty', () => {
    const d = detectGit('/r', fake({ ...BASE, 'branch --show-current': '', 'status --porcelain': '' }));
    assert.equal(d.branch, null);
    assert.equal(d.dirty, false);
    assert.equal(d.defaultBranch, null);
    assert.deepEqual(d.protectedBranches, []);
    assert.equal(d.remote, null);
    assert.equal(d.excludePath, null);
    assert.deepEqual(d.commitConvention, { kind: 'unknown', sampled: 0, matching: 0, examples: [] });
  });

  it('the default branch falls back to a local main, then master, then nothing', () => {
    assert.deepEqual(detectGit('/r', fake({ ...BASE, [BRANCHES]: 'master\nmain' })).defaultBranch, { name: 'main', source: 'local-branch' });
    assert.deepEqual(detectGit('/r', fake({ ...BASE, [BRANCHES]: 'x\nmaster' })).defaultBranch, { name: 'master', source: 'local-branch' });
    assert.equal(detectGit('/r', fake({ ...BASE, [BRANCHES]: 'trunk\nmain2' })).defaultBranch, null);
  });

  it('origin/HEAD wins over local branches and only loses its own leading origin/', () => {
    const run = fake({ ...BASE, [BRANCHES]: 'main', 'symbolic-ref --short refs/remotes/origin/HEAD': 'upstream/origin/main' });
    assert.deepEqual(detectGit('/r', run).defaultBranch, { name: 'upstream/origin/main', source: 'origin-head' });
    const plain = fake({ ...BASE, 'symbolic-ref --short refs/remotes/origin/HEAD': 'origin/dev' });
    assert.deepEqual(detectGit('/r', plain).defaultBranch, { name: 'dev', source: 'origin-head' });
  });

  it('protected branch names are whole names', () => {
    const yes = ['main', 'master', 'develop', 'development', 'dev', 'trunk', 'production', 'prod', 'staging', 'stable', 'release', 'release/1.0', 'release-2'];
    const no = ['xmain', 'mainx', 'main2', 'feature/main', 'releases', 'release2', 'devs', 'predev', 'x/prod'];
    const d = detectGit('/r', fake({ ...BASE, [BRANCHES]: [...yes, ...no].join('\n') }));
    assert.deepEqual(d.protectedBranches, [...yes].sort());
  });

  it('remote branches lose their remote name and are de-duplicated against local ones', () => {
    const d = detectGit('/r', fake({ ...BASE, [BRANCHES]: 'main', [REMOTE_BRANCHES]: 'origin/main\nfork/main\nfork/release/3\nmain' }));
    assert.deepEqual(d.protectedBranches, ['main', 'release/3']);
  });

  it('a throwing question answers null for that question only', () => {
    const run = fake({ ...BASE, 'branch --show-current': 'x', 'status --porcelain': 'M' }, ['status --porcelain', 'remote get-url origin']);
    const d = detectGit('/r', run);
    assert.equal(d.isRepo, true);
    assert.equal(d.branch, 'x');
    assert.equal(d.dirty, false);
    assert.equal(d.remote, null);
  });

  it('asks git for exactly these things', () => {
    const run = fake(BASE);
    detectGit('/r', run);
    assert.deepEqual(run.calls.sort(), [
      BRANCHES,
      LOG,
      'branch --show-current',
      REMOTE_BRANCHES,
      'remote get-url origin',
      'rev-parse --git-path info/exclude',
      'rev-parse --show-toplevel',
      'status --porcelain',
      'symbolic-ref --short refs/remotes/origin/HEAD',
    ].sort());
  });
});

describe('detect-git: classifyCommits', () => {
  it('knows every conventional type, scope and breaking marker', () => {
    const good = ['feat: a', 'fix: a', 'docs: a', 'style: a', 'refactor: a', 'perf: a', 'test: a', 'build: a', 'ci: a', 'chore: a', 'revert: a', 'feat(core): a', 'fix(a-b)!: a', 'feat!: a'];
    for (const s of good) assert.equal(classifyCommits([s]).matching, 1, s);
    const bad = ['xfeat: a', 'feature: a', 'feat(): a', 'feat(a)b: c', 'feat:a', 'feat: ', 'feat a', 'Feat: a', 'merge: a', 'feat(a: b'];
    for (const s of bad) assert.equal(classifyCommits([s]).matching, 0, s);
  });

  it('the conventional threshold is inclusive at 60 percent and the sample minimum is 3', () => {
    assert.equal(classifyCommits(['feat: a', 'feat: b', 'feat: c', 'x', 'y']).kind, 'conventional');
    assert.equal(classifyCommits(['feat: a', 'feat: b', 'x', 'y', 'z']).kind, 'other');
    assert.equal(classifyCommits(['feat: a', 'feat: b', 'feat: c']).kind, 'conventional');
    assert.equal(classifyCommits(['x', 'y', 'z']).kind, 'other');
    assert.equal(classifyCommits(['x', 'y']).kind, 'unknown');
    assert.deepEqual(classifyCommits([]), { kind: 'unknown', sampled: 0, matching: 0, examples: [] });
  });
});

describe('detect-git: urls', () => {
  it('credentials never survive, even for an empty username or password', () => {
    assert.equal(redactUrl('https://:pw@github.com/a'), 'https://github.com/a');
    assert.equal(redactUrl('https://tok@github.com/a'), 'https://github.com/a');
    assert.equal(redactUrl('https://u:p@github.com/a'), 'https://github.com/a');
  });

  it('a url without credentials is returned untouched, not normalised', () => {
    assert.equal(redactUrl('https://github.com'), 'https://github.com');
    assert.equal(redactUrl('https://GitHub.com:443/a b'), 'https://GitHub.com:443/a b');
  });

  it('an unparsable url still loses its credentials but keeps scheme and the rest', () => {
    assert.equal(redactUrl('https://user:tok@host:99999999/x'), 'https://host:99999999/x');
    assert.equal(redactUrl('git+ssh://user:tok@host:99999999/x'), 'git+ssh://host:99999999/x');
    assert.equal(redactUrl('HTTPS://user:tok@host:99999999/x'), 'HTTPS://host:99999999/x');
    assert.equal(redactUrl('https://host:99999999/x@y'), 'https://host:99999999/x@y');
    assert.equal(redactUrl('scp-style:a@b'), 'scp-style:a@b');
  });

  it('remoteHost needs the host at the start', () => {
    assert.equal(remoteHost(' git@github.com:a/b'), null);
    assert.equal(remoteHost('git@github.com:a/b'), 'github.com');
    assert.equal(remoteHost('git+ssh://git@h.example/a'), 'h.example');
  });
});
