import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import { blocked, classifyCheck, countOpenThreads, decide, excerpt, parsePr, triage, type Check, type CheckState, type Pr, type Triage } from '../../plugins/h7/scripts/ci-verdict.ts';

const check = (name: string, state: CheckState, runId: string | null = null): Check => ({ name, state, runId, url: null });
const none: Triage = { rerun: [], real: [], stale: [] };

function pr(over: Partial<Pr> = {}): Pr {
  return { number: 7, url: 'https://github.com/o/r/pull/7', state: 'OPEN', draft: false, mergeable: 'MERGEABLE', mergeState: 'CLEAN', base: 'main', head: 'feat', sha: 'abc', checks: [check('build', 'pass')], ...over };
}

const checkArb = fc.record({
  name: fc.string({ minLength: 1, maxLength: 6 }),
  state: fc.constantFrom<CheckState>('pass', 'fail', 'pending', 'skipped'),
  runId: fc.option(fc.stringMatching(/^\d{1,4}$/), { nil: null }),
  url: fc.constant(null),
});
const prArb = fc.record({
  number: fc.integer({ min: 1, max: 999 }),
  url: fc.constant('u'),
  state: fc.constantFrom<Pr['state']>('OPEN', 'OPEN', 'OPEN', 'CLOSED', 'MERGED'),
  draft: fc.boolean(),
  mergeable: fc.constantFrom('MERGEABLE', 'CONFLICTING', 'UNKNOWN'),
  mergeState: fc.constantFrom('CLEAN', 'DIRTY', 'BEHIND', 'BLOCKED', 'UNSTABLE', 'UNKNOWN', 'HAS_HOOKS'),
  base: fc.constant('main'),
  head: fc.constant('feat'),
  sha: fc.constant('abc'),
  checks: fc.array(checkArb, { maxLength: 6 }),
});

