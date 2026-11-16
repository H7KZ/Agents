import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const ROLES = ['author', 'reviewer', 'verifier', 'cheap'] as const;
export type Role = (typeof ROLES)[number];
export type Models = Partial<Record<Role, string>>;

export type LoadStatus = 'ok' | 'missing' | 'corrupt';

export interface Loaded {
  file: string;
  status: LoadStatus;
  models: Models;
}

/** `~/.h7/models.json` (or `$H7_HOME/.h7/models.json`). Read only: nothing here ever writes. */
export const modelsFile = (home: string): string => path.join(home, '.h7', 'models.json');

/** Role to model name. Null for anything that is not a JSON object; unknown roles and non-string or blank values are ignored. Never throws. */
export function parseModels(text: string): Models | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const models: Models = {};
  for (const role of ROLES) {
    const value = (raw as Record<string, unknown>)[role];
    if (typeof value === 'string' && value.trim() !== '') models[role] = value.trim();
  }
  return models;
}

export type Read = (file: string) => string | null;

export const realRead: Read = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

export function loadModels(home: string, read: Read = realRead): Loaded {
  const file = modelsFile(home);
  const text = read(file);
  if (text === null) return { file, status: 'missing', models: {} };
  const models = parseModels(text);
  return models === null ? { file, status: 'corrupt', models: {} } : { file, status: 'ok', models };
}

export interface Reviewer {
  /** Model to pass to the reviewer subagents; null when no independent model is available. */
  model: string | null;
  status: 'ok' | 'unverified' | 'unconfigured' | 'same-as-author';
  author: string | null;
  note: string;
}

const FAMILY = /(opus|sonnet|haiku|fable)/;

/** Comparable identity of a model name: its family when it names one (so `sonnet` and `claude-sonnet-4-5` agree), else the lowercase name without a `claude-` prefix. */
const canon = (model: string): string => {
  const lower = model.trim().toLowerCase();
  return FAMILY.exec(lower)?.[1] ?? lower.replace(/^claude[-_ ]?/, '');
};

const same = (a: string, b: string): boolean => canon(a) === canon(b);

/** Reviewer model must differ from the author model. `author` (the running session's model) wins over the configured author. */
export function pickReviewer(models: Models, author?: string): Reviewer {
  const known = author !== undefined && author.trim() !== '' ? author.trim() : (models.author ?? null);
  if (models.reviewer === undefined) {
    return { model: null, status: 'unconfigured', author: known, note: 'no reviewer model configured: set "reviewer" in ~/.h7/models.json' };
  }
  if (known !== null && same(models.reviewer, known)) {
    return { model: null, status: 'same-as-author', author: known, note: `reviewer model ${models.reviewer} equals the author model: pick a different one in ~/.h7/models.json` };
  }
  if (known === null) {
    return { model: models.reviewer, status: 'unverified', author: null, note: 'author model unknown: pass --author <model> or set "author" in ~/.h7/models.json; independence is unverified' };
  }
  return { model: models.reviewer, status: 'ok', author: known, note: 'reviewer model differs from the author model' };
}

export interface ExternalReviewer {
  name: string;
  path: string;
}

export const EXTERNAL_CLIS = ['codex', 'gemini'] as const;

export type Exists = (file: string) => boolean;

const WIN_EXT = ['.exe', '.cmd', '.bat', '.com', '.ps1'];

/** codex and gemini found on PATH. Detection only: nothing is executed. */
export function findExternalReviewers(platform: string, pathVar: string, exists: Exists): ExternalReviewer[] {
  const api = platform === 'win32' ? path.win32 : path.posix;
  const dirs = pathVar.split(api.delimiter).filter((dir) => dir !== '');
  const found: ExternalReviewer[] = [];
  for (const name of EXTERNAL_CLIS) {
    const names = platform === 'win32' ? WIN_EXT.map((ext) => name + ext) : [name];
    const hit = dirs.flatMap((dir) => names.map((file) => api.join(dir, file))).find((file) => exists(file));
    if (hit !== undefined) found.push({ name, path: hit });
  }
  return found;
}

export interface Env {
  home: string;
  platform: string;
  pathVar: string;
  read: Read;
  exists: Exists;
}

const USAGE = 'usage: models.ts show | reviewer [--author <model> | --author=<model>] | cli';

export function main(argv: string[], out: (text: string) => void, err: (text: string) => void, env: Env): number {
  const [cmd, ...rest] = argv;
  if (cmd === 'show' && rest.length === 0) {
    out(JSON.stringify(loadModels(env.home, env.read)));
    return 0;
  }
  if (cmd === 'cli' && rest.length === 0) {
    out(JSON.stringify({ reviewers: findExternalReviewers(env.platform, env.pathVar, env.exists) }));
    return 0;
  }
  const inline = rest.length === 1 ? /^--author=(.+)$/s.exec(rest[0] as string)?.[1] : undefined;
  const author = inline ?? (rest.length === 2 && rest[0] === '--author' ? rest[1] : undefined);
  if (cmd === 'reviewer' && (rest.length === 0 || (author !== undefined && !author.startsWith('-')))) {
    const loaded = loadModels(env.home, env.read);
    out(JSON.stringify({ ...pickReviewer(loaded.models, author), config: loaded.status }));
    return 0;
  }
  err(USAGE);
  return 2;
}

if (import.meta.main) {
  const env: Env = {
    home: process.env.H7_HOME ?? homedir(),
    platform: process.platform,
    pathVar: [process.env.PATH].join(''), // join turns an unset PATH into '' without a branch some platforms never take
    read: realRead,
    exists: existsSync,
  };
  process.exitCode = main(process.argv.slice(2), (t) => console.log(t), (t) => console.error(t), env);
}
