import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import fc from 'fast-check';
import {
  addProposal,
  decideProposal,
  isProposalId,
  listProposals,
  main,
  makeProposal,
  MAX_BODY,
  MAX_FILE,
  MAX_SHORT,
  MAX_TITLE,
  parseProposal,
  proposalsDir,
  type Proposal,
} from '../../plugins/h7/scripts/proposals.ts';
import { cleanupTmp, runNode, runs, SLOW, tmpDir } from '../../scripts/test/helpers.ts';

cleanupTmp();

const NOW = new Date('2026-11-16T10:20:30.000Z');
const later = new Date('2026-11-17T08:00:00.000Z');
const entry = { title: 'Guard should ask on rm -rf in worktrees', body: 'Seen in run 20261101. Add a rule.', source: 'run 20261101', area: 'guard' };

function run(home: string, args: string[], stdin = ''): { code: number; out: string; err: string } {
  let out = '';
  let err = '';
  const code = main(args, { home, now: () => NOW, out: (t) => (out += t), err: (t) => (err += t), stdin: () => stdin });
  return { code, out, err };
}

const queue = (home: string): string => proposalsDir(home);

describe('ids and directory', () => {
  it('proposal ids are single safe path segments', () => {
    for (const id of ['20261116-102030-x', 'a', 'a.b_c-d', 'a-2']) assert.ok(isProposalId(id), id);
    for (const id of ['', '.', '..', '../x', 'a/b', 'a\\b', '.hidden', 'a..b', '-x', 'a b', 'C:x', 'x'.repeat(81)]) assert.ok(!isProposalId(id), id);
  });
  it('the queue lives under <home>/.h7/proposals and needs an absolute home', () => {
    const home = tmpDir();
    assert.equal(proposalsDir(home), join(home, '.h7', 'proposals'));
    assert.throws(() => proposalsDir('relative/home'), /absolute/);
    assert.throws(() => proposalsDir(''), /absolute/);
  });
});

describe('makeProposal and parseProposal', () => {
  it('trims, collapses titles to one line, redacts, and enforces bounds', () => {
    const p = makeProposal({ title: '  Fix\n the   thing ', body: ' token=abcdefabcdefabcdef\nand more ' }, NOW, 'id1');
    assert.deepEqual(p, { id: 'id1', title: 'Fix the thing', body: p.body, source: '', area: '', status: 'pending', created: NOW.toISOString() });
    assert.ok(!p.body.includes('abcdefabcdefabcdef'));
    assert.ok(p.body.includes('\n'));
    assert.throws(() => makeProposal(null, NOW, 'x'), /JSON object/);
    assert.throws(() => makeProposal([], NOW, 'x'), /JSON object/);
    assert.throws(() => makeProposal({ body: 'b' }, NOW, 'x'), /title must be a string/);
    assert.throws(() => makeProposal({ title: ' ', body: 'b' }, NOW, 'x'), /title must not be empty/);
    assert.throws(() => makeProposal({ title: 't', body: 'x'.repeat(MAX_BODY + 1) }, NOW, 'x'), /body is longer/);
    assert.throws(() => makeProposal({ title: 't'.repeat(MAX_TITLE + 1), body: 'b' }, NOW, 'x'), /title is longer/);
    assert.throws(() => makeProposal({ title: 't', body: 'b', source: 3 }, NOW, 'x'), /source must be a string/);
    assert.throws(() => makeProposal({ title: 't', body: 'b', area: 'a'.repeat(MAX_SHORT + 1) }, NOW, 'x'), /area is longer/);
    assert.equal(makeProposal({ title: 't'.repeat(MAX_TITLE), body: 'b'.repeat(MAX_BODY) }, NOW, 'x').title.length, MAX_TITLE);
  });

  it('parseProposal accepts only well-formed records whose id matches the file name', () => {
    const good = makeProposal(entry, NOW, 'p1');
    assert.deepEqual(parseProposal(JSON.stringify(good), 'p1'), good);
    const decided = { ...good, status: 'accepted', decided: 'x', note: 'n' };
    assert.deepEqual(parseProposal(JSON.stringify(decided), 'p1'), decided);
    assert.equal(parseProposal(JSON.stringify(good), 'other'), null);
    assert.equal(parseProposal('{', 'p1'), null);
    assert.equal(parseProposal('null', 'p1'), null);
    assert.equal(parseProposal(JSON.stringify({ ...good, title: 3 }), 'p1'), null);
    assert.equal(parseProposal(JSON.stringify({ ...good, note: 3 }), 'p1'), null);
    assert.equal(parseProposal(JSON.stringify({ ...good, decided: 3 }), 'p1'), null);
    assert.equal(parseProposal(JSON.stringify({ ...good, status: 'done' }), 'p1'), null);
  });
});