describe('classifyCheck', () => {
  it('maps check run conclusions', () => {
    const run = (status: string, conclusion?: string): CheckState => classifyCheck({ name: 'n', status, conclusion }).state;
    assert.equal(run('COMPLETED', 'SUCCESS'), 'pass');
    assert.equal(run('COMPLETED', 'NEUTRAL'), 'pass');
    assert.equal(run('COMPLETED', 'SKIPPED'), 'skipped');
    for (const bad of ['FAILURE', 'TIMED_OUT', 'CANCELLED', 'STARTUP_FAILURE', 'ACTION_REQUIRED', 'STALE', 'WHATEVER', undefined]) assert.equal(run('COMPLETED', bad), 'fail', String(bad));
    for (const live of ['IN_PROGRESS', 'QUEUED', 'PENDING', 'WAITING']) assert.equal(run(live), 'pending');
  });

  it('maps status contexts', () => {
    const ctx = (state?: string): CheckState => classifyCheck({ context: 'ci/x', state }).state;
    assert.equal(ctx('SUCCESS'), 'pass');
    assert.equal(ctx('PENDING'), 'pending');
    assert.equal(ctx('EXPECTED'), 'pending');
    assert.equal(ctx('FAILURE'), 'fail');
    assert.equal(ctx('ERROR'), 'fail');
    assert.equal(ctx(undefined), 'fail');
    assert.equal(classifyCheck({ context: 'ci/x', state: 'SUCCESS' }).name, 'ci/x');
  });

  it('reads the run id from the details url and tolerates other urls', () => {
    assert.equal(classifyCheck({ name: 'a', status: 'COMPLETED', conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/123/job/9' }).runId, '123');
    assert.equal(classifyCheck({ name: 'a', detailsUrl: 'https://ci.example/build/1' }).runId, null);
    assert.equal(classifyCheck({ context: 'a', state: 'FAILURE', targetUrl: 'https://ci.example/1' }).url, 'https://ci.example/1');
    assert.equal(classifyCheck({ name: 'a' }).url, null);
  });

  it('treats unknown shapes as failed, never passing', () => {
    for (const raw of [null, undefined, 5, 'x', [], {}]) {
      const result = classifyCheck(raw);
      assert.equal(result.state, 'fail');
      assert.equal(result.name, 'unknown check');
    }
  });

  it('is not fooled by prototype-looking names or states', () => {
    for (const word of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
      assert.equal(classifyCheck({ name: word, status: 'COMPLETED', conclusion: word }).state, 'fail');
      assert.equal(classifyCheck({ context: word, state: word }).state, 'fail');
    }
  });

  it('never throws and always returns a known state', () => {
    fc.assert(
      fc.property(fc.anything(), (raw) => {
        assert.ok(['pass', 'fail', 'pending', 'skipped'].includes(classifyCheck(raw).state));
      }),
    );
  });
});

describe('parsePr', () => {
  const good = { number: 3, url: 'u', state: 'OPEN', isDraft: true, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', baseRefName: 'main', headRefName: 'f', headRefOid: 'sha', statusCheckRollup: [{ name: 'a', status: 'COMPLETED', conclusion: 'SUCCESS' }] };

  it('parses a full pull request', () => {
    assert.deepEqual(parsePr(good), { number: 3, url: 'u', state: 'OPEN', draft: true, mergeable: 'CONFLICTING', mergeState: 'DIRTY', base: 'main', head: 'f', sha: 'sha', checks: [{ name: 'a', state: 'pass', runId: null, url: null }] });
  });

  it('fills defaults for missing fields', () => {
    const minimal = parsePr({ number: 1, state: 'MERGED' });
    assert.deepEqual(minimal, { number: 1, url: '', state: 'MERGED', draft: false, mergeable: 'UNKNOWN', mergeState: 'UNKNOWN', base: '', head: '', sha: '', checks: [] });
    assert.deepEqual(parsePr({ number: 1, state: 'OPEN', statusCheckRollup: null })?.checks, []);
  });

  it('rejects what it cannot read', () => {
    for (const bad of [null, 'x', [], {}, { number: 0, state: 'OPEN' }, { number: 1.5, state: 'OPEN' }, { number: '1', state: 'OPEN' }, { number: 1 }, { number: 1, state: 'DRAFT' }, { number: 1, state: 'OPEN', statusCheckRollup: 'x' }]) {
      assert.equal(parsePr(bad), null, JSON.stringify(bad));
    }
  });

  it('never throws', () => {
    fc.assert(fc.property(fc.anything(), (raw) => void parsePr(raw)));
  });
});

describe('countOpenThreads', () => {
  const wrap = (nodes: unknown, pageInfo?: unknown): unknown => ({ data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo } } } } });

  it('counts unresolved threads, outdated ones included', () => {
    assert.equal(countOpenThreads(wrap([{ isResolved: true }, { isResolved: false }, { isResolved: false, isOutdated: true }, {}])), 3);
    assert.equal(countOpenThreads(wrap([])), 0);
    assert.equal(countOpenThreads(wrap([{ isResolved: true }], { hasNextPage: false })), 0);
  });

  it('is unknown when more pages follow an all-resolved first page', () => {
    assert.equal(countOpenThreads(wrap([{ isResolved: true }], { hasNextPage: true })), null);
    assert.equal(countOpenThreads(wrap([{ isResolved: false }], { hasNextPage: true })), 1);
  });

  it('is unknown for any other shape', () => {
    for (const bad of [null, {}, { data: null }, wrap('x'), wrap(null), { data: { repository: { pullRequest: { reviewThreads: null } } } }]) assert.equal(countOpenThreads(bad), null);
  });
});

describe('triage', () => {
  const a = check('a', 'fail', '1');
  const b = check('b', 'fail', '2');

  it('gives each failure one rerun, then calls it real', () => {
    assert.deepEqual(triage([a, b], 'CLEAN', ['b']), { rerun: [a], real: [b], stale: [] });
  });

  it('calls failures on a behind branch stale, unless already rerun', () => {
    assert.deepEqual(triage([a, b], 'BEHIND', ['b']), { rerun: [], real: [b], stale: [a] });
  });

  it('puts every failure in exactly one bucket, in order', () => {
    fc.assert(
      fc.property(fc.array(checkArb, { maxLength: 8 }), fc.constantFrom('CLEAN', 'BEHIND'), fc.array(fc.string({ maxLength: 6 }), { maxLength: 4 }), (checks, mergeState, reran) => {
        const result = triage(checks, mergeState, reran);
        assert.equal(result.rerun.length + result.real.length + result.stale.length, checks.length);
        for (const c of result.rerun) assert.ok(!reran.includes(c.name) && mergeState !== 'BEHIND');
        for (const c of result.real) assert.ok(reran.includes(c.name));
        for (const c of result.stale) assert.ok(!reran.includes(c.name) && mergeState === 'BEHIND');
      }),
    );
  });
});

