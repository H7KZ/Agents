import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { delimiter, isAbsolute, join, relative, resolve } from 'node:path';
import { blocked, checkKey, countOpenThreads, decide, excerpt, parsePr, triage, type Check, type FailureLog, type Pr, type RerunRecord, type Triage, type Verdict } from './ci-verdict.ts';
import { spawnRunner, type Runner } from './git.ts';
import { ensureExclude, pathProblem, writeAtomic } from './setup-files.ts';
import { placeOf, type FsIo, type Place } from './workspace.ts';

export interface GhResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type Gh = (args: string[], cwd: string) => GhResult;

export interface Deps {
  gh: Gh;
  store: RerunStore;
  now: () => number;
  cwd: string;
}

export interface Options {
  pr: string | null;
  noRerun: boolean;
  allowNoChecks: boolean;
  logLines: number;
}

export const STATE_FILE = '.h7/ci-watch.json';
export const EXIT = { READY: 0, WAITING: 1, BLOCKED: 2, USAGE: 64 } as const;
const MAX_LOGS = 3;
const MAX_LOG_CHARS = 4000;
const PR_FIELDS = 'number,url,state,isDraft,mergeable,mergeStateStatus,baseRefName,headRefName,headRefOid,statusCheckRollup';
const THREADS_QUERY = 'query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage} nodes{isResolved isOutdated}}}}}';
const USAGE = 'usage: ci-watch.ts [<pr-number>] [--no-rerun] [--allow-no-checks] [--log-lines <n>]';

