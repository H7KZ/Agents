import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Workspace mode: one developer's h7 state for several team repos lives OUTSIDE the repos, next to a marker file in an
 * ancestor directory. This module is the single resolver every script uses to find where `.h7/` state goes and which
 * verification settings apply. No marker, or a marker that does not list the repo: nothing changes (`<repo>/.h7`).
 */
export const MARKER = '.h7-workspace.json';
export const MAX_MARKER_BYTES = 65536;
export const MAX_REPOS = 200;

export class WorkspaceError extends Error {}

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
}

export const realFsIo: FsIo = {
  /* node:coverage ignore next */
  uid: typeof process.getuid === 'function' ? process.getuid() : null,
  lstat(file) {
    try {
      return lstatSync(file);
    } catch {
      return null;
    }
  },
  realpath: (file) => realpathSync(file),
  read: (file) => readFileSync(file, 'utf8'),
};

export const defaultHome = (): string => process.env.H7_HOME ?? homedir();

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
  /** The marker and its directory passed the ownership checks (POSIX only). */
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

function readMarker(file: string, io: FsIo): Marker {
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
    return parseMarker(text);
  } catch (error) {
    throw fail(`${file}: ${(error as Error).message}`);
  }
}

function build(root: string, file: string, marker: Marker, key: string, real: string, io: FsIo): Workspace {
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
  const trusted = io.uid !== null;
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
    const marker = readMarker(file, io);
    const key = [...marker.repos.keys()].find((name) => fold(name) === fold(slash(path.relative(dir, real))));
    if (key !== undefined) return build(dir, file, marker, key, real, io);
  }
  return null;
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

const USAGE = 'usage: workspace.ts show | state-dir';

export function main(argv: string[], out: (text: string) => void, err: (text: string) => void, cwd: string = process.cwd(), io: FsIo = realFsIo, home: string = defaultHome()): number {
  const [cmd, ...rest] = argv;
  if ((cmd !== 'show' && cmd !== 'state-dir') || rest.length > 0) {
    err(USAGE);
    return 2;
  }
  try {
    const context = resolveContext(cwd, io, home);
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
    }));
    return 0;
  } catch (error) {
    err(error instanceof WorkspaceError ? error.message : `workspace failed: ${(error as Error).message}`);
    return 2;
  }
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), (t) => console.log(t), (t) => console.error(t));
}