describe('decide', () => {
  it('is READY for a clean pull request', () => {
    const v = decide(pr(), 0, none);
    assert.equal(v.verdict, 'READY');
    assert.deepEqual(v.counts, { pass: 1, fail: 0, pending: 0, skipped: 0 });
    assert.deepEqual(v.pr, { number: 7, url: 'https://github.com/o/r/pull/7', sha: 'abc', base: 'main', head: 'feat' });
  });

  it('blocks a closed, merged or draft pull request', () => {
    assert.deepEqual(decide(pr({ state: 'MERGED' }), 0, none).blockers, [{ kind: 'not-open', detail: 'pull request is MERGED' }]);
    assert.equal(decide(pr({ draft: true }), 0, none).blockers[0]?.kind, 'draft');
  });

  it('blocks merge conflicts first and advises a rebase', () => {
    const v = decide(pr({ mergeable: 'CONFLICTING' }), 2, none);
    assert.deepEqual(v.blockers.map((b) => b.kind), ['merge-conflicts', 'review-threads']);
    assert.match(v.advice.join('\n'), /git rebase origin\/main/);
    assert.equal(decide(pr({ mergeState: 'DIRTY' }), 0, none).blockers[0]?.kind, 'merge-conflicts');
  });

  it('blocks on unresolved threads, singular and plural', () => {
    assert.equal(decide(pr(), 1, none).blockers[0]?.detail, '1 unresolved review thread');
    assert.equal(decide(pr(), 3, none).blockers[0]?.detail, '3 unresolved review threads');
  });

  it('blocks on real failures and stale-base failures, with advice', () => {
    const v = decide(pr({ checks: [check('t', 'fail'), check('u', 'fail')] }), 0, { rerun: [], real: [check('t', 'fail')], stale: [check('u', 'fail')] });
    assert.deepEqual(v.blockers.map((b) => b.kind), ['failing-checks', 'stale-base']);
    assert.match(v.blockers[0]?.detail ?? '', /t$/);
    assert.match(v.advice[0] ?? '', /never rebases or pushes/);
  });

  it('waits on a requested rerun, pending checks, missing checks and unknown mergeability', () => {
    const rerun = decide(pr({ checks: [check('t', 'fail')] }), 0, { ...none, rerun: [check('t', 'fail')] });
    assert.equal(rerun.verdict, 'WAITING');
    assert.deepEqual(rerun.rerun, ['t']);
    assert.deepEqual(decide(pr({ checks: [check('a', 'pending')] }), 0, none).waiting, ['1 check pending']);
    assert.deepEqual(decide(pr({ checks: [check('a', 'pending'), check('b', 'pending')] }), 0, none).waiting, ['2 checks pending']);
    assert.deepEqual(decide(pr({ checks: [] }), 0, none).waiting, ['no checks reported yet']);
    assert.equal(decide(pr({ checks: [] }), 0, none, { allowNoChecks: true }).verdict, 'READY');
    assert.deepEqual(decide(pr({ mergeable: 'UNKNOWN' }), 0, none).waiting, ['mergeability still being computed']);
    assert.deepEqual(decide(pr({ mergeState: 'UNKNOWN' }), 0, none).waiting, ['mergeability still being computed']);
  });

  it('a blocker beats waiting', () => {
    assert.equal(decide(pr({ checks: [check('a', 'pending')] }), 1, none).verdict, 'BLOCKED');
  });

  it('reports a behind branch or a protection gate only when everything else is done', () => {
    const behind = decide(pr({ mergeState: 'BEHIND' }), 0, none);
    assert.deepEqual(behind.blockers.map((b) => b.kind), ['stale-base']);
    assert.match(behind.advice[0] ?? '', /rebase/);
    assert.deepEqual(decide(pr({ mergeState: 'BLOCKED' }), 0, none).blockers.map((b) => b.kind), ['merge-gate']);
    assert.equal(decide(pr({ mergeState: 'BLOCKED', checks: [check('a', 'pending')] }), 0, none).verdict, 'WAITING');
    assert.equal(decide(pr({ mergeState: 'HAS_HOOKS' }), 0, none).verdict, 'READY');
  });

  it('skipped checks do not block', () => {
    assert.equal(decide(pr({ checks: [check('a', 'skipped'), check('b', 'pass')] }), 0, none).verdict, 'READY');
  });

  it('property: READY only when nothing is open, failing, pending or conflicting', () => {
    fc.assert(
      fc.property(prArb, fc.integer({ min: 0, max: 3 }), fc.boolean(), (p, threads, allow) => {
        const failed = p.checks.filter((c) => c.state === 'fail');
        const v = decide(p, threads, triage(failed, p.mergeState, []), { allowNoChecks: allow });
        assert.equal(v.verdict === 'BLOCKED', v.blockers.length > 0);
        assert.equal(v.verdict === 'WAITING', v.blockers.length === 0 && v.waiting.length > 0);
        if (v.verdict !== 'READY') return;
        assert.equal(p.state, 'OPEN');
        assert.equal(p.draft, false);
        assert.equal(threads, 0);
        assert.equal(failed.length, 0);
        assert.ok(!p.checks.some((c) => c.state === 'pending'));
        assert.notEqual(p.mergeable, 'CONFLICTING');
        assert.ok(!['DIRTY', 'BEHIND', 'BLOCKED', 'UNKNOWN'].includes(p.mergeState));
      }),
    );
  });

  it('property: a failure that is not being rerun always blocks', () => {
    fc.assert(
      fc.property(prArb, fc.array(fc.string({ maxLength: 6 }), { maxLength: 3 }), (p, reran) => {
        const failed = p.checks.filter((c) => c.state === 'fail');
        const tri = triage(failed, p.mergeState, reran);
        const v = decide(p, 0, tri);
        if (tri.real.length + tri.stale.length > 0) assert.equal(v.verdict, 'BLOCKED');
        if (p.mergeable === 'CONFLICTING') assert.equal(v.verdict, 'BLOCKED');
      }),
    );
  });

  it('never recommends merging', () => {
    fc.assert(fc.property(prArb, (p) => assert.ok(!/merge (it|the pr)|gh pr merge/i.test(JSON.stringify(decide(p, 0, none))))));
  });
});

