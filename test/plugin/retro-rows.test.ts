import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import {
  addRows,
  cell,
  collectSignals,
  insertRows,
  KINDS,
  main,
  MAX_CELL,
  parseCandidates,
  parseStore,
  serializeStore,
  signalsOf,
  STORE,
  type Candidate,
  type Row,
} from '../../plugins/h7/scripts/retro-rows.ts';
import { cleanupTmp, runNode, SLOW, tmpDir, writeTree } from '../../scripts/test/helpers.ts';

cleanupTmp();

const candidate = (rule: string, extra: Partial<Candidate> = {}): Candidate => ({ rule, enforcer: '`test/x.test.ts`', kind: 'test', evidence: 'run 20261101: reverted twice', ...extra });
const row = (id: string, rule: string, status: Row['status'] = 'pending'): Row => ({ ...candidate(rule), id, status });

const TABLE = '## Rule <-> enforcer\n\n| Rule | Enforcer |\n|---|---|\n| Existing rule | `lint` |\n';

function repo(files: Record<string, string> = {}): string {
  const root = tmpDir();
  mkdirSync(join(root, '.git', 'info'), { recursive: true });
  writeTree(root, files);
  return root;
}

function run(cwd: string, args: string[], stdin = ''): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const code = main(args, { out: (t) => (out += t), err: (t) => (err += t), stdin: () => stdin, cwd });
  return { code, out, err };
}

describe('candidates', () => {
  it('cell redacts secrets, collapses whitespace and bounds length', () => {
    assert.equal(cell('  a \n b\t c ', 'x'), 'a b c');
    assert.match(cell('use ghp_abcdefghijklmnopqrstuvwxyz0123456789 here', 'x'), /\[REDACTED\]/);
    assert.throws(() => cell(1, 'rule'), /rule must be a string/);
    assert.throws(() => cell('  ', 'rule'), /rule must not be empty/);
    assert.throws(() => cell('a'.repeat(MAX_CELL + 1), 'rule'), /longer than/);
    assert.equal(cell('a'.repeat(MAX_CELL), 'rule').length, MAX_CELL);
  });
  it('parseCandidates is all or nothing and names the bad row', () => {
    assert.throws(() => parseCandidates({}), /non-empty JSON array/);
    assert.throws(() => parseCandidates([]), /non-empty JSON array/);
    assert.throws(() => parseCandidates([null]), /row 1: kind/);
    assert.throws(() => parseCandidates([[]]), /row 1: kind/);
    assert.throws(() => parseCandidates([candidate('a'), { ...candidate('b'), kind: 'magic' }]), /row 2: kind must be one of architecture, types, lint, test, prose/);
    assert.throws(() => parseCandidates([{ ...candidate('a'), enforcer: '' }]), /row 1: enforcer must not be empty/);
    assert.throws(() => parseCandidates([{ ...candidate('a'), evidence: 3 }]), /row 1: evidence must be a string/);
    assert.deepEqual(parseCandidates([candidate(' a | b ')]), [candidate('a | b')]);
  });
  it('property: accepted candidates are single-line bounded strings of a known kind', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.constantFrom(...KINDS), fc.string(), (rule, enforcer, kind, evidence) => {
        try {
          const [c] = parseCandidates([{ rule, enforcer, kind, evidence }]) as [Candidate];
          return [c.rule, c.enforcer, c.evidence].every((s) => s !== '' && s.length <= MAX_CELL && !/[\r\n]/.test(s)) && KINDS.includes(c.kind);
        } catch (error) {
          return /must (not be empty|be a string)|longer than/.test((error as Error).message);
        }
      }),
    );
  });
});

