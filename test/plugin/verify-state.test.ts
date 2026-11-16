import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { cleanupTmp, tmpDir } from '../../scripts/test/helpers.ts';
import { LAYERS, STATE_FILE, freshState, incomplete, main, parseState, realStateIo, setLayer, statePath, type StateIo, type VerifyState } from '../../plugins/h7/scripts/verify-state.ts';

cleanupTmp();

const NOW = new Date('2026-11-16T10:00:00.000Z');

function memoryIo(initial: Record<string, string> = {}): StateIo & { files: Record<string, string> } {
  const files = { ...initial };
  return {
    files,
    read: (path) => files[path] ?? null,
    write: (path, text) => {
      files[path] = text;
    },
  };
}

function allPass(): VerifyState {
  let state = freshState(NOW);
  for (const layer of LAYERS) state = setLayer(state, layer, 'pass', 'ok', NOW);
  return state;
}

describe('verify state', () => {
  it('starts with every layer pending and incomplete', () => {
    const state = freshState(NOW);
    assert.equal(Object.keys(state.layers).length, LAYERS.length);
    assert.equal(incomplete(state).length, LAYERS.length);
    assert.equal(incomplete(state)[0], 'lint: not run yet');
  });

  it('is complete when every layer passed or is n/a with a reason', () => {
    let state = allPass();
    assert.deepEqual(incomplete(state), []);
    state = setLayer(state, 'bombadil', 'na', 'no web or TUI surface', NOW);
    assert.deepEqual(incomplete(state), []);
  });

  it('reports failing layers with their reason and n/a layers without one', () => {
    let state = setLayer(allPass(), 'unit', 'fail', '3 failing', NOW);
    state = setLayer(state, 'property', 'fail', '', NOW);
    state = setLayer(state, 'e2e', 'na', '', NOW);
    state = setLayer(state, 'mutation', 'na', '   ', NOW);
    assert.deepEqual(incomplete(state), ['unit: failing (3 failing)', 'mutation: marked n/a without a reason', 'property: failing', 'e2e: marked n/a without a reason']);
  });

  it('setLayer keeps other layers, stamps the time and omits an empty reason', () => {
    const later = new Date('2026-11-16T11:00:00.000Z');
    const next = setLayer(freshState(NOW), 'lint', 'pass', '', later);
    assert.equal(next.updated, later.toISOString());
    assert.deepEqual(next.layers.lint, { status: 'pass' });
    assert.deepEqual(next.layers.types, { status: 'pending' });
    assert.deepEqual(setLayer(next, 'lint', 'pass', 'eslint clean', later).layers.lint, { status: 'pass', reason: 'eslint clean' });
  });

  it('round trips through parseState', () => {
    const state = setLayer(freshState(NOW), 'unit', 'fail', 'x', NOW);
    assert.deepEqual(parseState(JSON.stringify(state)), state);
  });

  it('parseState drops unknown layers, fills missing ones and rejects malformed input', () => {
    const base = { updated: NOW.toISOString(), blocks: 2, layers: { lint: { status: 'pass' }, nope: { status: 'pass' } } };
    const parsed = parseState(JSON.stringify(base));
    assert.equal(parsed?.blocks, 2);
    assert.equal(parsed?.layers.lint.status, 'pass');
    assert.equal(parsed?.layers.types.status, 'pending');
    assert.equal(Object.keys(parsed?.layers ?? {}).length, LAYERS.length);
    const bad = (value: unknown): void => assert.equal(parseState(JSON.stringify(value)), null, JSON.stringify(value));
    assert.equal(parseState('{'), null);
    bad(null);
    bad('text');
    bad({ ...base, updated: 5 });
    bad({ ...base, updated: 'yesterday' });
    bad({ ...base, blocks: '2' });
    bad({ ...base, blocks: 1.5 });
    bad({ ...base, blocks: -1 });
    bad({ ...base, layers: null });
    bad({ ...base, layers: 'x' });
    bad({ ...base, layers: { lint: { status: 'done' } } });
    bad({ ...base, layers: { lint: { status: 5 } } });
    bad({ ...base, layers: { lint: null } });
  });
});

