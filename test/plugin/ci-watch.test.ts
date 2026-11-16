import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { cleanupTmp, tmpDir } from '../../scripts/test/helpers.ts';
import { EXIT, STATE_FILE, main, makeGh, parseArgs, resolveGh, watch, type Deps, type Gh, type GhResult, type Options } from '../../plugins/h7/scripts/ci-watch.ts';
import type { Verdict } from '../../plugins/h7/scripts/ci-verdict.ts';
import type { StateIo } from '../../plugins/h7/scripts/verify-state.ts';

cleanupTmp();

const OPTIONS: Options = { pr: null, noRerun: false, allowNoChecks: false, logLines: 60 };
const ok = (stdout = ''): GhResult => ({ status: 0, stdout, stderr: '' });
const fail = (stderr = 'boom'): GhResult => ({ status: 1, stdout: '', stderr });
const run = (name: string, conclusion: string, id = '11'): unknown => ({ name, status: 'COMPLETED', conclusion, detailsUrl: `https://github.com/o/r/actions/runs/${id}/job/1` });

function prJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({ number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', baseRefName: 'main', headRefName: 'feat', headRefOid: 'sha1', statusCheckRollup: [run('build', 'SUCCESS')], ...over });
}

const threadsJson = (open: number): string => JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: Array.from({ length: open }, () => ({ isResolved: false })) } } } } });

interface Harness {
  deps: Deps;
  calls: string[][];
  files: Record<string, string>;
}

