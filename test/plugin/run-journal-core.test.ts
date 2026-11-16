import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import {
  MAX_LINE,
  MAX_STRING,
  PHASES,
  STALL_LIMIT,
  countOf,
  countProblem,
  isPhase,
  isRunId,
  makeEvent,
  makeRunId,
  parseJournal,
  progressOf,
  provenCount,
  redactText,
  redactValue,
  roundScores,
  serializeEvent,
  startIsUnattended,
  MAX_PARKED,
  summarize,
  type JournalEvent,
  type Phase,
} from '../../plugins/h7/scripts/run-journal-core.ts';
import { runs } from '../../scripts/test/helpers.ts';

const NOW = new Date('2026-11-16T10:20:30.000Z');
const ev = (phase: Phase, data: Record<string, unknown> = {}): JournalEvent => ({ ts: NOW.toISOString(), phase, data });
const loop = (failing: number, unresolved: number): JournalEvent => ev('loop', { failing, unresolved });

describe('run ids and phases', () => {
  it('accepts plain ids and rejects traversal', () => {
    for (const id of ['20261116-102030-add-login', 'a', 'run_1.2']) assert.ok(isRunId(id), id);
    for (const id of ['', '.hidden', '..', 'a..b', 'a/b', 'a\\b', '-x', 'x'.repeat(81), 'C:\\x', '../x']) assert.ok(!isRunId(id), id);
  });

  it('builds ids from the clock and a task slug', () => {
    assert.equal(makeRunId(NOW, 'Add login: OAuth & SSO!'), '20261116-102030-add-login-oauth-sso');
    assert.equal(makeRunId(NOW, ''), '20261116-102030-run');
    assert.equal(makeRunId(NOW, '***'), '20261116-102030-run');
    const long = makeRunId(NOW, `${'a'.repeat(39)} bbbbbb`);
    assert.equal(long, `20261116-102030-${'a'.repeat(39)}`);
    assert.ok(isRunId(long));
  });

  it('knows its phases', () => {
    for (const phase of PHASES) assert.ok(isPhase(phase));
    assert.ok(!isPhase('deploy'));
  });

  it('property: any task text gives a valid run id', () => {
    fc.assert(fc.property(fc.string(), (task) => isRunId(makeRunId(NOW, task))), { numRuns: runs(300) });
  });
});