describe('store', () => {
  it('round trips and rejects anything malformed', () => {
    assert.deepEqual(parseStore(null), []);
    const rows = [row('r1', 'a'), row('r2', 'b', 'applied')];
    assert.deepEqual(parseStore(serializeStore(rows)), rows);
    assert.throws(() => parseStore('{'), /not valid JSON/);
    assert.throws(() => parseStore('null'), /no rows list/);
    assert.throws(() => parseStore('{"rows":3}'), /no rows list/);
    assert.throws(() => parseStore('{"rows":[3]}'), /malformed row/);
    assert.throws(() => parseStore(JSON.stringify({ rows: [{ ...row('x1', 'a') }] })), /malformed row/);
    assert.throws(() => parseStore(JSON.stringify({ rows: [{ ...row('r1', 'a'), status: 'done' }] })), /malformed row/);
    assert.throws(() => parseStore(JSON.stringify({ rows: [{ ...row('r1', 'a'), kind: 'x' }] })), /kind must be/);
  });
  it('addRows numbers on, skips duplicates but not rejected ones', () => {
    const base = [row('r1', 'Same Rule'), row('r4', 'gone', 'rejected')];
    const next = addRows(base, [candidate('same  rule'), candidate('gone'), candidate('fresh')]);
    assert.deepEqual(next.added, ['r5', 'r6']);
    assert.deepEqual(next.duplicates, ['r1']);
    assert.deepEqual(next.rows.map((r) => r.id), ['r1', 'r4', 'r5', 'r6']);
    assert.equal(next.rows[2]?.status, 'pending');
    assert.deepEqual(addRows([], [candidate('a')]).added, ['r1']);
    assert.equal(base.length, 2);
  });
});

describe('insertRows', () => {
  const rows = [row('r1', 'New rule'), row('r2', 'Other | pipe')];
  it('adds rows after the last table row and keeps everything else', () => {
    const doc = `# Doc\n\n${TABLE}\nmore text\n`;
    const r = insertRows(doc, rows, false, null);
    assert.equal(r.status, 'updated');
    assert.deepEqual(r.added, ['r1', 'r2']);
    assert.equal(r.text, `# Doc\n\n## Rule <-> enforcer\n\n| Rule | Enforcer |\n|---|---|\n| Existing rule | \`lint\` |\n| New rule | \`test/x.test.ts\` |\n| Other \\| pipe | \`test/x.test.ts\` |\n\nmore text\n`);
    assert.equal(insertRows(r.text, rows, false, null).status, 'unchanged');
    assert.deepEqual(insertRows(r.text, rows, false, null).exists, ['r1', 'r2']);
  });
  it('matches the heading at any level, recognises existing rules case-insensitively, keeps CRLF', () => {
    const doc = '### rule <-> Enforcer\r\n\r\n| Rule | Enforcer |\r\n|---|---|\r\n| NEW  rule | x |';
    const r = insertRows(doc, [row('r1', 'new rule'), row('r2', 'b')], false, null);
    assert.deepEqual(r.exists, ['r1']);
    assert.equal(r.text, `${doc}\r\n| b | \`test/x.test.ts\` |`);
  });
  it('never touches a document without a table unless asked to create one', () => {
    for (const doc of ['# Doc\n', '## Rule <-> enforcer\n\nnothing\n', '## Rule <-> enforcer\n## Next\n| a | b |\n']) {
      const r = insertRows(doc, rows, false, null);
      assert.deepEqual({ status: r.status, text: r.text }, { status: 'no-table', text: doc });
    }
    assert.equal(insertRows('## Rule <-> enforcer\n\nnothing\n', rows, true, null).status, 'no-table');
    assert.equal(insertRows('x', [], false, null).status, 'unchanged');
  });
  it('create appends a new section with a header row', () => {
    const r = insertRows('# Verification\n\ntext\n', [row('r1', 'a')], true, null);
    assert.equal(r.text, '# Verification\n\ntext\n\n## Rule <-> enforcer\n\n| Rule | Enforcer |\n|---|---|\n| a | `test/x.test.ts` |\n');
    assert.equal(insertRows('', [row('r1', 'a')], true, null).text, '## Rule <-> enforcer\n\n| Rule | Enforcer |\n|---|---|\n| a | `test/x.test.ts` |\n');
    assert.equal(insertRows(r.text, [row('r1', 'a')], true, null).status, 'unchanged');
  });
  it('refuses to grow a limited file past its limit, but allows files that are not growing', () => {
    const filler = 'l\n'.repeat(140);
    const doc = `${filler}${TABLE}`;
    assert.equal(insertRows(doc, rows, false, 145).status, 'oversize');
    assert.equal(insertRows(doc, rows, false, 145).text, doc);
    assert.equal(insertRows(doc, rows, false, 150).status, 'updated');
    assert.equal(insertRows(doc, rows, false, null).status, 'updated');
    assert.equal(insertRows(doc, [row('r1', 'Existing rule')], false, 1).status, 'unchanged');
  });
  it('property: every other line survives and a second insert changes nothing', () => {
    const rule = fc.stringMatching(/^[a-zA-Z][a-zA-Z0-9 |.-]{0,30}$/);
    fc.assert(
      fc.property(fc.array(rule, { minLength: 1, maxLength: 6 }), (rules) => {
        const items = rules.map((text, i) => row(`r${i + 1}`, text));
        const once = insertRows(TABLE, items, false, null);
        const twice = insertRows(once.text, items, false, null);
        const kept = TABLE.split('\n').every((line) => once.text.split('\n').includes(line));
        return kept && twice.text === once.text && twice.added.length === 0 && once.added.length + once.exists.length === items.length;
      }),
    );
  });
});

