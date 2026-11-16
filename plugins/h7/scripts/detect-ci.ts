import { posix } from 'node:path';
import type { Repo } from './detect-fs.ts';
import { kindsOfCommand, type Kind } from './detect-tools.ts';

export interface CiJob {
  file: string;
  id: string;
  /** Reusable workflow this job calls, if any. */
  uses: string | null;
  commands: string[];
  kinds: Kind[];
}

export interface Ci {
  provider: string | null;
  providers: string[];
  files: string[];
  /** Only GitHub Actions workflows are parsed into jobs. */
  parsed: boolean;
  triggers: Record<string, string[]>;
  jobs: CiJob[];
}

const SINGLE_FILES: [string, string][] = [
  ['.gitlab-ci.yml', 'gitlab-ci'],
  ['.circleci/config.yml', 'circleci'],
  ['azure-pipelines.yml', 'azure-pipelines'],
  ['bitbucket-pipelines.yml', 'bitbucket-pipelines'],
  ['.travis.yml', 'travis'],
  ['Jenkinsfile', 'jenkins'],
];

const indentOf = (line: string): number => line.length - line.trimStart().length;
const unquote = (value: string): string => value.trim().replace(/^(["'])(.*)\1$/, '$2');

/** Trigger names of a workflow's top-level `on:`. */
export function workflowTriggers(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const at = lines.findIndex((l) => /^["']?on["']?:/.test(l));
  if (at === -1) return [];
  const inline = (lines[at] as string).replace(/^["']?on["']?:\s*/, '').replace(/\s+#.*$/, '').trim();
  if (inline !== '') return inline.replace(/^\[|\]$/g, '').split(',').map(unquote).filter((t) => t !== '');
  const out: string[] = [];
  let keyIndent = -1;
  for (const line of lines.slice(at + 1)) {
    if (/^\S/.test(line)) break;
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (keyIndent === -1) keyIndent = indentOf(line);
    const m = /^\s*(?:-\s+)?([\w.-]+):?/.exec(line);
    if (indentOf(line) === keyIndent && m) out.push(m[1] as string);
  }
  return out;
}

/** Jobs of a GitHub Actions workflow with their `run:` commands. */
export function workflowJobs(file: string, text: string): CiJob[] {
  const lines = text.split(/\r?\n/);
  const jobs: { id: string; uses: string | null; commands: string[] }[] = [];
  let jobIndent = -1;
  let inJobs = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (/^\S/.test(line)) inJobs = /^jobs:\s*(#.*)?$/.test(line);
    if (!inJobs || line.trim() === '' || line.trim().startsWith('#') || /^jobs:/.test(line)) continue;
    const key = /^(\s+)([\w.-]+):\s*(#.*)?$/.exec(line);
    if (key && (jobIndent === -1 || (key[1] as string).length === jobIndent)) {
      jobIndent = (key[1] as string).length;
      jobs.push({ id: key[2] as string, uses: null, commands: [] });
      continue;
    }
    const job = jobs[jobs.length - 1];
    if (job === undefined) continue;
    const uses = /^\s*uses:\s*(\S+)/.exec(line);
    if (uses && indentOf(line) === jobIndent + 2) job.uses = unquote(uses[1] as string);
    const run = /^(\s*)(-\s+)?run:\s*(.*)$/.exec(line);
    if (!run) continue;
    const keyIndent = (run[1] as string).length + (run[2] === undefined ? 0 : run[2].length);
    const value = (run[3] as string).replace(/\s+#.*$/, '').trim();
    if (/^[|>][+-]?$/.test(value)) {
      for (let j = i + 1; j < lines.length; j++) {
        const next = lines[j] as string;
        if (next.trim() !== '' && indentOf(next) <= keyIndent) break;
        if (next.trim() !== '' && !next.trim().startsWith('#')) job.commands.push(next.trim());
        i = j;
      }
    } else {
      job.commands.push(unquote(value));
    }
  }
  return jobs.map((j) => ({ file, ...j, kinds: [...new Set(j.commands.flatMap(kindsOfCommand))] }));
}

export function detectCi(repo: Repo): Ci {
  const workflows = repo.files.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
  const providers = [...(workflows.length > 0 ? ['github-actions'] : []), ...SINGLE_FILES.filter(([f]) => repo.has(f)).map(([, p]) => p)];
  const files = [...workflows, ...SINGLE_FILES.map(([f]) => f).filter((f) => repo.has(f))];
  const triggers: Record<string, string[]> = {};
  const jobs: CiJob[] = [];
  for (const file of workflows) {
    const text = repo.read(file) as string;
    triggers[posix.basename(file)] = workflowTriggers(text);
    jobs.push(...workflowJobs(file, text));
  }
  return { provider: providers[0] ?? null, providers, files, parsed: workflows.length > 0, triggers, jobs };
}
