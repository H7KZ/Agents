import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { blocked, countOpenThreads, decide, excerpt, parsePr, triage, type Check, type FailureLog, type Pr, type Triage, type Verdict } from './ci-verdict.ts';
import { realStateIo, type StateIo } from './verify-state.ts';

export interface GhResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type Gh = (args: string[], cwd: string) => GhResult;

export interface Deps {
  gh: Gh;
  io: StateIo;
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

interface RerunState {
  sha: string;
  reran: string[];
}

function readReran(io: StateIo, file: string, sha: string): string[] {
  const parsed = parseJson(io.read(file) ?? '') as Partial<RerunState> | null;
  if (parsed === null || typeof parsed !== 'object' || parsed.sha !== sha || !Array.isArray(parsed.reran)) return [];
  return parsed.reran.filter((name): name is string => typeof name === 'string');
}

/** Reruns each failed Actions run once (failed jobs only); anything that cannot be rerun becomes a real failure. */
function rerunFlakes(tri: Triage, pr: Pr, previous: string[], options: Options, deps: Deps): Triage {
  if (tri.rerun.length === 0) return tri;
  const real = [...tri.real];
  const candidates: Check[] = [];
  for (const check of tri.rerun) (check.runId === null || options.noRerun ? real : candidates).push(check);
  const runs = [...new Set(candidates.map((check) => check.runId as string))];
  const done = new Set<string>();
  const reran: Check[] = [];
  try {
    // Record before rerunning: if the record cannot be written, rerunning could loop forever.
    deps.io.write(join(deps.cwd, STATE_FILE), `${JSON.stringify({ sha: pr.sha, reran: [...previous, ...candidates.map((check) => check.name)] })}\n`);
  } catch {
    return { ...tri, rerun: [], real: [...real, ...candidates] };
  }
  for (const id of runs) if (deps.gh(['run', 'rerun', id, '--failed'], deps.cwd).status === 0) done.add(id);
  for (const check of candidates) (done.has(check.runId as string) ? reran : real).push(check);
  return { rerun: reran, real, stale: tri.stale };
}

function failureLogs(real: readonly Check[], options: Options, deps: Deps): FailureLog[] {
  const byRun = new Map<string, string[]>();
  for (const check of real) if (check.runId !== null) byRun.set(check.runId, [...(byRun.get(check.runId) ?? []), check.name]);
  const logs: FailureLog[] = [];
  for (const [id, checkNames] of [...byRun].slice(0, MAX_LOGS)) {
    const result = deps.gh(['run', 'view', id, '--log-failed'], deps.cwd);
    const text = result.status === 0 ? excerpt(result.stdout, options.logLines, MAX_LOG_CHARS) : `log unavailable: ${firstLine(result.stderr)}`;
    logs.push({ check: checkNames.join(', '), excerpt: text });
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
  const file = join(deps.cwd, STATE_FILE);
  const previous = readReran(deps.io, file, pr.sha);
  const failed = pr.checks.filter((check) => check.state === 'fail');
  const tri = rerunFlakes(triage(failed, pr.mergeState, previous), pr, previous, options, deps);
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
  process.exitCode = main(process.argv.slice(2), (t) => console.log(t), (t) => console.error(t), { gh, io: realStateIo, cwd: process.cwd() });
}