describe('signals', () => {
  const at = (n: number): string => `2026-11-1${n}T10:00:00.000Z`;
  const line = (n: number, phase: string, data: unknown): string => JSON.stringify({ ts: at(n), phase, data });
  const journal = [
    line(1, 'note', { event: 'start', task: 'fix parser' }),
    line(1, 'verify', { failing: 2, layers: ['unit: failing (x)'] }),
    line(2, 'review', { unresolved: ['F1', 'F2'], ids: ['F1', 'F2'] }),
    line(2, 'loop', { round: 1, failing: 2, unresolved: 2 }),
    line(3, 'loop', { round: 2, failing: 2, unresolved: 2 }),
    line(3, 'verify', { failing: 0 }),
    line(3, 'decision', { question: 'q', choice: 'c' }),
    line(3, 'note', { text: 'user corrected the plan' }),
    '{torn',
  ].join('\n');
  it('picks out failures, stalled rounds, decisions and notes', () => {
    const s = signalsOf('r1', journal);
    assert.equal(s.task, 'fix parser');
    assert.equal(s.corrupt, 1);
    assert.deepEqual(s.verifyFailures, [{ ts: at(1), failing: 2, layers: ['unit: failing (x)'] }]);
    assert.deepEqual(s.unresolvedFindings, [{ ts: at(2), unresolved: 2, ids: ['F1', 'F2'] }]);
    assert.deepEqual(s.stalledRounds.at(-1), { round: 2, score: 4 });
    assert.deepEqual(s.decisions, [{ question: 'q', choice: 'c' }]);
    assert.deepEqual(s.notes, [{ text: 'user corrected the plan' }]);
  });
  it('is empty and safe for an empty or taskless journal', () => {
    const s = signalsOf('r1', line(1, 'note', { event: 'start', task: 5 }) + '\n' + line(1, 'verify', { failing: 'many' }) + '\n' + line(1, 'review', {}));
    assert.deepEqual([s.task, s.verifyFailures, s.unresolvedFindings, s.stalledRounds], ['', [], [], []]);
    assert.equal(signalsOf('r1', '').events, 0);
  });
  it('collectSignals reads the newest journals and skips links, files and missing journals', () => {
    const root = repo();
    assert.deepEqual(collectSignals(root, 5), []);
    const ids = ['20261101-100000-a', '20261102-100000-b', '20261103-100000-c', '20261104-100000-d', '20261105-100000-e'];
    for (const id of ids.slice(0, 3)) writeTree(root, { [`.h7/runs/${id}/journal.jsonl`]: line(1, 'note', { event: 'start', task: id }) });
    mkdirSync(join(root, '.h7/runs', ids[3] as string));
    writeFileSync(join(root, '.h7/runs', ids[4] as string), 'not a dir');
    writeFileSync(join(root, '.h7/runs/not a run id'), 'x');
    assert.deepEqual(collectSignals(root, 5).map((s) => s.id), ids.slice(0, 3));
    assert.deepEqual(collectSignals(root, 2).map((s) => s.id), ids.slice(1, 3));
  });
  it('collectSignals never follows links', () => {
    const root = repo();
    const outside = tmpDir();
    writeTree(outside, { 'journal.jsonl': line(1, 'note', { event: 'start', task: 'outside' }) });
    mkdirSync(join(root, '.h7/runs/20261101-100000-a'), { recursive: true });
    symlinkSync(outside, join(root, '.h7/runs/20261101-100000-a/journal.jsonl'), 'junction');
    mkdirSync(join(root, '.h7/runs/20261102-100000-b/journal.jsonl'), { recursive: true });
    assert.deepEqual(collectSignals(root, 5), []);
    const other = repo();
    mkdirSync(join(other, '.h7'));
    symlinkSync(outside, join(other, '.h7/runs'), 'junction');
    assert.deepEqual(collectSignals(other, 5), []);
  });
});

