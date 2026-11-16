export type CheckState = 'pass' | 'fail' | 'pending' | 'skipped';

export interface Check {
  name: string;
  state: CheckState;
  /** GitHub Actions run id parsed from the details URL; null for external status contexts. */
  runId: string | null;
  url: string | null;
}

export interface Pr {
  number: number;
  url: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  draft: boolean;
  mergeable: string;
  mergeState: string;
  base: string;
  head: string;
  sha: string;
  checks: Check[];
}

export type BlockerKind = 'not-open' | 'draft' | 'merge-conflicts' | 'review-threads' | 'failing-checks' | 'stale-base' | 'merge-gate' | 'status-query';

export interface Blocker {
  kind: BlockerKind;
  detail: string;
}

export interface Triage {
  /** Failed once, never rerun on this head: one fresh run is allowed. */
  rerun: Check[];
  /** Failed again after a rerun, or cannot be rerun: a real failure for the fix loop. */
  real: Check[];
  /** Failed on a branch that is behind its base: rebase before judging the failure. */
  stale: Check[];
}

export interface FailureLog {
  check: string;
  excerpt: string;
}

export interface Verdict {
  verdict: 'READY' | 'WAITING' | 'BLOCKED';
  pr: { number: number; url: string; sha: string; base: string; head: string } | null;
  blockers: Blocker[];
  waiting: string[];
  counts: { pass: number; fail: number; pending: number; skipped: number };
  rerun: string[];
  advice: string[];
  failureLogs: FailureLog[];
}

export interface DecideOptions {
  /** Treat a PR with no checks as ready instead of waiting for them to appear. */
  allowNoChecks?: boolean;
}

const asObj = (value: unknown): Record<string, unknown> | null => (typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null);
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

// Maps, not objects: a check named "__proto__" or "constructor" must not hit Object.prototype.
const CONCLUSIONS = new Map<string, CheckState>([
  ['SUCCESS', 'pass'],
  ['NEUTRAL', 'pass'],
  ['SKIPPED', 'skipped'],
]);
const CONTEXTS = new Map<string, CheckState>([
  ['SUCCESS', 'pass'],
  ['PENDING', 'pending'],
  ['EXPECTED', 'pending'],
]);

function stateOf(raw: Record<string, unknown>): CheckState {
  const status = str(raw.status);
  if (status === null) {
    const state = str(raw.state);
    return state === null ? 'fail' : (CONTEXTS.get(state) ?? 'fail');
  }
  if (status !== 'COMPLETED') return 'pending';
  return CONCLUSIONS.get(str(raw.conclusion) ?? '') ?? 'fail';
}

/** One entry of `statusCheckRollup`: a CheckRun or a StatusContext. Unknown shapes count as failed, never as passing. */
export function classifyCheck(raw: unknown): Check {
  const o = asObj(raw) ?? {};
  const url = str(o.detailsUrl) ?? str(o.targetUrl);
  const runId = url === null ? null : (/\/actions\/runs\/(\d+)/.exec(url)?.[1] ?? null);
  return { name: str(o.name) ?? str(o.context) ?? 'unknown check', state: stateOf(o), runId, url };
}

/** Parses `gh pr view --json ...`; null when the shape is not recognisable. */
export function parsePr(json: unknown): Pr | null {
  const o = asObj(json);
  if (o === null) return null;
  const number = o.number;
  if (typeof number !== 'number' || !Number.isInteger(number) || number < 1) return null;
  const state = str(o.state);
  if (state !== 'OPEN' && state !== 'CLOSED' && state !== 'MERGED') return null;
  const rollup = o.statusCheckRollup ?? [];
  if (!Array.isArray(rollup)) return null;
  return {
    number,
    url: str(o.url) ?? '',
    state,
    draft: o.isDraft === true,
    mergeable: str(o.mergeable) ?? 'UNKNOWN',
    mergeState: str(o.mergeStateStatus) ?? 'UNKNOWN',
    base: str(o.baseRefName) ?? '',
    head: str(o.headRefName) ?? '',
    sha: str(o.headRefOid) ?? '',
    checks: rollup.map(classifyCheck),
  };
}

/**
 * Unresolved review threads from the GraphQL response, or null when the answer cannot be trusted:
 * a bad shape, or a first page with no open thread and more pages behind it.
 */
export function countOpenThreads(json: unknown): number | null {
  const threads = asObj(asObj(asObj(asObj(asObj(json)?.data)?.repository)?.pullRequest)?.reviewThreads);
  const nodes = threads?.nodes;
  if (threads === null || !Array.isArray(nodes)) return null;
  const open = nodes.filter((node) => asObj(node)?.isResolved !== true).length;
  if (open === 0 && asObj(threads.pageInfo)?.hasNextPage === true) return null;
  return open;
}

