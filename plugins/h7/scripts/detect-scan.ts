import { posix } from 'node:path';
import type { Repo } from './detect-fs.ts';

const { basename, dirname, join } = posix;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const strMap = (v: unknown): Record<string, string> =>
  isObj(v) ? (Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string')) as Record<string, string>) : {};

export function filesNamed(repo: Repo, test: (base: string) => boolean): string[] {
  return repo.files.filter((f) => test(basename(f)));
}

/** Lowercased word-like tokens (names, module paths) of a text, deduplicated. */
export function tokens(text: string): string[] {
  return [...new Set((text.toLowerCase().match(/[a-z0-9@][a-z0-9_.@/-]*/g) ?? []).map((t) => t.replace(/_/g, '-')))];
}

export interface NodePkg {
  dir: string;
  name: string;
  deps: string[];
  scripts: Record<string, string>;
  /** Bin paths relative to the repo root. */
  bins: string[];
  hasEntry: boolean;
  private: boolean;
  workspaces: string[];
  packageManager: string | null;
}

export function nodePackages(repo: Repo, warnings: string[]): NodePkg[] {
  const out: NodePkg[] = [];
  for (const rel of filesNamed(repo, (b) => b === 'package.json')) {
    let json: unknown;
    try {
      json = JSON.parse(String(repo.read(rel)));
    } catch {
      json = null;
    }
    if (!isObj(json)) {
      warnings.push(`unparseable ${rel}`);
      continue;
    }
    const dir = dirname(rel);
    const bin = json.bin;
    const ws = json.workspaces;
    out.push({
      dir,
      name: typeof json.name === 'string' ? json.name : dir,
      deps: [
        ...Object.keys(strMap(json.dependencies)),
        ...Object.keys(strMap(json.devDependencies)),
        ...Object.keys(strMap(json.peerDependencies)),
        ...Object.keys(strMap(json.optionalDependencies)),
      ].sort(),
      scripts: strMap(json.scripts),
      bins: (typeof bin === 'string' ? [bin] : Object.values(strMap(bin))).map((p) => join(dir, p)),
      hasEntry: ['main', 'module', 'exports', 'types'].some((k) => json[k] !== undefined),
      private: json.private === true,
      workspaces: Array.isArray(ws) ? strList(ws) : isObj(ws) ? strList(ws.packages) : [],
      packageManager: typeof json.packageManager === 'string' ? json.packageManager : null,
    });
  }
  return out;
}

/** Body of a `[name]` section (until the next header), or null. */
export function tomlSection(text: string, name: string): string | null {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `[${name}]`);
  if (start === -1) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

export function tomlSections(text: string): string[] {
  return [...text.matchAll(/^\s*\[+\s*([^\]]+?)\s*\]+\s*$/gm)].map((m) => m[1] as string);
}

const quoted = (text: string): string[] => [...text.matchAll(/["']([^"']+)["']/g)].map((m) => m[1] as string);

export interface Crate {
  dir: string;
  name: string | null;
  workspaceMembers: string[];
  isWorkspace: boolean;
  hasBin: boolean;
  hasLib: boolean;
  deps: string[];
}

export function crates(repo: Repo): Crate[] {
  return filesNamed(repo, (b) => b === 'Cargo.toml').map((rel) => {
    const text = repo.read(rel) as string;
    const dir = dirname(rel);
    const pkg = tomlSection(text, 'package');
    const members = /members\s*=\s*\[([^\]]*)\]/s.exec(text);
    return {
      dir,
      name: pkg === null ? null : (/^\s*name\s*=\s*"([^"]+)"/m.exec(pkg)?.[1] ?? null),
      workspaceMembers: members === null ? [] : quoted(members[1] as string),
      isWorkspace: tomlSection(text, 'workspace') !== null,
      hasBin: repo.has(join(dir, 'src/main.rs')) || /^\s*\[\[bin\]\]/m.test(text),
      hasLib: repo.has(join(dir, 'src/lib.rs')),
      deps: tokens(text),
    };
  });
}

export interface GoModule {
  dir: string;
  name: string | null;
  /** Directories that hold `package main`. */
  mains: string[];
  deps: string[];
}

export function goModules(repo: Repo): GoModule[] {
  const modDirs = filesNamed(repo, (b) => b === 'go.mod').map((f) => dirname(f));
  return filesNamed(repo, (b) => b === 'go.mod').map((rel) => {
      const text = repo.read(rel) as string;
      const dir = dirname(rel);
      const prefix = dir === '.' ? '' : `${dir}/`;
      const mains = repo.files
        .filter((f) => f.startsWith(prefix) && basename(f) === 'main.go')
        .filter((f) => !modDirs.some((o) => o !== dir && o.length > dir.length && f.startsWith(`${o}/`)))
        .filter((f) => /^package\s+main\b/m.test(repo.read(f) as string))
        .map((f) => dirname(f));
      return { dir, name: /^module\s+(\S+)/m.exec(text)?.[1] ?? null, mains, deps: tokens(text) };
    });
}