describe('main', () => {
  it('rejects bad usage and non-repositories', () => {
    const root = repo();
    assert.equal(run(root, []).code, 2);
    assert.match(run(root, ['nope']).err, /usage/);
    assert.match(run(root, ['list', '--bogus']).err, /unknown option --bogus/);
    assert.match(run(tmpDir(), ['list']).err, /not inside a git repository/);
    assert.match(run(root, ['signals', '--limit', '0']).err, /positive integer/);
    assert.match(run(root, ['signals', '--limit']).err, /positive integer/);
    assert.match(run(root, ['propose', '{']).err, /not valid JSON/);
    assert.match(run(root, ['apply']).err, /at least one row id/);
    assert.match(run(root, ['apply', 'r9']).err, /no such row: r9/);
  });

  it('signals prints the runs', () => {
    const root = repo({ '.h7/runs/20261101-100000-a/journal.jsonl': JSON.stringify({ ts: '2026-11-11T10:00:00.000Z', phase: 'note', data: { event: 'start', task: 'x' } }) });
    const out = JSON.parse(run(root, ['signals', '--limit', '3']).out);
    assert.equal(out.runs[0].task, 'x');
    assert.equal(JSON.parse(run(root, ['signals']).out).runs.length, 1);
  });

  it('propose stores pending rows, git-excludes .h7, redacts, and never adds duplicates', () => {
    const root = repo();
    const body = JSON.stringify([candidate('rule one'), { ...candidate('rule two'), evidence: 'token=abcdefabcdefabcdef leaked' }]);
    const first = run(root, ['propose', '-'], body);
    assert.deepEqual(JSON.parse(first.out), { added: ['r1', 'r2'], duplicates: [] });
    assert.equal(first.code, 0);
    const stored = readFileSync(join(root, STORE), 'utf8');
    assert.ok(!stored.includes('abcdefabcdefabcdef'));
    assert.match(readFileSync(join(root, '.git/info/exclude'), 'utf8'), /^\.h7\/$/m);
    assert.deepEqual(readdirSync(join(root, '.h7/retro')), ['rows.json']);
    const again = run(root, ['propose', body]);
    assert.deepEqual(JSON.parse(again.out), { added: [], duplicates: ['r1', 'r2'] });
    assert.equal(readFileSync(join(root, STORE), 'utf8'), stored);
    assert.equal(JSON.parse(run(root, ['list']).out).pending, 2);
    assert.match(run(root, ['propose', '[{"rule":"x"}]']).err, /kind must be/);
  });

  it('propose works in a worktree-style repo whose .git is a file, and refuses a link out of the repo', () => {
    const wt = tmpDir();
    writeFileSync(join(wt, '.git'), 'gitdir: elsewhere');
    assert.equal(run(wt, ['propose', JSON.stringify([candidate('a')])]).code, 0);
    assert.ok(existsSync(join(wt, STORE)));
    const root = repo();
    const outside = tmpDir();
    symlinkSync(outside, join(root, '.h7'), 'junction');
    const result = run(root, ['propose', JSON.stringify([candidate('a')])]);
    assert.equal(result.code, 2);
    assert.match(result.err, /outside the repo|symlink/);
    assert.deepEqual(readdirSync(outside), []);
  });

  it('reject marks rows, and a rejected row can never be applied', () => {
    const root = repo({ 'AGENTS.md': TABLE });
    run(root, ['propose', JSON.stringify([candidate('a'), candidate('b')])]);
    assert.deepEqual(JSON.parse(run(root, ['reject', 'r1', 'r1']).out), { rejected: ['r1'] });
    assert.match(run(root, ['apply', 'r1', '--write']).err, /r1 was rejected/);
    assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), TABLE);
    assert.equal(JSON.parse(run(root, ['list']).out).pending, 1);
    run(root, ['apply', 'r2', '--write']);
    assert.match(run(root, ['reject', 'r2']).err, /applied row cannot be rejected/);
  });

  it('apply is a dry run until --write, writes only the named rows, and is idempotent', () => {
    const root = repo({ 'AGENTS.md': TABLE });
    run(root, ['propose', JSON.stringify([candidate('a'), candidate('b'), candidate('c')])]);
    const dry = run(root, ['apply', 'r1', 'r2']);
    assert.deepEqual(JSON.parse(dry.out), { file: 'AGENTS.md', status: 'updated', written: false, added: ['r1', 'r2'], exists: [], alreadyApplied: [] });
    assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), TABLE);
    assert.equal(JSON.parse(run(root, ['list']).out).pending, 3);
    const done = JSON.parse(run(root, ['apply', 'r1', '--write']).out);
    assert.deepEqual([done.written, done.added], [true, ['r1']]);
    const text = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    assert.ok(text.includes('| a |') && !text.includes('| b |') && !text.includes('| c |'));
    const again = JSON.parse(run(root, ['apply', 'r1', 'r2', '--write']).out);
    assert.deepEqual([again.added, again.alreadyApplied], [['r2'], ['r1']]);
    assert.equal(JSON.parse(run(root, ['list']).out).pending, 1);
    assert.deepEqual(readdirSync(root).filter((name) => name.endsWith('.h7tmp')), []);
  });

  it('apply marks rows already in the table as applied without rewriting the file', () => {
    const root = repo({ 'AGENTS.md': TABLE });
    run(root, ['propose', JSON.stringify([candidate('Existing rule')])]);
    const result = JSON.parse(run(root, ['apply', 'r1', '--write']).out);
    assert.deepEqual([result.status, result.written, result.exists], ['unchanged', true, ['r1']]);
    assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), TABLE);
    assert.equal(JSON.parse(run(root, ['list']).out).pending, 0);
  });

  it('apply exits 1 and writes nothing without a table or past the line limit, and --create adds one', () => {
    const root = repo({ 'AGENTS.md': '# nothing\n', 'docs/agents/verification.md': '# Verification\n', 'big/AGENTS.md': `${'l\n'.repeat(148)}${TABLE}` });
    run(root, ['propose', JSON.stringify([candidate('a')])]);
    const none = run(root, ['apply', 'r1', '--write']);
    assert.equal(none.code, 1);
    assert.equal(JSON.parse(none.out).status, 'no-table');
    assert.equal(readFileSync(join(root, 'AGENTS.md'), 'utf8'), '# nothing\n');
    assert.equal(run(root, ['apply', 'r1', '--file', 'big/AGENTS.md', '--write']).code, 1);
    assert.equal(JSON.parse(run(root, ['list']).out).pending, 1);
    const created = run(root, ['apply', 'r1', '--file', 'docs/agents/verification.md', '--create', '--write']);
    assert.equal(created.code, 0);
    assert.match(readFileSync(join(root, 'docs/agents/verification.md'), 'utf8'), /## Rule <-> enforcer[\s\S]*\| a \|/);
  });

  it('apply refuses missing files, paths outside the repo and corrupt stores', () => {
    const root = repo();
    run(root, ['propose', JSON.stringify([candidate('a')])]);
    assert.match(run(root, ['apply', 'r1', '--file', 'AGENTS.md']).err, /cannot read AGENTS\.md/);
    assert.match(run(root, ['apply', 'r1', '--file', '../x.md']).err, /outside the repo/);
    writeFileSync(join(root, STORE), '{');
    assert.match(run(root, ['list']).err, /not valid JSON/);
    assert.match(run(root, ['propose', JSON.stringify([candidate('b')])]).err, /not valid JSON/);
  });

  it('reports an unexpected failure instead of throwing', () => {
    const root = repo();
    mkdirSync(join(root, '.h7'));
    writeFileSync(join(root, '.h7/retro'), 'a file where a directory belongs');
    const result = run(root, ['propose', JSON.stringify([candidate('a')])]);
    assert.equal(result.code, 2);
    assert.match(result.err, /retro-rows failed/);
  });

  it('runs as a CLI', SLOW, () => {
    const root = repo({ 'AGENTS.md': TABLE });
    const script = join(import.meta.dirname, '../../plugins/h7/scripts/retro-rows.ts');
    const proposed = runNode(script, ['propose', '-'], { cwd: root, input: JSON.stringify([candidate('cli rule')]) });
    assert.equal(proposed.status, 0, proposed.stderr);
    assert.equal(runNode(script, ['apply', 'r1', '--write'], { cwd: root }).status, 0);
    assert.match(readFileSync(join(root, 'AGENTS.md'), 'utf8'), /cli rule/);
    assert.equal(runNode(script, ['nope'], { cwd: root }).status, 2);
  });
});