describe('redaction', () => {
  it('removes url credentials, tokens, flags and env assignments from text', () => {
    assert.ok(!redactText('git clone https://user:hunter2@example.com/x').includes('hunter2'));
    assert.ok(!redactText('git clone https://ghtokenvalue@example.com/x').includes('ghtokenvalue'));
    assert.ok(!redactText('curl -H "Authorization: Bearer abc123def"').includes('abc123def'));
    assert.ok(!redactText('API_TOKEN=s3cr3tvalue npm test').includes('s3cr3tvalue'));
    assert.ok(!redactText('tool --password hunter2').includes('hunter2'));
    for (const secret of ['ghp_abcdefghijklmnopqrstuvwxyz0123', 'github_pat_abcdefghijklmnopqrstuv', 'sk-abcdefghijklmnopqrstuvwx', 'AKIAABCDEFGHIJKLMNOP', 'xoxb-1234567890-abcdef', 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2']) {
      assert.equal(redactText(`seen ${secret} here`), 'seen [REDACTED] here', secret);
    }
    assert.equal(redactText('plain text'), 'plain text');
  });

  it('redacts nested values and secret-looking keys, keeps the rest', () => {
    const out = redactValue({ ok: 1, nested: { password: 'p', apiKey: 'k', API_TOKEN: 5, cookie: 'c', note: 'see https://u:pw@h/x', list: ['ghp_abcdefghijklmnopqrstuvwxyz0123', 2, null, true] }, token: { inner: 'kept' } });
    assert.deepEqual(out, { ok: 1, nested: { password: '[REDACTED]', apiKey: '[REDACTED]', API_TOKEN: '[REDACTED]', cookie: '[REDACTED]', note: 'see https://[REDACTED]@h/x', list: ['[REDACTED]', 2, null, true] }, token: '[REDACTED]' });
  });


  it('redacts more token shapes, private key blocks, curl user flags and url passwords with slashes or at signs', () => {
    const shapes = ['npm_abcdefghijklmnopqrstuvwxyz0123456789', 'glpat-abcdefghijklmnopqrstu', 'sk_live_abcdefghijklmnopqrstuvwx', 'sk_test_abcdefghijklmnopqrstuvwx', 'AIzaSyabcdefghijklmnopqrstuvwxyz012345'];
    for (const secret of shapes) assert.equal(redactText(`seen ${secret} here`), 'seen [REDACTED] here', secret);
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEabc\ndef==\n-----END RSA PRIVATE KEY-----';
    assert.equal(redactText(`k: ${pem} after`), 'k: [REDACTED] after');
    assert.equal(redactText('k: -----BEGIN PRIVATE KEY-----\nMIIEabc'), 'k: [REDACTED]');
    assert.ok(!redactText('curl -u admin:hunter2 https://h/x').includes('hunter2'));
    assert.ok(!redactText('curl --user admin:hunter2 https://h/x').includes('hunter2'));
    for (const url of ['https://u:p@ss@host/x', 'https://u:p/ss@host/x', 'https://u:p@ss/word@host/x']) assert.equal(redactText(url), 'https://[REDACTED]@host/x', url);
    assert.equal(redactText('see https://example.com/a/b'), 'see https://example.com/a/b');
  });

  it('blanks every value under a secret-named key whatever its type, and redacts secret-looking keys', () => {
    const out = redactValue({ password: { a: 1 }, token: ['x', 2], secret: true, apiKey: null, credential: 7, ok: { fine: true } }) as Record<string, unknown>;
    assert.deepEqual(out, { password: '[REDACTED]', token: '[REDACTED]', secret: '[REDACTED]', apiKey: '[REDACTED]', credential: '[REDACTED]', ok: { fine: true } });
    assert.deepEqual(redactValue({ ghp_abcdefghijklmnopqrstuvwxyz0123: 1, 'https://u:pw@h/x': 2 }), { '[REDACTED]': 1, 'https://[REDACTED]@h/x': 2 });
  });

  it('bounds strings, arrays, keys and depth', () => {
    const long = redactValue('x'.repeat(MAX_STRING + 10)) as string;
    assert.ok(long.endsWith('[truncated 10 chars]'));
    assert.equal((redactValue(Array.from({ length: 500 }, (_, i) => i)) as unknown[]).length, 200);
    assert.equal(Object.keys(redactValue(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`k${i}`, i]))) as object).length, 200);
    let deep: unknown = 'leaf';
    for (let i = 0; i < 12; i += 1) deep = { a: deep };
    assert.ok(JSON.stringify(redactValue(deep)).includes('[too deep]'));
  });

  it('does not let a __proto__ key pollute anything', () => {
    const data = JSON.parse('{"__proto__": {"polluted": true}}') as Record<string, unknown>;
    const out = redactValue(data) as Record<string, unknown>;
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
  });

  it('property: secrets with symbols never reach a serialized event, in urls, flags, assignments or under secret keys', () => {
    const secret = fc.stringMatching(/^[A-Za-z0-9!#$%^&*()_+=[\]{};:,.<>?/@~|-]{12,30}$/);
    fc.assert(
      fc.property(secret, fc.constantFrom('password', 'token', 'apiKey', 'client_secret', 'Authorization'), (value, key) => {
        const line = serializeEvent(
          makeEvent('note', { url: `https://user:${value}@host/p`, cmd: `curl -u user:${value} host`, flag: `tool --password ${value}`, env: `MY_SECRET=${value}`, [key]: value, as_obj: { [key]: { x: value } }, as_list: { [key]: [value, true] } }, NOW),
        );
        assert.ok(!line.includes(value), line);
        assert.ok(!line.includes(JSON.stringify(value).slice(1, -1)), line);
      }),
      { numRuns: runs(500) },
    );
  });

  it('property: known secrets never reach a serialized event', () => {
    const secret = fc.stringMatching(/^[A-Za-z0-9]{20,40}$/);
    fc.assert(
      fc.property(secret, fc.string(), (value, noise) => {
        const line = serializeEvent(makeEvent('note', { text: `${noise} ghp_${value}`, url: `https://user:${value}@host/p`, env: `MY_SECRET=${value}`, password: value, nested: [{ token: value }] }, NOW));
        assert.ok(!line.includes(value), line);
      }),
      { numRuns: runs(300) },
    );
  });
});