/** `use` directories of go.work files, relative to the repo root. */
export function goWorkUses(repo: Repo): string[] {
  const out: string[] = [];
  for (const rel of filesNamed(repo, (b) => b === 'go.work')) {
    const text = repo.read(rel) as string;
    const base = dirname(rel);
    const block = [...text.matchAll(/^use\s+\(([^)]*)\)/gm)].flatMap((m) => (m[1] as string).split(/\r?\n/).map((l) => l.trim()));
    const single = [...text.matchAll(/^use\s+([^\s(]\S*)/gm)].map((m) => m[1] as string);
    for (const use of [...block, ...single].filter((u) => u !== '' && !u.startsWith('//'))) out.push(join(base, use));
  }
  return out;
}

export type PyManager = 'poetry' | 'uv' | 'pdm' | 'pipenv' | 'pip';

export interface PyProject {
  dir: string;
  manager: PyManager;
  /** Console scripts declared in pyproject. */
  scripts: string[];
  deps: string[];
  sections: string[];
  hasManage: boolean;
}

const PY_FILE = /^(pyproject\.toml|setup\.py|setup\.cfg|Pipfile|requirements[\w.-]*\.txt)$/;

export function pythonProjects(repo: Repo): PyProject[] {
  const dirs = [...new Set(repo.files.filter((f) => PY_FILE.test(basename(f))).map((f) => dirname(f)))].sort();
  return dirs.map((dir) => {
    const at = (name: string): string => join(dir, name);
    const texts = repo.files.filter((f) => dirname(f) === dir && PY_FILE.test(basename(f))).map((f) => repo.read(f) as string);
    const toml = repo.read(at('pyproject.toml')) ?? '';
    const sections = tomlSections(toml);
    const has = (prefix: string, lock: string): boolean => sections.some((s) => s.startsWith(prefix)) || repo.has(at(lock));
    const manager: PyManager = has('tool.poetry', 'poetry.lock')
      ? 'poetry'
      : has('tool.uv', 'uv.lock')
        ? 'uv'
        : has('tool.pdm', 'pdm.lock')
          ? 'pdm'
          : repo.has(at('Pipfile'))
            ? 'pipenv'
            : 'pip';
    const bodies = ['project.scripts', 'tool.poetry.scripts'].map((s) => tomlSection(toml, s) ?? '');
    return {
      dir,
      manager,
      scripts: bodies.flatMap((b) => [...b.matchAll(/^\s*([\w.-]+)\s*=/gm)].map((m) => m[1] as string)),
      deps: tokens(texts.join('\n')),
      sections,
      hasManage: repo.has(at('manage.py')),
    };
  });
}

export interface Target {
  source: 'make' | 'just' | 'task';
  dir: string;
  name: string;
  command: string;
}

const MAKE_FILE = /^(Makefile|makefile|GNUmakefile)$/;
const JUST_FILE = /^(justfile|Justfile|\.justfile)$/;
const TASK_FILE = /^Taskfile\.ya?ml$/;

export function targets(repo: Repo): { targets: Target[]; recipeLines: string[] } {
  const out: Target[] = [];
  const recipeLines: string[] = [];
  const add = (source: Target['source'], file: string, names: string[]): void => {
    for (const name of new Set(names)) out.push({ source, dir: dirname(file), name, command: `${source} ${name}` });
  };
  const named = (re: RegExp): string[] => repo.files.filter((f) => re.test(basename(f)));
  for (const file of named(MAKE_FILE)) {
    const text = repo.read(file) as string;
    add('make', file, [...text.matchAll(/^([A-Za-z0-9][\w./-]*)\s*:(?!=)/gm)].map((m) => m[1] as string));
    recipeLines.push(...text.split(/\r?\n/).filter((l) => l.startsWith('\t')).map((l) => l.trim()));
  }
  for (const file of named(JUST_FILE)) {
    const text = repo.read(file) as string;
    add('just', file, [...text.matchAll(/^@?([A-Za-z_][\w-]*)(?:[ \t][^:\n]*)?:(?!=)/gm)].map((m) => m[1] as string));
    recipeLines.push(...text.split(/\r?\n/).filter((l) => /^[ \t]+\S/.test(l)).map((l) => l.trim()));
  }
  for (const file of named(TASK_FILE)) {
    const lines = (repo.read(file) as string).split(/\r?\n/);
    const start = lines.findIndex((l) => /^tasks:\s*$/.test(l));
    const names: string[] = [];
    for (const line of start === -1 ? [] : lines.slice(start + 1)) {
      if (/^\S/.test(line)) break;
      const m = /^ {2}([\w:.-]+):/.exec(line);
      if (m) names.push(m[1] as string);
    }
    add('task', file, names);
  }
  return { targets: out, recipeLines };
}

/** Glob (`*`, `**`) to anchored regex. */
export function globToRegex(glob: string): RegExp {
  const body = glob
    .replace(/^\.\//, '')
    .replace(/\/+$/, '')
    .split('**')
    .map((part) => part.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${body}$`);
}

/** Items of a top-level `key:` YAML block list. */
export function yamlList(text: string, key: string): string[] {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === `${key}:` && !/^\s/.test(l));
  const out: string[] = [];
  for (const line of start === -1 ? [] : lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const m = /^\s*-\s+["']?([^"'#]+?)["']?\s*(?:#.*)?$/.exec(line);
    if (m) out.push(m[1] as string);
  }
  return out;
}