describe('review fixes', () => {
  it('apply --file only edits existing markdown files outside .git', () => {
    const root = repo({ 'package.json': '{}\n', '.git/hooks/pre-commit': '#!/bin/sh\n', 'docs/Notes.MD': TABLE, 'docs/x.txt': TABLE, '.GIT/x.md': TABLE });
    run(root, ['propose', JSON.stringify([candidate('a')])]);
    for (const file of ['package.json', '.git/hooks/pre-commit', 'docs/x.txt', '.GIT/x.md', '.git/info/exclude.md']) {
      const result = run(root, ['apply', 'r1', '--file', file, '--create', '--write']);
      assert.equal(result.code, 2, file);
      assert.match(result.err, /only markdown files/, file);
    }
    assert.equal(readFileSync(join(root, 'package.json'), 'utf8'), '{}\n');
    assert.equal(readFileSync(join(root, '.git/hooks/pre-commit'), 'utf8'), '#!/bin/sh\n');
    assert.equal(run(root, ['apply', 'r1', '--file', 'docs/Notes.MD', '--write']).code, 0);
    assert.match(readFileSync(join(root, 'docs/Notes.MD'), 'utf8'), /\| a \|/);
  });

  it('the 150-line cap applies whatever the case of the file name', () => {
    const big = `${'l\n'.repeat(148)}${TABLE}`;
    const root = repo({ 'agents.md': big, 'Claude.MD': big });
    run(root, ['propose', JSON.stringify([candidate('a')])]);
    for (const file of ['agents.md', 'Claude.MD']) assert.equal(run(root, ['apply', 'r1', '--file', file, '--write']).code, 1, file);
  });

  it('row ids have at most 6 digits and are unique', () => {
    const base = row('r1', 'a');
    assert.throws(() => parseStore(serializeStore([{ ...base, id: 'r1234567' }])), /malformed row/);
    assert.equal(parseStore(serializeStore([{ ...base, id: 'r123456' }])).length, 1);
    assert.throws(() => parseStore(serializeStore([base, { ...row('r1', 'b') }])), /malformed row/);
  });

  it('cells neutralise comment openers and dedupe agrees with escaping', () => {
    assert.ok(!cell('x <!-- h7:end --> y', 'x').includes('<!--'));
    const tricky = [row('r1', 'a\\|b'), row('r2', 'c | d'), row('r3', 'e\\')];
    const once = insertRows(TABLE, tricky, false, null);
    assert.deepEqual(once.added, ['r1', 'r2', 'r3']);
    const twice = insertRows(once.text, tricky, false, null);
    assert.deepEqual([twice.status, twice.exists], ['unchanged', ['r1', 'r2', 'r3']]);
  });
});