describe('blocked', () => {
  it('is a status-query blocker with no pull request by default', () => {
    const v = blocked('gh missing');
    assert.equal(v.verdict, 'BLOCKED');
    assert.deepEqual(v.blockers, [{ kind: 'status-query', detail: 'gh missing' }]);
    assert.equal(v.pr, null);
    assert.equal(blocked('x', { number: 1, url: 'u', sha: 's', base: 'b', head: 'h' }).pr?.number, 1);
  });
});

describe('excerpt', () => {
  it('keeps the tail, strips colour and blank lines', () => {
    const log = ['one', '', '\u001b[31mtwo\u001b[0m', 'three\r', 'four'].join('\n');
    assert.equal(excerpt(log, 2, 1000), 'three\nfour');
    assert.equal(excerpt(log, 99, 1000), 'one\ntwo\nthree\nfour');
  });

  it('is bounded by lines and characters for any input', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 0, max: 20 }), fc.integer({ min: 0, max: 200 }), (log, lines, chars) => {
        const out = excerpt(log, lines, chars);
        assert.ok(out.length <= chars);
        assert.ok(out === '' || out.split('\n').length <= Math.max(1, lines));
        assert.ok(!out.includes('\u001b['));
      }),
    );
  });

  it('handles an empty log', () => {
    assert.equal(excerpt('', 5, 100), '');
  });
});
