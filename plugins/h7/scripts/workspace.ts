import { createHash, randomInt } from 'node:crypto';
import { closeSync, createReadStream, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { writeAtomic } from './setup-files.ts';

/**
 * Workspace mode: one developer's h7 state for several team repos lives OUTSIDE the repos, next to a marker file in an
 * ancestor directory. This module is the single resolver every script uses to find where `.h7/` state goes and which
 * verification settings apply. No marker, or a marker that does not list the repo: nothing changes (`<repo>/.h7`).
 */
export const MARKER = '.h7-workspace.json';
export const MAX_MARKER_BYTES = 65536;
export const MAX_REPOS = 200;

export class WorkspaceError extends Error {}

/**
 * Whether the user vouched for these exact marker contents: the sha256 of the marker text is recorded in the owner-only `<home>/.h7/workspaces.json`
 * (written only by `workspace.ts trust`, interactively). An untrusted or changed marker still gives paths, base and memory names; its scratch dir,
 * auto-merge and push are ignored.
 */
export type Trust = 'trusted' | 'untrusted' | 'changed';

export interface RepoSettings {
  base: string | null;
  /** Relative to the workspace root. */
  verification: string;
  prTemplate: string | null;
  ship: 'pr' | 'push';
  autoMerge: boolean;
}

export interface Marker {
  version: 1;
  stateDir: string;
  repos: Map<string, RepoSettings>;
  memory: { agents: string; /** null: CONTEXT.md, or GLOSSARY.md when only that exists. */ glossary: string | null; adr: string };
  scratch: string | null;
}

const fail = (message: string): WorkspaceError => new WorkspaceError(message);
const fold = (p: string): string => p.toLowerCase();

/** A normalized relative path with forward slashes: no `.`/`..` segments, no drive, no `.git` segment, nothing Windows would reinterpret. */
function cleanRel(value: unknown, what: string): string {
  if (typeof value !== 'string' || value === '' || value.length > 300) throw fail(`${what} must be a non-empty relative path of at most 300 characters`);
  if (/[\u0000-\u001f\u007f\\:*?"<>|]/.test(value) || value.startsWith('/')) throw fail(`${what} must be a relative path with forward slashes: ${JSON.stringify(value)}`);
  for (const segment of value.split('/')) {
    if (segment === '' || /[. ]$/.test(segment) || fold(segment) === '.git') throw fail(`${what} has an unusable segment: ${JSON.stringify(value)}`);
  }
  return value;
}

function branchName(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.length > 200 || !/^[A-Za-z0-9_][A-Za-z0-9._/-]*$/.test(value) || value.includes('..') || value.endsWith('/') || value.endsWith('.lock')) {
    throw fail(`${what} must be a plain branch name: ${JSON.stringify(value)}`);
  }
  return value;
}

function plain(value: unknown, what: string, allowed: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw fail(`${what} must be an object`);
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw fail(`${what} has an unknown key: ${JSON.stringify(unknown)}`);
  return value as Record<string, unknown>;
}

const overlaps = (a: string, b: string): boolean => `${fold(a)}/`.startsWith(`${fold(b)}/`) || `${fold(b)}/`.startsWith(`${fold(a)}/`);

function repoSettings(key: string, value: unknown): RepoSettings {
  const what = `repos.${key}`;
  const o = plain(value, what, ['base', 'verification', 'prTemplate', 'ship', 'autoMerge']);
  if (o.ship !== undefined && o.ship !== 'pr' && o.ship !== 'push') throw fail(`${what}.ship must be "pr" or "push"`);
  if (o.autoMerge !== undefined && typeof o.autoMerge !== 'boolean') throw fail(`${what}.autoMerge must be true or false`);
  return {
    base: o.base === undefined ? null : branchName(o.base, `${what}.base`),
    verification: o.verification === undefined ? `docs/agents/verification-${key.replaceAll('/', '-')}.md` : cleanRel(o.verification, `${what}.verification`),
    prTemplate: o.prTemplate === undefined ? null : cleanRel(o.prTemplate, `${what}.prTemplate`),
    ship: o.ship ?? 'pr',
    autoMerge: o.autoMerge ?? false,
  };
}

/** Strict, pure parse. Throws a WorkspaceError naming the first problem; never returns a half-valid marker. */
export function parseMarker(text: string): Marker {
  if (Buffer.byteLength(text) > MAX_MARKER_BYTES) throw fail(`${MARKER} is larger than ${MAX_MARKER_BYTES} bytes`);
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw fail(`${MARKER} is not valid JSON`);
  }
  const top = plain(raw, MARKER, ['version', 'stateDir', 'repos', 'memory', 'scratch']);
  if (top.version !== 1) throw fail(`${MARKER} version must be 1`);
  const stateDir = top.stateDir === undefined ? '.h7' : cleanRel(top.stateDir, 'stateDir');
  const scratch = top.scratch === undefined ? null : cleanRel(top.scratch, 'scratch');
  const repoMap = plain(top.repos, 'repos', Object.keys(typeof top.repos === 'object' && top.repos !== null ? top.repos : {}));
  const keys = Object.keys(repoMap);
  if (keys.length > MAX_REPOS) throw fail(`repos lists more than ${MAX_REPOS} repositories`);
  const repos = new Map<string, RepoSettings>();
  const seen = new Set<string>();
  for (const key of keys) {
    cleanRel(key, 'a repos key');
    if (seen.has(fold(key))) throw fail(`repos lists ${JSON.stringify(key)} twice (case-insensitive)`);
    seen.add(fold(key));
    repos.set(key, repoSettings(key, repoMap[key]));
  }
  for (const [name, dir] of [['stateDir', stateDir], ['scratch', scratch]] as const) {
    if (dir === null) continue;
    const clash = keys.find((key) => overlaps(key, dir));
    if (clash !== undefined) throw fail(`${name} ${JSON.stringify(dir)} overlaps the repository ${JSON.stringify(clash)}: state must live outside every repo`);
  }
  if (scratch !== null && overlaps(scratch, stateDir)) throw fail('scratch and stateDir must not overlap');
  const memory = plain(top.memory ?? {}, 'memory', ['agents', 'glossary', 'adr']);
  return {
    version: 1,
    stateDir,
    repos,
    memory: {
      agents: memory.agents === undefined ? 'AGENTS.md' : cleanRel(memory.agents, 'memory.agents'),
      glossary: memory.glossary === undefined ? null : cleanRel(memory.glossary, 'memory.glossary'),
      adr: memory.adr === undefined ? 'docs/adr' : cleanRel(memory.adr, 'memory.adr'),
    },
    scratch,
  };
}

export interface Stat {
  isSymbolicLink(): boolean;
  isFile(): boolean;
  isDirectory(): boolean;
  size: number;
  uid: number;
  mode: number;
}

export interface FsIo {
  /** The current user id; null where ownership cannot be checked (Windows). */
  uid: number | null;
  lstat(file: string): Stat | null;
  /** Throws when the path does not exist. */
  realpath(file: string): string;
  read(file: string): string;
  /** Entry names; throws when the directory cannot be read. */
  readdir(dir: string): string[];
}

/** The current user id; null where the platform has none (Windows). */
export const currentUid = (getuid: (() => number) | null | undefined = process.getuid): number | null => (typeof getuid === 'function' ? getuid.call(process) : null);

export const realFsIo: FsIo = {
  uid: currentUid(),
  lstat(file) {
    try {
      return lstatSync(file);
    } catch {
      return null;
    }
  },
  realpath: (file) => realpathSync.native(file),
  read: (file) => readFileSync(file, 'utf8'),
  readdir: (dir) => readdirSync(dir),
};

export const defaultHome = (): string => process.env.H7_HOME ?? homedir();

export const sha256 = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
export const trustFile = (home: string): string => path.join(home, '.h7', 'workspaces.json');

/** Recorded hashes by lowercased marker path; empty for a missing, unreadable or malformed file. */
export function readTrust(io: FsIo, home: string): Map<string, string> {
  const hashes = new Map<string, string>();
  let raw: unknown;
  try {
    raw = JSON.parse(io.read(trustFile(home)));
  } catch {
    return hashes;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return hashes;
  for (const [file, hash] of Object.entries(raw)) if (typeof hash === 'string') hashes.set(fold(file), hash.toLowerCase());
  return hashes;
}

export function trustOf(io: FsIo, home: string, file: string, text: string): Trust {
  const recorded = readTrust(io, home).get(fold(file));
  if (recorded === undefined) return 'untrusted';
  return recorded === sha256(text) ? 'trusted' : 'changed';
}

const slash = (p: string): string => p.split(path.sep).join('/');

function inside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

/** The real path of the nearest existing ancestor plus the missing tail: where a not-yet-created path would land. */
export function canonicalPath(io: FsIo, target: string): string {
  const rest: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = io.realpath(current);
      return rest.length === 0 ? real : path.join(real, ...rest.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

/** Nearest ancestor of dir (or dir itself) holding a `.git` (directory or file). */
export function findRepoRoot(dir: string, io: Pick<FsIo, 'lstat'>): string | null {
  let current = dir;
  for (;;) {
    if (io.lstat(path.join(current, '.git')) !== null) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** CONTEXT.md unless only GLOSSARY.md exists in dir. */
export function glossaryName(io: Pick<FsIo, 'lstat'>, dir: string): string {
  return io.lstat(path.join(dir, 'CONTEXT.md')) === null && io.lstat(path.join(dir, 'GLOSSARY.md')) !== null ? 'GLOSSARY.md' : 'CONTEXT.md';
}

export interface Workspace {
  /** Real path of the directory holding the marker. */
  root: string;
  markerPath: string;
  /** Key in `repos`: the repository path relative to the root. */
  repo: string;
  repoRoot: string;
  /** Absolute runtime directory for this repo: `<root>/<stateDir>/<repo>`. */
  stateDir: string;
  marker: Marker;
  /** As declared, except push and auto-merge are dropped when the marker owner could not be verified. */
  settings: RepoSettings;
  /** Hash trust of the marker contents (see Trust). */
  trust: Trust;
  /** Ownership verified (POSIX) AND the contents are trusted: only then are scratch, push and auto-merge honoured. */
  trusted: boolean;
  /** Absolute paths, all checked to stay inside the workspace. */
  files: { verification: string; prTemplate: string | null; agents: string; glossary: string; adr: string };
  scratch: string | null;
}

/** POSIX: the marker and its directory belong to the current user and nobody else can write them. Anything else is an error, never a quiet skip. */
function checkOwner(path: string, what: string, io: FsIo): void {
  if (io.uid === null) return;
  const stat = io.lstat(path) as Stat;
  if (stat.uid !== io.uid) throw fail(`${what} ${path} is owned by uid ${stat.uid}, not by you (uid ${io.uid}); refusing to trust it`);
  if ((stat.mode & 0o022) !== 0) throw fail(`${what} ${path} is writable by group or others (mode ${(stat.mode & 0o777).toString(8)}); refusing to trust it`);
}

function readMarker(file: string, io: FsIo): { marker: Marker; text: string } {
  const stat = io.lstat(file) as Stat;
  if (stat.isSymbolicLink()) throw fail(`${file} is a symlink; refusing to follow it`);
  if (!stat.isFile()) throw fail(`${file} is not a regular file`);
  if (stat.size > MAX_MARKER_BYTES) throw fail(`${file} is larger than ${MAX_MARKER_BYTES} bytes`);
  let text: string;
  try {
    text = io.read(file);
  } catch (error) {
    throw fail(`cannot read ${file}: ${(error as Error).message}`);
  }
  try {
    return { marker: parseMarker(text), text };
  } catch (error) {
    throw fail(`${file}: ${(error as Error).message}`);
  }
}

function build(root: string, file: string, marker: Marker, key: string, real: string, io: FsIo, trust: Trust): Workspace {
  const confine = (rel: string, what: string): string => {
    const abs = path.join(root, rel);
    if (!inside(root, canonicalPath(io, abs))) throw fail(`${file}: ${what} resolves outside the workspace (symlink?)`);
    return abs;
  };
  const repoDirs = [...marker.repos.keys()].map((name) => canonicalPath(io, path.join(root, name)));
  const outsideRepos = (abs: string, what: string): string => {
    const real = canonicalPath(io, abs);
    if (repoDirs.some((repo) => inside(repo, real))) throw fail(`${file}: ${what} resolves inside a repository (symlink?): state must live outside every repo`);
    return abs;
  };
  const stateDir = outsideRepos(confine(`${marker.stateDir}/${key}`, 'stateDir'), 'stateDir');
  const scratch = marker.scratch === null ? null : outsideRepos(confine(marker.scratch, 'scratch'), 'scratch');
  // Push and auto-merge are only honoured from a marker whose ownership was actually verified (POSIX); elsewhere the user says so per run.
  const trusted = trust === 'trusted';
  const declared = marker.repos.get(key) as RepoSettings;
  const settings: RepoSettings = { ...declared, ship: trusted ? declared.ship : 'pr', autoMerge: trusted && declared.autoMerge };
  const glossary = marker.memory.glossary ?? glossaryName(io, root);
  return {
    root,
    markerPath: file,
    repo: key,
    repoRoot: real,
    stateDir,
    marker,
    settings,
    trust,
    trusted,
    files: {
      verification: confine(settings.verification, 'verification'),
      prTemplate: settings.prTemplate === null ? null : confine(settings.prTemplate, 'prTemplate'),
      agents: confine(marker.memory.agents, 'memory.agents'),
      glossary: confine(glossary, 'memory.glossary'),
      adr: confine(marker.memory.adr, 'memory.adr'),
    },
    scratch,
  };
}

/**
 * Walks up from the REAL repo top level, only through directories strictly inside the REAL home: a repo outside home never gets workspace mode, and
 * a marker in home itself or above it (a shared /tmp, a parent of a cloned repo) is never looked at. The nearest marker that LISTS the repo wins;
 * one that does not is skipped. A marker that cannot be trusted (symlink, wrong owner, group/world writable, too big, malformed) throws.
 */
export function workspaceFor(repoRoot: string, io: FsIo, home: string): Workspace | null {
  const realHome = canonicalPath(io, home);
  const real = canonicalPath(io, repoRoot);
  if (!inside(realHome, real) || fold(realHome) === fold(real)) return null;
  for (let dir = path.dirname(real); fold(dir) !== fold(realHome); dir = path.dirname(dir)) {
    const file = path.join(dir, MARKER);
    if (io.lstat(file) === null) continue;
    checkOwner(file, 'workspace marker', io);
    checkOwner(dir, 'workspace directory', io);
    const { marker, text } = readMarker(file, io);
    const key = [...marker.repos.keys()].find((name) => fold(name) === fold(slash(path.relative(dir, real))));
    if (key !== undefined) return build(dir, file, marker, key, real, io, trustOf(io, home, file, text));
  }
  return null;
}

export interface Located {
  dir: string;
  file: string;
  marker: Marker;
  text: string;
  trust: Trust;
}

/** The nearest trusted marker at or above cwd (strictly inside the real home), listing cwd's repo or not. For doctor. Same trust rules and errors as workspaceFor. */
export function locateMarker(cwd: string, io: FsIo, home: string): Located | null {
  const realHome = canonicalPath(io, home);
  if (!inside(realHome, canonicalPath(io, cwd))) return null;
  for (let dir = canonicalPath(io, cwd); fold(dir) !== fold(realHome); dir = path.dirname(dir)) {
    const file = path.join(dir, MARKER);
    if (io.lstat(file) === null) continue;
    checkOwner(file, 'workspace marker', io);
    checkOwner(dir, 'workspace directory', io);
    const { marker, text } = readMarker(file, io);
    return { dir, file, marker, text, trust: trustOf(io, home, file, text) };
  }
  return null;
}

export const MAX_SCRATCH_ENTRIES = 2000;

/** True when any directory at or below dir (symlinks not followed) has a .git entry; a tree that is too large or cannot be read counts as yes (fail closed). */
function gitBelow(io: FsIo, dir: string, budget: { left: number }): boolean {
  let names: string[];
  try {
    names = io.readdir(dir);
  } catch {
    return true; // cannot look: doubtful, so no scratch
  }
  for (const name of names) {
    budget.left -= 1;
    if (name === '.git' || budget.left < 0) return true;
    const child = path.join(dir, name);
    const stat = io.lstat(child);
    if (stat === null || (!stat.isSymbolicLink() && stat.isDirectory() && gitBelow(io, child, budget))) return true;
  }
  return false;
}

/** True when dir or any directory above it up to (not including) home has a .git entry: dir lies inside a git work tree. */
function insideWorkTree(io: FsIo, dir: string, realHome: string): boolean {
  for (let current = dir; inside(realHome, current) && fold(current) !== fold(realHome); current = path.dirname(current)) {
    if (io.lstat(path.join(current, '.git')) !== null) return true;
  }
  return false;
}

/**
 * The scratch directory the guard counts as inside the repo, as a one-element list; empty for anything doubtful. It comes ONLY from the validated
 * workspace of the current repo (marker strictly above the repo root, listing it, owner verified: where ownership cannot be checked there is no
 * scratch), and additionally must not contain or sit inside any git work tree, and the marker's own directory must not either.
 */
export function scratchDirs(cwd: string, io: FsIo, home: string): string[] {
  try {
    const repoRoot = findRepoRoot(cwd, io);
    const ws = repoRoot === null ? null : workspaceFor(repoRoot, io, home);
    if (ws === null || !ws.trusted || ws.scratch === null) return [];
    const realHome = canonicalPath(io, home);
    const scratch = canonicalPath(io, ws.scratch);
    if (insideWorkTree(io, scratch, realHome) || insideWorkTree(io, ws.root, realHome) || gitBelow(io, scratch, { left: MAX_SCRATCH_ENTRIES })) return [];
    return [scratch];
  } catch {
    return [];
  }
}

/** The guard's temp-dir info extended with the workspace scratch directory, looked up only when a delete rule reads it. */
export function withScratch(dirs: string[], cwd: string, home: string, io: FsIo = realFsIo): { readonly dirs: string[] } {
  let cached: string[] | null = null;
  return {
    get dirs() {
      cached ??= [...dirs, ...scratchDirs(cwd, io, home)];
      return cached;
    },
  };
}

export function findWorkspace(cwd: string, io: FsIo = realFsIo, home: string = defaultHome()): Workspace | null {
  const repoRoot = findRepoRoot(cwd, io);
  return repoRoot === null ? null : workspaceFor(repoRoot, io, home);
}

export interface Context {
  repoRoot: string | null;
  workspace: Workspace | null;
  /** Where runtime state (journals, verify.json, scope.json, review/, ci-watch.json, retro rows) goes. */
  stateDir: string;
  /** State files must stay inside this directory: the workspace root, else the repo root (or the start directory outside a repo). */
  containRoot: string;
}

export function resolveContext(cwd: string, io: FsIo = realFsIo, home: string = defaultHome()): Context {
  const start = cwd;
  const repoRoot = findRepoRoot(start, io);
  const workspace = repoRoot === null ? null : workspaceFor(repoRoot, io, home);
  if (workspace !== null) return { repoRoot, workspace, stateDir: workspace.stateDir, containRoot: workspace.root };
  const root = repoRoot ?? start;
  return { repoRoot, workspace: null, stateDir: path.join(root, '.h7'), containRoot: root };
}

/** Where one repo's journal state lives: in the repo's own .h7 directory normally, under the workspace state directory in workspace mode (nothing is then written inside the repo). */
export interface Place {
  root: string;
  state: string;
  /** Writes must stay inside this directory. */
  contain: string;
  /** state relative to contain, for the symlink walk. */
  parts: string[];
  workspace: boolean;
  /** The AGENTS.md that retro rows go into: the workspace one in workspace mode. */
  agents: string;
}

export function placeOf(root: string, fs: FsIo = realFsIo, home: string = defaultHome()): Place {
  const ws = workspaceFor(root, fs, home);
  if (ws === null) return { root, state: path.join(root, '.h7'), contain: root, parts: ['.h7'], workspace: false, agents: path.join(root, 'AGENTS.md') };
  return { root, state: ws.stateDir, contain: ws.root, parts: path.relative(ws.root, ws.stateDir).split(path.sep), workspace: true, agents: ws.files.agents };
}

export const stateDir = (cwd: string, io?: FsIo, home?: string): string => resolveContext(cwd, io, home).stateDir;

export interface Settings {
  mode: 'workspace' | 'repo';
  base: string | null;
  /** Absolute path of the verification recipe. */
  verification: string;
  prTemplate: string | null;
  /** null: not configured here; read the Ship section of the verification file. */
  ship: 'pr' | 'push' | null;
  autoMerge: boolean | null;
}

export function settings(cwd: string, io?: FsIo, home?: string): Settings {
  const context = resolveContext(cwd, io, home);
  const { workspace } = context;
  if (workspace === null) return { mode: 'repo', base: null, verification: path.join(context.repoRoot ?? cwd, 'docs', 'agents', 'verification.md'), prTemplate: null, ship: null, autoMerge: null };
  const { settings: repo, files } = workspace;
  return { mode: 'workspace', base: repo.base, verification: files.verification, prTemplate: files.prTemplate, ship: repo.ship, autoMerge: repo.autoMerge };
}

/** The configured base branch of this repo in workspace mode, else null. */
export const base = (cwd: string, io?: FsIo, home?: string): string | null => settings(cwd, io, home).base;

export interface Memory {
  agents: string;
  glossary: string;
  adr: string;
}

/** Absolute paths of the repo memory files: the workspace's in workspace mode, else the repo's own AGENTS.md, CONTEXT.md (or GLOSSARY.md) and docs/adr. */
export function memory(cwd: string, io: FsIo = realFsIo, home?: string): Memory {
  const context = resolveContext(cwd, io, home);
  if (context.workspace !== null) return { agents: context.workspace.files.agents, glossary: context.workspace.files.glossary, adr: context.workspace.files.adr };
  const root = context.repoRoot ?? cwd;
  return { agents: path.join(root, 'AGENTS.md'), glossary: path.join(root, glossaryName(io, root)), adr: path.join(root, 'docs', 'adr') };
}

const USAGE = 'usage: workspace.ts show | state-dir | status | trust [<marker>]';

export function main(argv: string[], out: (text: string) => void, err: (text: string) => void, cwd: string = process.cwd(), io: FsIo = realFsIo, home: string = defaultHome()): number {
  const [cmd, ...rest] = argv;
  if ((cmd !== 'show' && cmd !== 'state-dir' && cmd !== 'status') || rest.length > 0) {
    err(USAGE);
    return 2;
  }
  try {
    const context = resolveContext(cwd, io, home);
    if (cmd === 'status') {
      const found = locateMarker(cwd, io, home);
      out(JSON.stringify(found === null ? { marker: null } : { marker: slash(found.file), sha256: sha256(found.text), trust: found.trust, ownerVerified: io.uid !== null, note: found.trust === 'trusted' ? 'scratch, push and auto-merge from this marker are honoured' : 'scratch, push and auto-merge are ignored until you run: workspace.ts trust' }));
      return 0;
    }
    if (cmd === 'state-dir') {
      out(slash(context.stateDir));
      return 0;
    }
    const s = settings(cwd, io, home);
    const m = memory(cwd, io, home);
    const ws = context.workspace;
    const orNull = (p: string | null): string | null => (p === null ? null : slash(p));
    out(JSON.stringify({
      mode: s.mode,
      workspace: ws === null ? null : slash(ws.root),
      repo: ws === null ? null : ws.repo,
      repoRoot: orNull(context.repoRoot),
      stateDir: slash(context.stateDir),
      base: s.base,
      verification: slash(s.verification),
      prTemplate: orNull(s.prTemplate),
      ship: s.ship,
      autoMerge: s.autoMerge,
      memory: { agents: slash(m.agents), glossary: slash(m.glossary), adr: slash(m.adr) },
      scratch: ws === null ? null : orNull(ws.scratch),
      trust: ws === null ? null : ws.trust,
      trusted: ws === null ? null : ws.trusted,
    }));
    return 0;
  } catch (error) {
    err(error instanceof WorkspaceError ? error.message : `workspace failed: ${(error as Error).message}`);
    return 2;
  }
}

/** An open controlling terminal: where the code and the marker are shown and the answer is read from. Never stdin, stdout or stderr. */
export interface TtyDevice {
  write(text: string): void;
  read(question: string): Promise<string>;
  close(): void;
}

export interface TrustDeps {
  /** The controlling terminal opened directly, or null when there is none (then nothing is trusted). */
  openTty(): TtyDevice | null;
  /** A fresh random code the person must type. */
  nonce(): string;
  mkdir(dir: string): void;
  write(file: string, text: string, root: string): void;
}

export const ttyPaths = (platform: string): { input: string; output: string } => (platform === 'win32' ? { input: 'CONIN$', output: 'CONOUT$' } : { input: '/dev/tty', output: '/dev/tty' });

export type OpenFd = (file: string, flags: string) => number;

/**
 * Opens the controlling terminal directly (/dev/tty, or CONIN$ and CONOUT$ on Windows). A process whose stdio is piped, scripted or recorded can
 * not answer on it, which is the point; but a pty wrapper that gives the process a controlling terminal can, so this is one layer, not a boundary.
 */
export function openTty(platform: string = process.platform, open: OpenFd = openSync): TtyDevice | null {
  const paths = ttyPaths(platform);
  let input: number;
  let output: number;
  try {
    input = open(paths.input, 'r');
    output = open(paths.output, 'w');
  } catch {
    return null;
  }
  const source = createReadStream('', { fd: input });
  const lines = createInterface({ input: source });
  return {
    write: (text) => void writeSync(output, text),
    read: (question) => {
      writeSync(output, question);
      return lines.question('');
    },
    close: () => {
      lines.close();
      source.destroy();
      closeSync(output);
    },
  };
}

export const realTrustDeps = (): TrustDeps => ({
  openTty,
  nonce: () => String(randomInt(100000, 1000000)),
  mkdir: (dir) => void mkdirSync(dir, { recursive: true, mode: 0o700 }),
  write: (file, text, root) => writeAtomic(file, text, root, undefined, undefined, 0o600),
});

/**
 * `workspace.ts trust [<marker>]`, run by the person in their own terminal: shows the marker and a random code ONLY on the controlling terminal
 * (opened directly, not stdin/stdout/stderr, which an agent sees), and records the sha256 of exactly that text when the same code is typed back there.
 * Without a terminal it refuses. stdout says only "trusted" or "refused". Refuses for a marker that is not trustworthy and for a malformed trust file.
 */
export async function trustMain(args: string[], out: (text: string) => void, err: (text: string) => void, cwd: string, io: FsIo, home: string, deps: TrustDeps): Promise<number> {
  const tty = deps.openTty();
  if (tty === null) {
    err('refusing: no controlling terminal could be opened. Run this yourself, in your own terminal; an agent cannot do it for you.');
    out('refused');
    return 2;
  }
  const code = await confirm(args, out, err, cwd, io, home, deps, tty).catch((error: unknown) => {
    err(error instanceof WorkspaceError ? error.message : `workspace failed: ${(error as Error).message}`);
    out('refused');
    return 2;
  });
  tty.close();
  return code;
}

async function confirm(args: string[], out: (text: string) => void, err: (text: string) => void, cwd: string, io: FsIo, home: string, deps: TrustDeps, tty: TtyDevice): Promise<number> {
  {
    const [target, ...extra] = args;
    if (extra.length > 0) throw fail(USAGE);
    const start = target === undefined ? cwd : path.resolve(cwd, path.basename(target) === MARKER ? path.dirname(target) : target);
    const found = locateMarker(start, io, home);
    if (found === null || (target !== undefined && fold(found.dir) !== fold(canonicalPath(io, start)))) throw fail(`no ${MARKER} found ${target === undefined ? 'above here' : `in ${target}`}`);
    const code = deps.nonce();
    tty.write(`\nMarker: ${found.file}\nSHA-256: ${sha256(found.text)}\nState: ${found.trust}\n----\n${found.text}\n----\nTrusting it lets this workspace set a scratch directory the guard treats as safe to delete in, and ship defaults (push, auto-merge).\n`);
    if ((await tty.read(`Type ${code} to trust exactly this text (anything else cancels): `)).trim() !== code) {
      out('refused');
      return 1;
    }
    const existing = readTrustText(io, home);
    existing[found.file] = sha256(found.text);
    deps.mkdir(path.dirname(trustFile(home)));
    deps.write(trustFile(home), `${JSON.stringify(existing, null, 2)}\n`, home);
    out('trusted');
    return 0;
  }
}

/** The trust file as a plain object, to be extended; absent means empty, a malformed one is an error (never silently replaced). */
function readTrustText(io: FsIo, home: string): Record<string, string> {
  let text: string;
  try {
    text = io.read(trustFile(home));
  } catch {
    return {};
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw fail(`${trustFile(home)} is not valid JSON; fix or remove it`);
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw fail(`${trustFile(home)} must be a JSON object; fix or remove it`);
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** The command line: `trust` is interactive, everything else is `main`. */
export async function cli(argv: string[], out: (text: string) => void, err: (text: string) => void, cwd: string, io: FsIo, home: string, deps: TrustDeps): Promise<number> {
  const [cmd, ...rest] = argv;
  return cmd === 'trust' ? trustMain(rest, out, err, cwd, io, home, deps) : main(argv, out, err, cwd, io, home);
}

if (import.meta.main) {
  const out = (text: string): void => console.log(text);
  const err = (text: string): void => console.error(text);
  process.exitCode = await cli(process.argv.slice(2), out, err, process.cwd(), realFsIo, defaultHome(), realTrustDeps());
}