describe('event lines', () => {
  it('serializes to one line that parses back', () => {
    const event = makeEvent('decision', { choice: 'a\nb', n: 1 }, NOW);
    const line = serializeEvent(event);
    assert.ok(!line.includes('\n'));
    assert.deepEqual(parseJournal(line).events, [event]);
  });

  it('replaces an oversized event by a preview', () => {
    const big = makeEvent('note', { items: Array.from({ length: 200 }, () => 'y'.repeat(MAX_STRING)) }, NOW);
    const line = serializeEvent(big);
    assert.ok(line.length < MAX_LINE);
    const [parsed] = parseJournal(line).events;
    assert.equal(parsed?.data.truncated, true);
    assert.equal(typeof parsed?.data.chars, 'number');
  });

  it('property: a serialized event is one line, within the cap and valid', () => {
    fc.assert(
      fc.property(fc.constantFrom(...PHASES), fc.dictionary(fc.string(), fc.jsonValue()), (phase, data) => {
        const line = serializeEvent(makeEvent(phase, data, NOW));
        assert.ok(!/[\r\n]/.test(line));
        assert.ok(line.length <= MAX_LINE + 200);
        const parsed = parseJournal(line);
        assert.equal(parsed.events.length, 1);
        assert.equal(parsed.corrupt, 0);
      }),
      { numRuns: runs(300) },
    );
  });
});

describe('parsing a journal', () => {
  it('skips blank lines, counts every kind of unreadable line, keeps order', () => {
    const good = (phase: Phase) => serializeEvent(ev(phase));
    const text = [
      good('research'),
      '',
      '{not json',
      '[1,2]',
      '"str"',
      '{"ts":"nope","phase":"note","data":{}}',
      '{"ts":5,"phase":"note","data":{}}',
      '{"ts":"2026-11-16T10:20:30.000Z","phase":"deploy","data":{}}',
      '{"ts":"2026-11-16T10:20:30.000Z","phase":7,"data":{}}',
      '{"ts":"2026-11-16T10:20:30.000Z","phase":"note","data":[]}',
      '{"ts":"2026-11-16T10:20:30.000Z","phase":"note"}',
      good('verify'),
      '{"ts":"2026-11-16T10:20:30.000Z","phase":"note","da',
    ].join('\r\n');
    const { events, corrupt } = parseJournal(text);
    assert.deepEqual(events.map((e) => e.phase), ['research', 'verify']);
    assert.equal(corrupt, 10);
  });

  it('property: never throws and never invents events', () => {
    fc.assert(
      fc.property(fc.string(), (text) => {
        const { events, corrupt } = parseJournal(text);
        assert.ok(events.length + corrupt <= text.split(/\r?\n/).length);
      }),
      { numRuns: runs(300) },
    );
  });
});

