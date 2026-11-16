import { readAll } from './guard-core.ts';
import { incomplete, parseState, realStateIo, statePath, type StateIo } from './verify-state.ts';

/** A state untouched for this long belongs to an abandoned run; it must not trap an unrelated session. */
export const STALE_MS = 12 * 60 * 60 * 1000;
/** Own cap, below the harness's 8 consecutive continuations, so the gate can never block forever. */
export const MAX_BLOCKS = 5;

export interface GateResult {
  /** Hook JSON for stdout; empty string lets Claude stop. */
  stdout: string;
  stderr: string;
}

const ALLOW: GateResult = { stdout: '', stderr: '' };

/**
 * Stop hook for /h7:work and /h7:ship. Blocks stopping while `.h7/verify.json` lists unfinished layers.
 * Fails open on every internal problem (bad input, malformed state, write failure): a broken gate must
 * never trap the session. Honors stop_hook_active.
 */
export function gate(input: string, io: StateIo = realStateIo, now: Date = new Date(), fallbackCwd: string = process.cwd()): GateResult {
  try {
    const parsed = JSON.parse(input) as { stop_hook_active?: unknown; cwd?: unknown };
    if (parsed.stop_hook_active === true) return ALLOW;
    const cwd = typeof parsed.cwd === 'string' && parsed.cwd !== '' ? parsed.cwd : fallbackCwd;
    const file = statePath(cwd);
    const text = io.read(file);
    if (text === null) return ALLOW;
    const state = parseState(text);
    if (state === null) return { stdout: '', stderr: 'h7 verify gate: state file is malformed, allowing stop\n' };
    if (now.getTime() - Date.parse(state.updated) > STALE_MS) return ALLOW;
    const problems = incomplete(state);
    if (problems.length === 0) return ALLOW;
    if (state.blocks >= MAX_BLOCKS) return { stdout: '', stderr: `h7 verify gate: blocked ${MAX_BLOCKS} times, allowing stop with unfinished layers: ${problems.join('; ')}\n` };
    io.write(file, `${JSON.stringify({ ...state, blocks: state.blocks + 1 }, null, 2)}\n`);
    const reason = `Verification is incomplete (${problems.join('; ')}). Run /h7:verify for the unfinished layers and record each with verify-state.ts set, or mark a layer na with a reason.`;
    return { stdout: JSON.stringify({ decision: 'block', reason }), stderr: '' };
  } catch (error) {
    return { stdout: '', stderr: `h7 verify gate: ${(error as Error).message}, allowing stop\n` };
  }
}

if (import.meta.main) {
  const result = gate(await readAll(process.stdin));
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
}