/** Splits failed checks. One rerun per check name per head commit; behind-base failures are stale, not real. */
export function triage(failed: readonly Check[], mergeState: string, reran: readonly string[]): Triage {
  const result: Triage = { rerun: [], real: [], stale: [] };
  for (const check of failed) {
    if (reran.includes(check.name)) result.real.push(check);
    else if (mergeState === 'BEHIND') result.stale.push(check);
    else result.rerun.push(check);
  }
  return result;
}

export function blocked(detail: string, pr: Verdict['pr'] = null): Verdict {
  return { verdict: 'BLOCKED', pr, blockers: [{ kind: 'status-query', detail }], waiting: [], counts: { pass: 0, fail: 0, pending: 0, skipped: 0 }, rerun: [], advice: [], failureLogs: [] };
}

const names = (checks: readonly Check[]): string => checks.map((check) => check.name).join(', ');

/**
 * Order follows babysit: conflicts, then review threads, then CI. Any blocker wins over waiting, so the
 * agent acts on what it can fix now. Never recommends merging; READY means "nothing left for the agent".
 */
export function decide(pr: Pr, openThreads: number, tri: Triage, options: DecideOptions = {}): Verdict {
  const counts = { pass: 0, fail: 0, pending: 0, skipped: 0 };
  for (const check of pr.checks) counts[check.state] += 1;
  const blockers: Blocker[] = [];
  const waiting: string[] = [];
  const advice: string[] = [];
  const stale = `git fetch origin && git rebase origin/${pr.base}, then push the branch (advice only: the watcher never rebases or pushes)`;
  if (pr.state !== 'OPEN') blockers.push({ kind: 'not-open', detail: `pull request is ${pr.state}` });
  if (pr.draft) blockers.push({ kind: 'draft', detail: 'pull request is a draft' });
  if (pr.mergeable === 'CONFLICTING' || pr.mergeState === 'DIRTY') {
    blockers.push({ kind: 'merge-conflicts', detail: `conflicts with ${pr.base}` });
    advice.push(`resolve conflicts: ${stale}`);
  }
  if (openThreads > 0) blockers.push({ kind: 'review-threads', detail: `${openThreads} unresolved review thread${openThreads === 1 ? '' : 's'}` });
  if (tri.real.length > 0) blockers.push({ kind: 'failing-checks', detail: `failing: ${names(tri.real)}` });
  if (tri.stale.length > 0) {
    blockers.push({ kind: 'stale-base', detail: `failing on a branch behind ${pr.base}: ${names(tri.stale)}` });
    advice.push(`rebase first: ${stale}`);
  }
  if (tri.rerun.length > 0) waiting.push(`rerun requested for: ${names(tri.rerun)}`);
  if (counts.pending > 0) waiting.push(`${counts.pending} check${counts.pending === 1 ? '' : 's'} pending`);
  if (pr.checks.length === 0 && options.allowNoChecks !== true) waiting.push('no checks reported yet');
  if (pr.mergeable === 'UNKNOWN' || pr.mergeState === 'UNKNOWN') waiting.push('mergeability still being computed');
  if (blockers.length === 0 && waiting.length === 0) {
    if (pr.mergeState === 'BEHIND') {
      blockers.push({ kind: 'stale-base', detail: `branch is behind ${pr.base}` });
      advice.push(`rebase: ${stale}`);
    } else if (pr.mergeState === 'BLOCKED') {
      blockers.push({ kind: 'merge-gate', detail: 'checks pass but branch protection blocks the merge (required review or approval)' });
    }
  }
  const verdict = blockers.length > 0 ? 'BLOCKED' : waiting.length > 0 ? 'WAITING' : 'READY';
  return { verdict, pr: { number: pr.number, url: pr.url, sha: pr.sha, base: pr.base, head: pr.head }, blockers, waiting, counts, rerun: tri.rerun.map((check) => check.name), advice, failureLogs: [] };
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;

/** Tail of a failed-job log, ANSI stripped, bounded by lines and characters. Failures are printed last. */
export function excerpt(log: string, maxLines: number, maxChars: number): string {
  const lines = log.replace(ANSI, '').replace(/\r/g, '').split('\n').filter((line) => line.trim() !== '');
  const tail = lines.slice(-Math.max(1, maxLines)).join('\n');
  return tail.length > maxChars ? tail.slice(tail.length - maxChars) : tail;
}
