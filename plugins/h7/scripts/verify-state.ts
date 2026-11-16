import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const LAYERS = ['lint', 'types', 'unit', 'diff-coverage', 'mutation', 'edge-cases', 'property', 'e2e', 'bombadil', 'regression'] as const;
export const STATUSES = ['pending', 'pass', 'fail', 'na'] as const;

export type Layer = (typeof LAYERS)[number];
export type Status = (typeof STATUSES)[number];

export interface LayerState {
  status: Status;
  /** Required for `na` (why the layer does not apply); one line of evidence for the others. */
  reason?: string;
}

export interface VerifyState {
  updated: string;
  /** How many times the Stop gate already blocked on this state. */
  blocks: number;
  layers: Record<Layer, LayerState>;
}

export const STATE_FILE = '.h7/verify.json';

export const statePath = (root: string): string => join(root, STATE_FILE);

export function freshState(now: Date): VerifyState {
  const layers = Object.fromEntries(LAYERS.map((layer) => [layer, { status: 'pending' }])) as Record<Layer, LayerState>;
  return { updated: now.toISOString(), blocks: 0, layers };
}

const isLayer = (name: string): name is Layer => (LAYERS as readonly string[]).includes(name);
const isStatus = (name: string): name is Status => (STATUSES as readonly string[]).includes(name);

/** Null when the text is not a well-formed state (never throws). Unknown layers are dropped, missing ones become pending. */
export function parseState(text: string): VerifyState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const { updated, blocks, layers } = raw as Record<string, unknown>;
  if (typeof updated !== 'string' || Number.isNaN(Date.parse(updated))) return null;
  if (typeof blocks !== 'number' || !Number.isInteger(blocks) || blocks < 0) return null;
  if (typeof layers !== 'object' || layers === null) return null;
  const state = freshState(new Date(updated));
  state.blocks = blocks;
  for (const [name, value] of Object.entries(layers)) {
    if (!isLayer(name)) continue;
    const { status, reason } = (value ?? {}) as Record<string, unknown>;
    if (typeof status !== 'string' || !isStatus(status)) return null;
    state.layers[name] = typeof reason === 'string' ? { status, reason } : { status };
  }
  return state;
}

/** What still stands between this state and "verification complete". Empty means complete. */
export function incomplete(state: VerifyState): string[] {
  const problems: string[] = [];
  for (const layer of LAYERS) {
    const { status, reason } = state.layers[layer];
    if (status === 'pending') problems.push(`${layer}: not run yet`);
    else if (status === 'fail') problems.push(`${layer}: failing${reason ? ` (${reason})` : ''}`);
    else if (status === 'na' && (reason ?? '').trim() === '') problems.push(`${layer}: marked n/a without a reason`);
    else if (status === 'pass' && (reason ?? '').trim() === '') problems.push(`${layer}: passed without evidence`);
  }
  return problems;
}

export function setLayer(state: VerifyState, layer: Layer, status: Status, reason: string, now: Date): VerifyState {
  const entry: LayerState = reason === '' ? { status } : { status, reason };
  return { ...state, updated: now.toISOString(), layers: { ...state.layers, [layer]: entry } };
}

export interface StateIo {
  read(path: string): string | null;
  write(path: string, text: string): void;
}

export const realStateIo: StateIo = {
  read(path) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  write(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
};

const USAGE = 'usage: verify-state.ts init | set <layer> <pass|fail|na|pending> [reason...] | check | show';

export function main(argv: string[], out: (text: string) => void, err: (text: string) => void, cwd: string, io: StateIo = realStateIo, now: () => Date = () => new Date()): number {
  const [cmd, layer, status, ...reason] = argv;
  const file = statePath(cwd);
  const loaded = io.read(file);
  const current = loaded === null ? null : parseState(loaded);
  const save = (state: VerifyState): void => io.write(file, `${JSON.stringify(state, null, 2)}\n`);
  if (cmd === 'init') {
    save(freshState(now()));
    out(JSON.stringify({ file: STATE_FILE, layers: LAYERS.length }));
    return 0;
  }
  if (cmd !== 'set' && cmd !== 'check' && cmd !== 'show') {
    err(USAGE);
    return 2;
  }
  if (current === null) {
    err(`${STATE_FILE} is ${loaded === null ? 'missing' : 'malformed'}; run: verify-state.ts init`);
    return 2;
  }
  if (cmd === 'set') {
    if (layer === undefined || status === undefined || !isLayer(layer) || !isStatus(status)) {
      err(`${USAGE}\nlayers: ${LAYERS.join(', ')}`);
      return 2;
    }
    const note = reason.join(' ').trim();
    if (status !== 'pending' && note === '') {
      err(`${layer} ${status} needs one line of evidence or reason`);
      return 2;
    }
    save(setLayer(current, layer, status, note, now()));
    out(JSON.stringify({ layer, status }));
    return 0;
  }
  const problems = incomplete(current);
  out(JSON.stringify(cmd === 'show' ? { ...current, incomplete: problems } : { complete: problems.length === 0, incomplete: problems }));
  return cmd === 'check' && problems.length > 0 ? 1 : 0;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), (t) => console.log(t), (t) => console.error(t), process.cwd());
}