describe('counts', () => {
  it('reads non-negative integers and array lengths only', () => {
    assert.equal(countOf(3), 3);
    assert.equal(countOf(0), 0);
    assert.equal(countOf(['a', 'b']), 2);
    for (const bad of [-1, 1.5, NaN, Infinity, '3', null, undefined, {}, true]) assert.equal(countOf(bad), null);
  });

  it('rejects an invalid or missing count on verify, review and loop events, never on other phases', () => {
    assert.equal(countProblem('loop', { failing: 1, unresolved: ['F1'] }), null);
    assert.equal(countProblem('verify', {}), null);
    assert.equal(countProblem('verify', { failing: 0 }), null);
    assert.equal(countProblem('note', { failing: 'many' }), null);
    for (const data of [{ failing: '3', unresolved: 0 }, { failing: -1, unresolved: 0 }, { failing: 1.5, unresolved: 0 }, { failing: null, unresolved: 0 }, { failing: 0 }, { unresolved: 0 }, { incomplete: 0, unresolved: 0 }, {}]) {
      assert.match(countProblem('loop', data) ?? '', /failing|unresolved/, JSON.stringify(data));
    }
    assert.match(countProblem('verify', { failing: 'x' }) ?? '', /failing/);
    assert.match(countProblem('review', { unresolved: -2 }) ?? '', /unresolved/);
    assert.match(countProblem('review', { failing: 'x', unresolved: 1 }) ?? '', /failing/);
  });

  it('reads proven findings from a proven.json text, null when unusable', () => {
    assert.equal(provenCount('{"kept":[{"id":"F1"},{"id":"F2"}],"rejected":[]}'), 2);
    assert.equal(provenCount('{"kept":[]}'), 0);
    for (const bad of ['', '{', '[]', '{"kept":3}', '{"rejected":[]}', 'null']) assert.equal(provenCount(bad), null, bad);
  });
});

describe('round scores', () => {
  it('has no rounds until a loop event closes one; verify and review events do not score', () => {
    assert.deepEqual(roundScores([ev('verify', { failing: 3 }), ev('review', { unresolved: 1 })]), []);
  });

  it('scores a round from its loop event as failing layers plus unresolved findings, arrays count by length', () => {
    const rounds = roundScores([ev('loop', { failing: ['unit', 'lint'], unresolved: 3 }), ev('implement'), ev('loop', { failing: 1, unresolved: ['F1', 'F2'] })]);
    assert.deepEqual(rounds, [
      { round: 1, failing: 2, unresolved: 3, score: 5, improving: false },
      { round: 2, failing: 1, unresolved: 2, score: 3, improving: true },
    ]);
  });

  it('never turns an invalid or missing count into zero: the round is unknown, not improving and not clean', () => {
    for (const data of [{ failing: '0', unresolved: 0 }, { failing: 0, unresolved: -1 }, { failing: 0 }, { incomplete: 0, unresolved: 0 }, {}]) {
      const [round] = roundScores([ev('loop', data)]);
      assert.deepEqual(round, { round: 1, failing: null, unresolved: null, score: null, improving: false }, JSON.stringify(data));
    }
    const p = progressOf([loop(0, 0), ev('loop', { failing: 'none', unresolved: 0 })]);
    assert.equal(p.clean, false);
    assert.equal(p.streak, 1);
  });

  it('judges a round against the best score so far, not the previous round', () => {
    const rounds = roundScores([loop(5, 0), loop(3, 0), loop(5, 0), loop(3, 0), loop(4, 0), loop(2, 0), loop(0, 0), loop(0, 0)]);
    assert.deepEqual(rounds.map((r) => r.improving), [false, true, false, false, false, true, true, true]);
  });

  it('a first round is a baseline that does not count as an improvement unless it is already zero', () => {
    assert.equal((roundScores([loop(4, 0)])[0] as { improving: boolean }).improving, false);
    assert.equal((roundScores([loop(0, 0)])[0] as { improving: boolean }).improving, true);
  });

  it('an unknown round neither raises nor lowers the best score', () => {
    const rounds = roundScores([loop(3, 0), ev('loop', {}), loop(3, 0), loop(2, 0)]);
    assert.deepEqual(rounds.map((r) => r.improving), [false, false, false, true]);
  });
});