describe('verify-state CLI', () => {
  const run = (argv: string[], io: StateIo) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = main(argv, (t) => out.push(t), (t) => err.push(t), '/repo', io, () => NOW);
    return { code, out: out.join('\n'), err: err.join('\n') };
  };
  const file = statePath('/repo');

  it('init writes a fresh state, even over a malformed one', () => {
    const io = memoryIo({ [file]: 'garbage' });
    const result = run(['init'], io);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.out), { file: STATE_FILE, layers: LAYERS.length });
    assert.deepEqual(parseState(io.files[file] as string), freshState(NOW));
  });

  it('set records a layer with a joined reason; check reports what is left', () => {
    const io = memoryIo();
    run(['init'], io);
    assert.equal(run(['set', 'bombadil', 'na', 'no', 'web', 'surface'], io).code, 0);
    assert.deepEqual(parseState(io.files[file] as string)?.layers.bombadil, { status: 'na', reason: 'no web surface' });
    const check = run(['check'], io);
    assert.equal(check.code, 1);
    assert.equal(JSON.parse(check.out).complete, false);
    for (const layer of LAYERS.filter((l) => l !== 'bombadil')) run(['set', layer, 'pass', 'ok'], io);
    const done = run(['check'], io);
    assert.equal(done.code, 0);
    assert.deepEqual(JSON.parse(done.out), { complete: true, incomplete: [] });
  });

  it('show prints the state and never fails on incomplete', () => {
    const io = memoryIo();
    run(['init'], io);
    const shown = run(['show'], io);
    assert.equal(shown.code, 0);
    assert.equal(JSON.parse(shown.out).incomplete.length, LAYERS.length);
  });

it('a pass without evidence is incomplete, and the CLI refuses to record one', () => {    const bare = setLayer(allPass(), 'unit', 'pass', '', NOW);    assert.deepEqual(incomplete(bare), ['unit: passed without evidence']);    assert.deepEqual(incomplete(setLayer(bare, 'unit', 'pass', '  ', NOW)), ['unit: passed without evidence']);    const io = memoryIo();    run(['init'], io);    for (const status of ['pass', 'fail', 'na']) {      const result = run(['set', 'unit', status], io);      assert.equal(result.code, 2, status);      assert.match(result.err, /needs one line of evidence/);    }    assert.equal(parseState(io.files[file] as string)?.layers.unit.status, 'pending');    assert.equal(run(['set', 'unit', 'pending'], io).code, 0);  });
  it('rejects bad usage, bad set arguments and a missing or malformed state', () => {
    const io = memoryIo();
    assert.equal(run([], io).code, 2);
    assert.match(run(['bogus'], io).err, /usage/);
    const missing = run(['check'], io);
    assert.equal(missing.code, 2);
    assert.match(missing.err, /missing/);
    assert.match(run(['set', 'lint', 'pass'], io).err, /missing/);
    io.files[file] = '{';
    assert.match(run(['show'], io).err, /malformed/);
    run(['init'], io);
    for (const args of [['set'], ['set', 'lint'], ['set', 'nope', 'pass'], ['set', 'lint', 'done']]) {
      const result = run(args, io);
      assert.equal(result.code, 2, args.join(' '));
      assert.match(result.err, /layers: lint/);
    }
  });
});

describe('real state io', () => {
  it('reads null for a missing file and writes through missing directories', () => {
    const dir = tmpDir();
    const path = join(dir, STATE_FILE);
    assert.equal(realStateIo.read(path), null);
    realStateIo.write(path, 'x');
    assert.equal(readFileSync(path, 'utf8'), 'x');
    assert.equal(realStateIo.read(path), 'x');
  });
});

describe('verify-state process', () => {
  it('runs as a script in the current directory', () => {
    const dir = tmpDir();
    const script = join(import.meta.dirname, '../../plugins/h7/scripts/verify-state.ts');
    const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' });
    assert.equal(run('init').status, 0);
    assert.equal(run('check').status, 1);
    assert.equal(run('bogus').status, 2);
    assert.equal(run('set', 'lint', 'pass', 'ok').status, 0);
    assert.equal(JSON.parse(readFileSync(join(dir, STATE_FILE), 'utf8')).layers.lint.status, 'pass');
  });
});