describe('queue', () => {
  it('adds proposals as owner-only files, with a collision suffix, and lists them in id order', () => {
    const home = tmpDir();
    assert.deepEqual(listProposals(home), { proposals: [], unreadable: [] });
    const a = addProposal(home, entry, NOW);
    const b = addProposal(home, entry, NOW);
    assert.equal(a.id, '20261116-102030-guard-should-ask-on-rm-rf-in-worktrees');
    assert.equal(b.id, `${a.id}-2`);
    assert.deepEqual(readdirSync(queue(home)).sort(), [`${a.id}-2.json`, `${a.id}.json`]);
    assert.deepEqual(listProposals(home).proposals.map((p) => p.id), [a.id, b.id]);
    if (process.platform !== 'win32') {
      assert.equal(statSync(queue(home)).mode & 0o077, 0);
      assert.equal(statSync(join(queue(home), `${a.id}.json`)).mode & 0o077, 0);
    }
  });

  it('tightens a pre-existing directory and leaves no temp files', () => {
    const home = tmpDir();
    mkdirSync(queue(home), { recursive: true, mode: 0o755 });
    addProposal(home, entry, NOW);
    if (process.platform !== 'win32') assert.equal(statSync(queue(home)).mode & 0o077, 0);
    assert.ok(readdirSync(queue(home)).every((name) => name.endsWith('.json')));
  });

  it('validates before touching the disk', () => {
    const home = tmpDir();
    assert.throws(() => addProposal(home, { title: '' }, NOW), /title/);
    assert.equal(existsSync(join(home, '.h7')), false);
  });

  it('lists corrupt, foreign, linked and oversized files as unreadable and ignores other names', () => {
    const home = tmpDir();
    const good = addProposal(home, entry, NOW);
    const dir = queue(home);
    writeFileSync(join(dir, 'corrupt.json'), '{');
    writeFileSync(join(dir, 'wrong-id.json'), JSON.stringify(good));
    writeFileSync(join(dir, 'big.json'), ' '.repeat(MAX_FILE + 1));
    mkdirSync(join(dir, 'dir.json'));
    symlinkSync(tmpDir(), join(dir, 'link.json'), 'junction');
    writeFileSync(join(dir, 'notes.txt'), 'ignored');
    writeFileSync(join(dir, '.json'), 'ignored');
    writeFileSync(join(dir, 'bad name.json'), 'ignored');
    const { proposals, unreadable } = listProposals(home);
    assert.deepEqual(proposals.map((p) => p.id), [good.id]);
    assert.deepEqual(unreadable.sort(), ['big.json', 'corrupt.json', 'dir.json', 'link.json', 'wrong-id.json']);
  });

  it('refuses a linked .h7 or proposals directory and writes nothing through it', () => {
    const outside = tmpDir();
    const home = tmpDir();
    symlinkSync(outside, join(home, '.h7'), 'junction');
    assert.throws(() => addProposal(home, entry, NOW), /refusing symlink/);
    assert.throws(() => listProposals(home), /refusing symlink/);
    const home2 = tmpDir();
    mkdirSync(join(home2, '.h7'));
    symlinkSync(outside, join(home2, '.h7', 'proposals'), 'junction');
    assert.throws(() => addProposal(home2, entry, NOW), /refusing symlink/);
    assert.throws(() => decideProposal(home2, 'x', 'accepted', '', NOW), /refusing symlink/);
    assert.deepEqual(readdirSync(outside), []);
  });

  it('decides a pending proposal once, with a redacted one-line note', () => {
    const home = tmpDir();
    const { id } = addProposal(home, entry, NOW);
    const done = decideProposal(home, id, 'accepted', ' because\n ghp_abcdefghijklmnopqrstuvwxyz0123456789 ', later);
    assert.deepEqual([done.status, done.decided], ['accepted', later.toISOString()]);
    assert.ok(!(done.note as string).includes('ghp_') && !(done.note as string).includes('\n'));
    assert.equal(listProposals(home).proposals[0]?.status, 'accepted');
    assert.throws(() => decideProposal(home, id, 'rejected', '', later), /already accepted/);
    const other = addProposal(home, { ...entry, title: 'second' }, NOW);
    assert.equal(decideProposal(home, other.id, 'rejected', '', later).note, undefined);
    assert.throws(() => decideProposal(home, '../x', 'accepted', '', later), /bad proposal id/);
    assert.throws(() => decideProposal(home, 'nope', 'accepted', '', later), /no such proposal/);
    assert.deepEqual(readdirSync(queue(home)).filter((name) => name.endsWith('.tmp')), []);
  });

  it('property: whatever is proposed, only files directly inside the queue are written and no secret survives', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), fc.string({ maxLength: 200 }), (title, body) => {
        const home = tmpDir('h7-prop-');
        let made: Proposal;
        try {
          made = addProposal(home, { title: `${title} ${secret}`, body: `${body} ${secret}` }, NOW);
        } catch (error) {
          return /title|body/.test((error as Error).message) && !existsSync(join(home, '.h7'));
        }
        const files = readdirSync(queue(home));
        return (
          readdirSync(home).join() === '.h7' &&
          readdirSync(join(home, '.h7')).join() === 'proposals' &&
          files.join() === `${made.id}.json` &&
          isProposalId(made.id) &&
          !readFileSync(join(queue(home), files[0] as string), 'utf8').includes(secret)
        );
      }),
      { numRuns: runs(25) },
    );
  });
});