describe('progress', () => {
  const stopFor = (scores: number[]): ReturnType<typeof progressOf> => progressOf(scores.map((s) => loop(s, 0)));

  it('has a reason and does not stop before any round', () => {
    const p = progressOf([]);
    assert.deepEqual({ streak: p.streak, stop: p.stop, clean: p.clean, limit: p.limit }, { streak: 0, stop: false, clean: false, limit: STALL_LIMIT });
    assert.match(p.reason, /no closed round/);
  });

  it('stops after exactly 5 non-improving rounds, the first one included', () => {
    assert.equal(stopFor([4, 4, 4, 4]).stop, false);
    assert.equal(stopFor([4, 4, 4, 4]).streak, 4);
    const p = stopFor([4, 4, 4, 4, 4]);
    assert.equal(p.stop, true);
    assert.equal(p.streak, 5);
    assert.match(p.reason, /stop and report/);
  });

  it('is not defeated by oscillation or by a worse round between better ones', () => {
    assert.equal(stopFor([5, 3, 5, 3, 5, 3, 5, 3]).stop, true);
    assert.equal(stopFor([5, 3, 4, 5, 4, 4, 4]).stop, true);
    assert.equal(stopFor([5, 4, 3, 2, 1]).stop, false);
  });

  it('resets the streak on a new best and honors a lower limit', () => {
    const scores = [3, 3, 3, 2, 2];
    assert.equal(stopFor(scores).streak, 1);
    assert.equal(progressOf(scores.map((s) => loop(s, 0)), 1).stop, true);
    assert.match(stopFor(scores).reason, /1 of 5/);
  });

  it('never lets a limit raise the brake above 5', () => {
    const p = progressOf([4, 4, 4, 4, 4].map((s) => loop(s, 0)), 50);
    assert.equal(p.limit, 5);
    assert.equal(p.stop, true);
  });

  it('reports a clean last round', () => {
    const p = progressOf([loop(2, 0), loop(0, 0)]);
    assert.equal(p.clean, true);
    assert.match(p.reason, /clean/);
  });

  it('cross-checks the reported counts against verify.json and proven.json, and never reports clean on a mismatch', () => {
    const none = { failing: null, unresolved: null, unreadable: [] };
    assert.equal(progressOf([loop(0, 0)], 5, none).clean, true);
    assert.equal(progressOf([loop(0, 0)], 5, { failing: 0, unresolved: 0, unreadable: [] }).clean, true);
    const failing = progressOf([loop(0, 0)], 5, { ...none, failing: 2 });
    assert.equal(failing.clean, false);
    assert.match(failing.warnings.join('\n'), /failing.*0.*verify\.json.*2/);
    const open = progressOf([loop(0, 0)], 5, { ...none, unresolved: 1 });
    assert.equal(open.clean, false);
    assert.match(open.warnings.join('\n'), /unresolved.*0.*proven\.json.*1/);
    const broken = progressOf([loop(0, 0)], 5, { ...none, unreadable: ['.h7/verify.json'] });
    assert.equal(broken.clean, false);
    assert.match(broken.warnings.join('\n'), /unreadable.*verify\.json/);
    assert.match(failing.reason, /verify\.json|disagree|not clean/i);
    const higher = progressOf([loop(3, 0)], 5, { ...none, failing: 1 });
    assert.match(higher.warnings.join('\n'), /failing/);
    assert.equal(progressOf([loop(0, 0)], 5, none).warnings.length, 0);
    const unknown = progressOf([ev('loop', {})], 5, { failing: 1, unresolved: 2, unreadable: [] });
    assert.match(unknown.warnings.join(' | '), /failing unknown.*shows 1 \| .*unresolved unknown.*shows 2/);
    assert.deepEqual(progressOf([]).observed, { failing: null, unresolved: null, unreadable: [] });
  });

  it('property: the streak is the trailing run of rounds that did not beat the best so far', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(6), { maxLength: 25 }), fc.integer({ min: 1, max: 9 }), (scores, limit) => {
        const p = progressOf(scores.map((s) => loop(s, 0)), limit);
        let best: number | null = null;
        const improving = scores.map((s) => {
          const better = s === 0 || (best !== null && s < best);
          best = best === null ? s : Math.min(best, s);
          return better;
        });
        let streak = 0;
        for (let i = improving.length - 1; i >= 0 && !improving[i]; i -= 1) streak += 1;
        assert.equal(p.streak, streak);
        assert.equal(p.limit, Math.min(limit, STALL_LIMIT));
        assert.equal(p.stop, streak >= Math.min(limit, STALL_LIMIT));
        assert.equal(p.rounds.length, scores.length);
      }),
      { numRuns: runs(300) },
    );
  });

  it('property: five consecutive rounds that never beat the best always stop, whatever came before', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 9 }), { maxLength: 8 }), fc.array(fc.integer({ min: 0, max: 5 }), { minLength: 5, maxLength: 5 }), (head, extras) => {
        const best = Math.min(...head, 10);
        const tail = [...extras].sort((x, y) => x - y).map((e) => best + 1 + e);
        const scores = [...head, ...tail];
        assert.equal(progressOf(scores.map((s) => loop(s, 0))).stop, true);
      }),
      { numRuns: runs(300) },
    );
  });

  it('property: a strictly decreasing sequence never stops', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(50), { minLength: 1, maxLength: 20 }), (steps) => {
        let score = 1000;
        const events = steps.map((s) => loop((score -= s + 1), 0));
        assert.equal(progressOf(events).stop, false);
      }),
      { numRuns: runs(200) },
    );
  });
});

