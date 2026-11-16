import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { MAX_BLOCKS, STALE_MS, gate } from '../../plugins/h7/scripts/verify-gate.ts';
import { LAYERS, freshState, parseState, setLayer, statePath, type StateIo, type VerifyState } from '../../plugins/h7/scripts/verify-state.ts';
import { cleanupTmp, stripNodeWarnings, tmpDir, writeTree } from '../../scripts/test/helpers.ts';

cleanupTmp();

const NOW = new Date('2026-11-16T10:00:00.000Z');
const file = statePath('/repo');
const input = (extra: Record<string, unknown> = {}): string => JSON.stringify({ cwd: '/repo', ...extra });

function memoryIo(state?: VerifyState | string): StateIo & { files: Record<string, string> } {
  const files: Record<string, string> = {};
  if (state !== undefined) files[file] = typeof state === 'string' ? state : JSON.stringify(state);
  return {
    files,
    read: (path) => files[path] ?? null,
    write: (path, text) => {
      files[path] = text;
    },
  };
}

const passing = (): VerifyState => LAYERS.reduce((s, l) => setLayer(s, l, 'pass', 'ok', NOW), freshState(NOW));
const allow = { stdout: '', stderr: '' };

describe('verify gate', () => {
  it('blocks with a reason naming unfinished layers and counts the block', () => {
    const io = memoryIo(freshState(NOW));
    const result = gate(input(), io, NOW);
    const out = JSON.parse(result.stdout);
    assert.equal(out.decision, 'block');
    assert.match(out.reason, /lint: not run yet/);
    assert.match(out.reason, /\/h7:verify/);
    assert.equal(result.stderr, '');
    assert.equal(parseState(io.files[file] as string)?.blocks, 1);
  });

  it('allows when no verification run is active', () => {
    assert.deepEqual(gate(input(), memoryIo(), NOW), allow);
  });

  it('allows when verification is complete', () => {
    assert.deepEqual(gate(input(), memoryIo(passing()), NOW), allow);
  });

  it('allows when stop_hook_active is set, without touching the state', () => {
    const io = memoryIo(freshState(NOW));
    assert.deepEqual(gate(input({ stop_hook_active: true }), io, NOW), allow);
    assert.equal(parseState(io.files[file] as string)?.blocks, 0);
  });

  it('only a literal true counts as stop_hook_active', () => {
    assert.equal(JSON.parse(gate(input({ stop_hook_active: 'true' }), memoryIo(freshState(NOW)), NOW).stdout).decision, 'block');
  });

  it('allows an abandoned run, but not one just inside the window', () => {
    const state = freshState(NOW);
    assert.deepEqual(gate(input(), memoryIo(state), new Date(NOW.getTime() + STALE_MS + 1)), allow);
    assert.equal(JSON.parse(gate(input(), memoryIo(state), new Date(NOW.getTime() + STALE_MS)).stdout).decision, 'block');
  });

  it('stops blocking after MAX_BLOCKS and says why', () => {
    const io = memoryIo(freshState(NOW));
    for (let i = 0; i < MAX_BLOCKS; i++) assert.equal(JSON.parse(gate(input(), io, NOW).stdout).decision, 'block');
    const last = gate(input(), io, NOW);
    assert.equal(last.stdout, '');
    assert.match(last.stderr, /blocked 5 times, allowing stop with unfinished layers: lint: not run yet/);
    assert.equal(parseState(io.files[file] as string)?.blocks, MAX_BLOCKS);
  });

  it('fails open on internal errors', () => {
    const open = (result: { stdout: string; stderr: string }, pattern: RegExp): void => {
      assert.equal(result.stdout, '');
      assert.match(result.stderr, pattern);
    };
    open(gate('not json', memoryIo(freshState(NOW)), NOW), /allowing stop/);
    open(gate('null', memoryIo(freshState(NOW)), NOW), /allowing stop/);
    open(gate(input(), memoryIo('{"nope"'), NOW), /malformed/);
    const throwing: StateIo = {
      read: () => {
        throw new Error('disk on fire');
      },
      write: () => undefined,
    };
    open(gate(input(), throwing, NOW), /disk on fire, allowing stop/);
    const readonly: StateIo = { read: (p) => memoryIo(freshState(NOW)).read(p) ?? JSON.stringify(freshState(NOW)), write: () => {
      throw new Error('read-only');
    } };
    open(gate(input(), readonly, NOW), /read-only, allowing stop/);
  });

  it('uses the fallback directory when the input has no cwd', () => {
    const io = memoryIo(freshState(NOW));
    assert.equal(JSON.parse(gate('{}', io, NOW, '/repo').stdout).decision, 'block');
    assert.deepEqual(gate(JSON.stringify({ cwd: '' }), io, NOW, '/elsewhere'), allow);
  });

  it('defaults to the real file system, clock and cwd', () => {
    assert.equal(typeof gate('{"stop_hook_active":true}').stdout, 'string');
  });
});

describe('verify gate process', () => {
  const script = join(import.meta.dirname, '../../plugins/h7/scripts/verify-gate.ts');
  const spawn = (cwd: string, stdin: string) => {
    const r = spawnSync(process.execPath, [script], { cwd, input: stdin, encoding: 'utf8' });
    return { status: r.status, stdout: r.stdout, stderr: stripNodeWarnings(r.stderr) };
  };

  it('blocks via stdout JSON with exit 0, and stays silent when complete', () => {
    const dir = tmpDir();
    writeTree(dir, { '.h7/verify.json': JSON.stringify(freshState(new Date())) });
    const blocked = spawn(dir, JSON.stringify({ cwd: dir }));
    assert.equal(blocked.status, 0);
    assert.equal(JSON.parse(blocked.stdout).decision, 'block');
    writeTree(dir, { '.h7/verify.json': JSON.stringify(passing()) });
    const done = spawn(dir, JSON.stringify({ cwd: dir }));
    assert.deepEqual({ ...done }, { status: 0, stdout: '', stderr: '' });
  });

  it('exits 0 and allows on garbage input', () => {
    const result = spawn(tmpDir(), 'garbage');
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
  });
});