/** Absolute PATH entries only: a relative entry or the working directory must never supply `gh`. */
export function resolveGh(pathEnv: string, isFile: (path: string) => boolean): string | null {
  for (const dir of pathEnv.split(delimiter)) {
    if (!isAbsolute(dir)) continue;
    for (const name of ['gh.exe', 'gh']) {
      const candidate = join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function makeGh(executable: string | null, spawn: typeof spawnSync = spawnSync): Gh {
  return (args, cwd) => {
    if (executable === null) return { status: null, stdout: '', stderr: 'gh not found' };
    const result = spawn(executable, args, { cwd, encoding: 'utf8', timeout: 60_000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
    return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  };
}

export function parseArgs(argv: readonly string[]): Options | string {
  const options: Options = { pr: null, noRerun: false, allowNoChecks: false, logLines: 60 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (arg === '--no-rerun') options.noRerun = true;
    else if (arg === '--allow-no-checks') options.allowNoChecks = true;
    else if (arg === '--log-lines') {
      const value = argv[i + 1] ?? '';
      i += 1;
      if (!/^\d{1,4}$/.test(value) || Number(value) < 1) return `--log-lines needs a number from 1 to 9999\n${USAGE}`;
      options.logLines = Number(value);
    } else if (/^\d{1,9}$/.test(arg) && options.pr === null) options.pr = String(Number(arg));
    else return `unknown argument: ${arg}\n${USAGE}`;
  }
  return options;
}

const firstLine = (text: string): string => text.trim().split('\n')[0]?.trim() || 'no output';

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export interface RerunStore {
  /** Rerun records for this head commit; anything unreadable or hostile yields none. Never throws. */
  load(sha: string): RerunRecord[];
  /** True when state can be written safely (inside the repo, ignored by git). Reruns are only requested then. */
  prepare(): boolean;
  /** Atomic, contained write; false on any refusal or failure. Never throws. */
  save(sha: string, records: RerunRecord[]): boolean;
}

const MAX_RECORDS = 200;

export function validRecords(value: unknown, sha: string): RerunRecord[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  const o = value as Record<string, unknown>;
  if (o.sha !== sha || !Array.isArray(o.reran)) return [];
  const out: RerunRecord[] = [];
  for (const entry of o.reran.slice(0, MAX_RECORDS)) {
    const e = typeof entry === 'object' && entry !== null ? (entry as Record<string, unknown>) : {};
    if (typeof e.key === 'string' && e.key.length <= 400 && typeof e.at === 'string' && Number.isFinite(Date.parse(e.at))) out.push({ key: e.key, at: e.at });
  }
  return out;
}

/** State lives in the repo's own .h7 directory, or under the workspace state directory in workspace mode; written with setup's symlink-safe atomic writer. */
export function makeStore(cwd: string, git: Runner, fs?: FsIo, home?: string): RerunStore {
  const run = (args: string[], at: string): { status: number | null; stdout: string } => {
    try {
      return git(args, at);
    } catch {
      return { status: null, stdout: '' };
    }
  };
  const rootOf = (): string | null => {
    const result = run(['rev-parse', '--show-toplevel'], cwd);
    const root = result.stdout.trim();
    return result.status === 0 && root !== '' ? resolve(root) : null;
  };
  /** Where the state file goes for the repo containing cwd; null when that cannot be told (not a repo, untrustworthy workspace marker). */
  const target = (): { root: string; place: Place; file: string } | null => {
    const root = rootOf();
    if (root === null) return null;
    try {
      const place = placeOf(root, fs, home);
      return { root, place, file: join(place.state, 'ci-watch.json') };
    } catch {
      return null;
    }
  };
  const ignored = (root: string): boolean => {
    if (run(['check-ignore', '-q', STATE_FILE], root).status === 0) return true;
    const path = run(['rev-parse', '--git-path', 'info/exclude'], root);
    if (path.status !== 0 || path.stdout.trim() === '') return false;
    const file = relative(root, resolve(root, path.stdout.trim()));
    try {
      if (pathProblem(file, root) !== null) return false;
      let existing: string | null = null;
      try {
        existing = readFileSync(resolve(root, file), 'utf8');
      } catch {
        existing = null;
      }
      const result = ensureExclude(existing);
      if (result.status !== 'unchanged') writeAtomic(resolve(root, file), result.text, root);
      return true;
    } catch {
      return false;
    }
  };
  return {
    load(sha) {
      const found = target();
      if (found === null) return [];
      try {
        if (pathProblem(found.file, found.place.contain) !== null) return [];
        return validRecords(parseJson(readFileSync(found.file, 'utf8')), sha);
      } catch {
        return [];
      }
    },
    prepare() {
      const found = target();
      return found !== null && (found.place.workspace || ignored(found.root));
    },
    save(sha, records) {
      const found = target();
      if (found === null) return false;
      try {
        if (pathProblem(found.file, found.place.contain) !== null) return false;
        writeAtomic(found.file, `${JSON.stringify({ sha, reran: records.slice(-MAX_RECORDS) })}\n`, found.place.contain);
        return true;
      } catch {
        return false;
      }
    },
  };
}

const BUSY = /already running|in progress|still running|is running/i;

/**
 * Reruns each failed Actions run once (failed jobs only). A refused rerun on a run that is still going means
 * wait, not failure, and spends nothing; the record is written only after GitHub accepted the rerun.
 */
function rerunFlakes(tri: Triage, pr: Pr, previous: RerunRecord[], options: Options, deps: Deps): Triage {
  if (tri.rerun.length === 0) return tri;
  const real = [...tri.real];
  const candidates: Check[] = [];
  const ready = !options.noRerun && deps.store.prepare();
  for (const check of tri.rerun) (check.runId === null || !ready ? real : candidates).push(check);
  const outcome = new Map<string, 'ok' | 'busy' | 'failed'>();
  for (const id of new Set(candidates.map((check) => check.runId as string))) {
    const result = deps.gh(['run', 'rerun', id, '--failed'], deps.cwd);
    outcome.set(id, result.status === 0 ? 'ok' : BUSY.test(result.stderr) ? 'busy' : 'failed');
  }
  const reran: Check[] = [];
  const inFlight = [...tri.inFlight];
  for (const check of candidates) {
    const result = outcome.get(check.runId as string);
    (result === 'ok' ? reran : result === 'busy' ? inFlight : real).push(check);
  }
  if (reran.length > 0) {
    const at = new Date(deps.now()).toISOString();
    const records = [...previous, ...reran.map((check) => ({ key: checkKey(check), at }))];
    if (!deps.store.save(pr.sha, records)) return { rerun: [], real: [...real, ...reran], stale: tri.stale, inFlight };
  }
  return { rerun: reran, real, stale: tri.stale, inFlight };
}

function failureLogs(real: readonly Check[], options: Options, deps: Deps): FailureLog[] {
  const byRun = new Map<string, string[]>();
  for (const check of real) if (check.runId !== null) byRun.set(check.runId, [...(byRun.get(check.runId) ?? []), check.name]);
  const logs: FailureLog[] = [];
  for (const [id, checkNames] of [...byRun].slice(0, MAX_LOGS)) {
    const result = deps.gh(['run', 'view', id, '--log-failed'], deps.cwd);
    const text = result.status === 0 ? excerpt(result.stdout, options.logLines, MAX_LOG_CHARS) : `log unavailable: ${firstLine(result.stderr)}`;
    logs.push({ check: checkNames.join(', '), excerpt: text, untrusted: true });
  }
  return logs;
}

export function watch(options: Options, deps: Deps): Verdict {
  if (deps.gh(['--version'], deps.cwd).status !== 0) return blocked('gh is not installed or not on PATH');
  if (deps.gh(['auth', 'status'], deps.cwd).status !== 0) return blocked('gh is not authenticated: run gh auth login');
  const view = deps.gh(['pr', 'view', ...(options.pr === null ? [] : [options.pr]), '--json', PR_FIELDS], deps.cwd);
  if (view.status !== 0) return blocked(`gh pr view failed: ${firstLine(view.stderr)}`);
  const pr = parsePr(parseJson(view.stdout));
  if (pr === null) return blocked('gh pr view returned output this watcher does not understand');
  const info = { number: pr.number, url: pr.url, sha: pr.sha, base: pr.base, head: pr.head };
  const threadsResult = deps.gh(['api', 'graphql', '-F', 'owner={owner}', '-F', 'repo={repo}', '-F', `number=${pr.number}`, '-f', `query=${THREADS_QUERY}`], deps.cwd);
  const threads = threadsResult.status === 0 ? countOpenThreads(parseJson(threadsResult.stdout)) : null;
  if (threads === null) return blocked(`could not read review threads: ${firstLine(threadsResult.stderr)}`, info);
  const previous = deps.store.load(pr.sha);
  const failed = pr.checks.filter((check) => check.state === 'fail');
  const tri = rerunFlakes(triage(failed, pr.mergeState, previous, deps.now()), pr, previous, options, deps);
  const verdict = decide(pr, threads, tri, { allowNoChecks: options.allowNoChecks });
  return { ...verdict, failureLogs: failureLogs(tri.real, options, deps) };
}

export function main(argv: readonly string[], out: (text: string) => void, err: (text: string) => void, deps: Deps): number {
  const options = parseArgs(argv);
  if (typeof options === 'string') {
    err(options);
    return EXIT.USAGE;
  }
  const verdict = watch(options, deps);
  out(JSON.stringify(verdict, null, 2));
  return EXIT[verdict.verdict];
}

if (import.meta.main) {
  const gh = makeGh(resolveGh(String(process.env.PATH), isFile));
  process.exitCode = main(process.argv.slice(2), (t) => console.log(t), (t) => console.error(t), { gh, store: makeStore(process.cwd(), spawnRunner), now: Date.now, cwd: process.cwd() });
}