function harness(routes: { pr?: string; threads?: GhResult; version?: GhResult; auth?: GhResult; view?: GhResult; rerun?: GhResult; log?: GhResult; files?: Record<string, string>; writeThrows?: boolean } = {}): Harness {
  const calls: string[][] = [];
  const files = { ...routes.files };
  const gh: Gh = (args) => {
    calls.push(args);
    const [a, b] = args;
    if (a === '--version') return routes.version ?? ok('gh version 2');
    if (a === 'auth') return routes.auth ?? ok();
    if (a === 'pr') return routes.view ?? ok(routes.pr ?? prJson());
    if (a === 'api') return routes.threads ?? ok(threadsJson(0));
    if (a === 'run' && b === 'rerun') return routes.rerun ?? ok();
    if (a === 'run' && b === 'view') return routes.log ?? ok('lint\nerror: boom\n');
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  const io: StateIo = {
    read: (path) => files[path] ?? null,
    write: (path, text) => {
      if (routes.writeThrows) throw new Error('disk full');
      files[path] = text;
    },
  };
  return { deps: { gh, io, cwd: '/work' }, calls, files };
}

const stateKey = join('/work', STATE_FILE);

describe('parseArgs', () => {
  it('parses flags and a pull request number', () => {
    assert.deepEqual(parseArgs([]), OPTIONS);
    assert.deepEqual(parseArgs(['042', '--no-rerun', '--allow-no-checks', '--log-lines', '5']), { pr: '42', noRerun: true, allowNoChecks: true, logLines: 5 });
  });

  it('rejects what it does not know', () => {
    for (const bad of [['--merge'], ['1', '2'], ['feat'], ['--log-lines'], ['--log-lines', '0'], ['--log-lines', 'x'], ['--log-lines', '12345'], ['1234567890']]) {
      assert.equal(typeof parseArgs(bad), 'string', bad.join(' '));
    }
  });
});

describe('watch: gh problems are BLOCKED, never a guess', () => {
  it('missing gh', () => {
    const h = harness({ version: { status: null, stdout: '', stderr: '' } });
    const v = watch(OPTIONS, h.deps);
    assert.equal(v.verdict, 'BLOCKED');
    assert.match(v.blockers[0]?.detail ?? '', /not installed/);
    assert.equal(h.calls.length, 1);
  });

  it('not authenticated', () => {
    const v = watch(OPTIONS, harness({ auth: fail() }).deps);
    assert.match(v.blockers[0]?.detail ?? '', /gh auth login/);
  });

  it('pr view fails, or prints something unreadable', () => {
    assert.match(watch(OPTIONS, harness({ view: fail('no pull requests found\nmore') }).deps).blockers[0]?.detail ?? '', /gh pr view failed: no pull requests found$/);
    assert.match(watch(OPTIONS, harness({ view: fail('') }).deps).blockers[0]?.detail ?? '', /no output$/);
    for (const bad of ['not json', '{}', '[]']) assert.match(watch(OPTIONS, harness({ pr: bad }).deps).blockers[0]?.detail ?? '', /does not understand/);
  });

  it('review threads cannot be read', () => {
    const v = watch(OPTIONS, harness({ threads: fail('graphql down') }).deps);
    assert.equal(v.verdict, 'BLOCKED');
    assert.match(v.blockers[0]?.detail ?? '', /could not read review threads: graphql down/);
    assert.equal(v.pr?.number, 7);
    assert.equal(watch(OPTIONS, harness({ threads: ok('garbage') }).deps).verdict, 'BLOCKED');
  });
});

describe('watch: verdicts', () => {
  it('READY, and a named pull request is passed to gh', () => {
    const h = harness();
    const v = watch({ ...OPTIONS, pr: '7' }, h.deps);
    assert.equal(v.verdict, 'READY');
    assert.deepEqual(h.calls[2], ['pr', 'view', '7', '--json', h.calls[2]?.[4] as string]);
    assert.ok(h.calls.every((call) => !call.includes('merge')));
  });

  it('asks for the current branch when no number is given', () => {
    const h = harness();
    watch(OPTIONS, h.deps);
    assert.equal(h.calls[2]?.[2], '--json');
    assert.deepEqual(h.calls[3]?.slice(0, 6), ['api', 'graphql', '-F', 'owner={owner}', '-F', 'repo={repo}']);
    assert.ok(h.calls[3]?.includes('number=7'));
  });

  it('WAITING while checks run', () => {
    const v = watch(OPTIONS, harness({ pr: prJson({ statusCheckRollup: [{ name: 'build', status: 'IN_PROGRESS' }] }) }).deps);
    assert.equal(v.verdict, 'WAITING');
  });

  it('BLOCKED on unresolved threads and conflicts', () => {
    const v = watch(OPTIONS, harness({ threads: ok(threadsJson(2)), pr: prJson({ mergeable: 'CONFLICTING' }) }).deps);
    assert.deepEqual(v.blockers.map((b) => b.kind), ['merge-conflicts', 'review-threads']);
  });
});

describe('watch: failure triage', () => {
  const failing = prJson({ statusCheckRollup: [run('build', 'SUCCESS'), run('test', 'FAILURE', '11'), run('lint', 'FAILURE', '11')] });

  it('reruns a first failure once, records it, and waits', () => {
    const h = harness({ pr: failing });
    const v = watch(OPTIONS, h.deps);
    assert.equal(v.verdict, 'WAITING');
    assert.deepEqual(v.rerun, ['test', 'lint']);
    assert.deepEqual(h.calls.filter((c) => c[0] === 'run'), [['run', 'rerun', '11', '--failed']]);
    assert.deepEqual(JSON.parse(h.files[stateKey] ?? '{}'), { sha: 'sha1', reran: ['test', 'lint'] });
    assert.equal(v.failureLogs.length, 0);
  });

  it('a failure that already got its rerun on this head is real and returns a log excerpt', () => {
    const h = harness({ pr: failing, files: { [stateKey]: JSON.stringify({ sha: 'sha1', reran: ['test', 'lint'] }) } });
    const v = watch({ ...OPTIONS, logLines: 1 }, h.deps);
    assert.equal(v.verdict, 'BLOCKED');
    assert.equal(v.blockers[0]?.kind, 'failing-checks');
    assert.deepEqual(v.failureLogs, [{ check: 'test, lint', excerpt: 'error: boom' }]);
    assert.ok(!h.calls.some((c) => c[1] === 'rerun'));
  });

  it('a rerun record for an older head does not count', () => {
    const h = harness({ pr: failing, files: { [stateKey]: JSON.stringify({ sha: 'old', reran: ['test', 'lint'] }) } });
    assert.equal(watch(OPTIONS, h.deps).verdict, 'WAITING');
  });

  it('a malformed rerun record counts as none', () => {
    for (const bad of ['nope', '5', 'null', '{"sha":"sha1"}', '{"sha":"sha1","reran":"x"}']) {
      assert.equal(watch(OPTIONS, harness({ pr: failing, files: { [stateKey]: bad } }).deps).verdict, 'WAITING', bad);
    }
    const mixed = harness({ pr: failing, files: { [stateKey]: JSON.stringify({ sha: 'sha1', reran: ['test', 7, 'lint'] }) } });
    assert.equal(watch(OPTIONS, mixed.deps).verdict, 'BLOCKED');
  });

  it('keeps earlier rerun names when recording a new one', () => {
    const h = harness({ pr: prJson({ statusCheckRollup: [run('test', 'FAILURE'), run('e2e', 'FAILURE', '12')] }), files: { [stateKey]: JSON.stringify({ sha: 'sha1', reran: ['test'] }) } });
    const v = watch(OPTIONS, h.deps);
    assert.equal(v.blockers[0]?.kind, 'failing-checks');
    assert.deepEqual(JSON.parse(h.files[stateKey] ?? '{}').reran, ['test', 'e2e']);
    assert.deepEqual(v.rerun, ['e2e']);
  });

  it('a failed rerun request makes the failure real', () => {
    const v = watch(OPTIONS, harness({ pr: failing, rerun: fail('no permission'), log: fail('expired') }).deps);
    assert.equal(v.verdict, 'BLOCKED');
    assert.equal(v.failureLogs[0]?.excerpt, 'log unavailable: expired');
  });

  it('--no-rerun and checks without an Actions run are real failures', () => {
    const h = harness({ pr: failing });
    assert.equal(watch({ ...OPTIONS, noRerun: true }, h.deps).verdict, 'BLOCKED');
    assert.ok(!h.calls.some((c) => c[1] === 'rerun'));
    const external = harness({ pr: prJson({ statusCheckRollup: [{ context: 'ci/ext', state: 'FAILURE', targetUrl: 'https://ci.example/1' }] }) });
    const v = watch(OPTIONS, external.deps);
    assert.equal(v.blockers[0]?.kind, 'failing-checks');
    assert.deepEqual(v.failureLogs, []);
  });

  it('when the rerun cannot be recorded, nothing is rerun and the failure is real', () => {
    const h = harness({ pr: failing, writeThrows: true });
    const v = watch(OPTIONS, h.deps);
    assert.equal(v.verdict, 'BLOCKED');
    assert.ok(!h.calls.some((c) => c[1] === 'rerun'));
  });

  it('a failure on a branch behind its base is stale: rebase advice, no rerun, no log', () => {
    const h = harness({ pr: prJson({ mergeStateStatus: 'BEHIND', statusCheckRollup: [run('test', 'FAILURE')] }) });
    const v = watch(OPTIONS, h.deps);
    assert.equal(v.blockers[0]?.kind, 'stale-base');
    assert.match(v.advice[0] ?? '', /rebase/);
    assert.ok(!h.calls.some((c) => c[0] === 'run'));
  });

  it('fetches logs for at most three runs', () => {
    const rollup = ['1', '2', '3', '4'].map((id) => run(`job${id}`, 'FAILURE', id));
    const reran = JSON.stringify({ sha: 'sha1', reran: ['job1', 'job2', 'job3', 'job4'] });
    const h = harness({ pr: prJson({ statusCheckRollup: rollup }), files: { [stateKey]: reran } });
    const v = watch(OPTIONS, h.deps);
    assert.equal(v.failureLogs.length, 3);
    assert.equal(h.calls.filter((c) => c[0] === 'run' && c[1] === 'view').length, 3);
  });
});

describe('main', () => {
  it('prints JSON and exits by verdict', () => {
    const out: string[] = [];
    const exit = (routes: Parameters<typeof harness>[0]): number => {
      out.length = 0;
      return main([], (t) => out.push(t), () => assert.fail('no stderr expected'), harness(routes).deps);
    };
    assert.equal(exit({}), EXIT.READY);
    assert.equal((JSON.parse(out[0] as string) as Verdict).verdict, 'READY');
    assert.equal(exit({ pr: prJson({ statusCheckRollup: [{ name: 'a', status: 'QUEUED' }] }) }), EXIT.WAITING);
    assert.equal(exit({ auth: fail() }), EXIT.BLOCKED);
  });

  it('usage errors go to stderr and never touch gh', () => {
    const h = harness();
    const err: string[] = [];
    assert.equal(main(['--bogus'], () => assert.fail('no stdout'), (t) => err.push(t), h.deps), EXIT.USAGE);
    assert.match(err[0] ?? '', /usage:/);
    assert.equal(h.calls.length, 0);
  });
});

describe('gh runner', () => {
  it('reports a missing executable as status null', () => {
    assert.deepEqual(makeGh(null)(['x'], '/'), { status: null, stdout: '', stderr: 'gh not found' });
  });

  it('spawns without a shell, in cwd, with a timeout', () => {
    let seen: { args: unknown; options: Record<string, unknown> } | null = null;
    const fake = ((exe: string, args: string[], options: Record<string, unknown>) => {
      seen = { args: [exe, ...args], options };
      return { status: 0, stdout: 'out', stderr: 'err' };
    }) as unknown as typeof spawnSync;
    assert.deepEqual(makeGh('/bin/gh', fake)(['pr', 'view'], '/repo'), { status: 0, stdout: 'out', stderr: 'err' });
    assert.deepEqual((seen as unknown as { args: unknown }).args, ['/bin/gh', 'pr', 'view']);
    const options = (seen as unknown as { options: Record<string, unknown> }).options;
    assert.equal(options.cwd, '/repo');
    assert.equal(options.shell, undefined);
    assert.equal(options.timeout, 60_000);
    const empty = (() => ({ status: null, stdout: null, stderr: null })) as unknown as typeof spawnSync;
    assert.deepEqual(makeGh('/bin/gh', empty)([], '/'), { status: null, stdout: '', stderr: '' });
  });

  it('resolves gh from absolute PATH entries only', () => {
    const root = tmpDir('ci-watch-path');
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const sep = process.platform === 'win32' ? ';' : ':';
    const present = (path: string): boolean => path === join(bin, 'gh') || path === join(bin, 'gh.exe');
    assert.ok(resolveGh(`relative${sep}${bin}`, present)?.startsWith(bin));
    assert.equal(resolveGh(`relative${sep}.`, () => true), null);
    assert.equal(resolveGh(bin, () => false), null);
  });
});

describe('ci-watch entry point', () => {
  const script = join(import.meta.dirname, '../../plugins/h7/scripts/ci-watch.ts');
  const spawn = (args: string[], env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env, cwd: tmpDir('ci-watch-cwd') });

  it('rejects unknown arguments', () => {
    const r = spawn(['--bogus'], { ...process.env });
    assert.equal(r.status, EXIT.USAGE);
    assert.match(r.stderr, /usage:/);
  });

  it('reports BLOCKED, not a crash, when gh is missing', () => {
    const r = spawn([], { ...process.env, PATH: tmpDir('ci-watch-empty'), Path: tmpDir('ci-watch-empty') });
    assert.equal(r.status, EXIT.BLOCKED);
    const v = JSON.parse(r.stdout) as Verdict;
    assert.equal(v.blockers[0]?.kind, 'status-query');
    assert.match(v.blockers[0]?.detail ?? '', /not installed/);
  });
});