describe('main', () => {
  it('adds from an argument or stdin, lists with a filter, shows, accepts and rejects', () => {
    const home = tmpDir();
    const added = JSON.parse(run(home, ['add', JSON.stringify(entry)]).out);
    assert.equal(added.status, 'pending');
    const second = JSON.parse(run(home, ['add', '-'], JSON.stringify({ ...entry, title: 'another idea' })).out);
    assert.equal(JSON.parse(run(home, ['list']).out).proposals.length, 2);
    assert.deepEqual(JSON.parse(run(home, ['show', added.id]).out).title, entry.title);
    const accepted = run(home, ['accept', added.id, '--note', 'do it']);
    assert.deepEqual([accepted.code, JSON.parse(accepted.out).status], [0, 'accepted']);
    assert.equal(JSON.parse(run(home, ['reject', second.id]).out).status, 'rejected');
    assert.deepEqual(JSON.parse(run(home, ['list', '--status', 'accepted']).out).proposals.map((p: Proposal) => p.id), [added.id]);
    assert.equal(JSON.parse(run(home, ['list', '--status', 'pending']).out).proposals.length, 0);
    assert.equal(JSON.parse(run(home, ['show', added.id]).out).note, 'do it');
  });

  it('reports usage errors and failures with exit 2 and writes nothing', () => {
    const home = tmpDir();
    for (const args of [[], ['nope'], ['add'], ['add', '{}', 'x'], ['list', 'x'], ['list', '--status', 'weird'], ['list', '--bogus', '1'], ['list', '--status'], ['show'], ['show', 'a', 'b'], ['accept'], ['accept', 'a', 'b'], ['reject', '--note']]) {
      const result = run(home, args);
      assert.equal(result.code, 2, args.join(' '));
      assert.match(result.err, /usage|option|missing/, args.join(' '));
    }
    assert.match(run(home, ['add', '{']).err, /not valid JSON/);
    assert.match(run(home, ['add', '{"title":"t"}']).err, /body must be a string/);
    assert.match(run(home, ['show', '../x']).err, /bad proposal id/);
    assert.match(run(home, ['show', 'missing']).err, /no such proposal/);
    assert.match(run(home, ['accept', 'missing']).err, /no such proposal/);
    assert.match(run('relative', ['list']).err, /absolute/);
    assert.equal(existsSync(join(home, '.h7')), false);
  });

  it('turns an unexpected filesystem failure into exit 2', () => {
    const home = tmpDir();
    mkdirSync(join(home, '.h7'));
    writeFileSync(join(home, '.h7', 'proposals'), 'a file where the queue belongs');
    const result = run(home, ['add', JSON.stringify(entry)]);
    assert.equal(result.code, 2);
    assert.match(result.err, /proposals failed/);
  });

  it('runs as a CLI and honours H7_HOME', SLOW, () => {
    const home = tmpDir();
    const script = join(import.meta.dirname, '../../plugins/h7/scripts/proposals.ts');
    const added = runNode(script, ['add', '-'], { env: { H7_HOME: home }, input: JSON.stringify(entry) });
    assert.equal(added.status, 0, added.stderr);
    assert.equal(readdirSync(queue(home)).length, 1);
    assert.equal(JSON.parse(runNode(script, ['list'], { env: { H7_HOME: home } }).stdout).proposals.length, 1);
    assert.equal(runNode(script, ['nope'], { env: { H7_HOME: home } }).status, 2);
    assert.equal(runNode(script, ['nope'], { env: { H7_HOME: undefined } }).status, 2);
  });
});

describe('note redaction', () => {
  it('redacts a note before cutting it to length, so a secret on the boundary cannot leak a prefix', () => {
    const home = tmpDir();
    const { id } = addProposal(home, entry, NOW);
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const done = decideProposal(home, id, 'accepted', `${'x'.repeat(MAX_SHORT - 8)} ${secret}`, later);
    assert.ok(!(done.note as string).includes('ghp_'), done.note);
    assert.ok((done.note as string).length <= MAX_SHORT);
  });
});
