import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import {
  MAX_LINE,
  MAX_STRING,
  PHASES,
  STALL_LIMIT,
  countOf,
  isPhase,
  isRunId,
  makeEvent,
  makeRunId,
  parseJournal,
  progressOf,
  redactText,
  redactValue,
  roundScores,
  serializeEvent,
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
    assert.deepEqual(out, { ok: 1, nested: { password: '[REDACTED]', apiKey: '[REDACTED]', API_TOKEN: '[REDACTED]', cookie: '[REDACTED]', note: 'see https://[REDACTED]@h/x', list: ['[REDACTED]', 2, null, true] }, token: { inner: 'kept' } });
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
    for (const bad of [-1, 1.5, NaN, '3', null, undefined, {}, true]) assert.equal(countOf(bad), null);
  });
});

describe('round scores', () => {
  it('has no rounds until a loop event closes one', () => {
    assert.deepEqual(roundScores([ev('verify', { failing: 3 }), ev('review', { unresolved: 1 })]), []);
  });

  it('scores a round as failing layers plus unresolved findings, the first round is a baseline', () => {
    const rounds = roundScores([ev('verify', { failing: ['unit', 'lint'] }), ev('review', { unresolved: 3 }), ev('loop'), ev('implement'), ev('verify', { failing: 1 }), ev('loop')]);
    assert.deepEqual(rounds, [
      { round: 1, failing: 2, unresolved: 3, score: 5, improving: true },
      { round: 2, failing: 1, unresolved: 3, score: 4, improving: true },
    ]);
  });

  it('carries a figure over when a round does not report it, and ignores junk and other phases', () => {
    const rounds = roundScores([ev('verify', { failing: 2 }), ev('loop', { unresolved: 'many' }), ev('note', { failing: 0 }), ev('review', { unresolved: -4 }), ev('loop')]);
    assert.deepEqual(rounds.map((r) => r.score), [2, 2]);
    assert.deepEqual(rounds.map((r) => r.improving), [true, false]);
  });

  it('counts equal and higher scores as not improving, and zero as improving', () => {
    const rounds = roundScores([loop(2, 0), loop(2, 0), loop(3, 0), loop(0, 0), loop(0, 0)]);
    assert.deepEqual(rounds.map((r) => r.improving), [true, false, false, true, true]);
  });
});

describe('progress', () => {
  it('has a reason and does not stop before any round', () => {
    const p = progressOf([]);
    assert.deepEqual({ streak: p.streak, stop: p.stop, clean: p.clean, limit: p.limit }, { streak: 0, stop: false, clean: false, limit: STALL_LIMIT });
    assert.match(p.reason, /no closed round/);
  });

  it('stops after 5 non-improving rounds after the baseline round', () => {
    const rounds = [loop(2, 1), ...Array.from({ length: 5 }, () => loop(2, 1))];
    assert.equal(progressOf(rounds.slice(0, 5)).stop, false);
    assert.equal(progressOf(rounds.slice(0, 5)).streak, 4);
    const p = progressOf(rounds);
    assert.equal(p.stop, true);
    assert.equal(p.streak, 5);
    assert.match(p.reason, /stop and report/);
  });

  it('resets the streak on a decrease and honors a custom limit', () => {
    const events = [loop(3, 0), loop(3, 0), loop(3, 0), loop(2, 0), loop(2, 0)];
    assert.equal(progressOf(events).streak, 1);
    assert.equal(progressOf(events, 1).stop, true);
    assert.match(progressOf(events).reason, /1 of 5/);
  });

  it('reports a clean last round', () => {
    const p = progressOf([loop(2, 0), loop(0, 0)]);
    assert.equal(p.clean, true);
    assert.match(p.reason, /clean/);
  });

  it('property: stop exactly when the trailing run of non-decreases reaches the limit', () => {
    fc.assert(
      fc.property(fc.array(fc.nat(6), { maxLength: 25 }), fc.integer({ min: 1, max: 6 }), (scores, limit) => {
        const p = progressOf(scores.map((s) => loop(s, 0)), limit);
        let streak = 0;
        for (let i = scores.length - 1; i >= 1; i -= 1) {
          const score = scores[i] as number;
          if (score < (scores[i - 1] as number) || score === 0) break;
          streak += 1;
        }
        assert.equal(p.streak, streak);
        assert.equal(p.stop, streak >= limit);
        assert.equal(p.rounds.length, scores.length);
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
    assert.deepEqual(summarize(events, 2, 2), { events: 4, corrupt: 2, phases: { research: 1, verify: 2, loop: 1 }, last: events.slice(2) });
    assert.equal(summarize(events, 0, 50).last.length, 4);
  });
});