describe('summary', () => {
  it('counts phases and keeps the tail', () => {
    const events = [ev('research'), ev('verify'), ev('verify'), ev('loop')];
    assert.deepEqual(summarize(events, 2, 2), { unattended: false, parked: [], events: 4, corrupt: 2, phases: { research: 1, verify: 2, loop: 1 }, last: events.slice(2) });
    assert.equal(summarize(events, 0, 50).last.length, 4);
  });
});

describe('unattended and park helpers', () => {
  it('startIsUnattended is true only for a start note with unattended exactly true', () => {
    const line = (phase: string, data: unknown) => JSON.stringify({ ts: NOW.toISOString(), phase, data });
    assert.equal(startIsUnattended(line('note', { event: 'start', unattended: true })), true);
    for (const bad of [
      line('note', { event: 'start' }),
      line('note', { event: 'start', unattended: 'true' }),
      line('note', { event: 'start', unattended: 1 }),
      line('note', { event: 'other', unattended: true }),
      line('loop', { event: 'start', unattended: true }),
      line('note', null),
      line('note', 'x'),
      'null',
      '[]',
      '{',
      '',
    ]) assert.equal(startIsUnattended(bad), false, bad);
  });

  it('summarize flags an unattended first event and lists parked items, capped at MAX_PARKED', () => {
    const start = ev('note', { event: 'start', unattended: true });
    const parked = Array.from({ length: MAX_PARKED + 3 }, (_, i) => ev('park', { need: `n${i}` }));
    const s = summarize([start, ...parked], 0, 1);
    assert.equal(s.unattended, true);
    assert.equal(s.parked.length, MAX_PARKED);
    assert.equal(s.parked[MAX_PARKED - 1]?.need, `n${MAX_PARKED + 2}`);
    assert.equal(summarize([ev('note', { event: 'start' })], 0, 1).unattended, false);
    assert.equal(summarize([], 0, 1).unattended, false);
  });

  it('progressOf counts parked items and park is a journal phase', () => {
    assert.equal(progressOf([ev('park', {}), loop(1, 0), ev('park', {})]).parked, 2);
    assert.equal(progressOf([]).parked, 0);
    assert.ok(isPhase('park'));
  });
});
