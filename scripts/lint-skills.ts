import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseFrontmatter } from './frontmatter.ts';

export interface Problem {
  file: string;
  line: number;
  message: string;
}

const MAX_LINES = 500;
const MAX_DESCRIPTION = 1024;
const FRONTMATTER_MESSAGE = 'frontmatter must start on line 1 with --- and be closed with ---';

function isDir(path: string): boolean {
  return existsSync(path) && statSync(path).isDirectory();
}

function fencedLines(lines: string[]): boolean[] {
  let inFence = false;
  return lines.map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return true;
    }
    return inFence;
  });
}

function lintReferences(file: string, text: string, skillDir: string, pluginDir: string): Problem[] {
  const problems: Problem[] = [];
  const lines = text.split(/\r?\n/);
  const fenced = fencedLines(lines);
  lines.forEach((line, i) => {
    const check = (target: string, base: string, what: string): void => {
      if (!existsSync(resolve(base, target))) {
        problems.push({ file, line: i + 1, message: `${what} does not exist: ${target}` });
      }
    };
    for (const m of line.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s`"')\]]+)/g)) {
      check(m[1] as string, pluginDir, 'plugin path');
    }
    for (const m of line.matchAll(/\$\{CLAUDE_SKILL_DIR\}\/([^\s`"')\]]+)/g)) {
      check(m[1] as string, skillDir, 'skill path');
    }
    if (fenced[i]) return;
    for (const m of line.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const href = (m[1] as string).split('#')[0] as string;
      if (href === '' || /^[a-z][a-z0-9+.-]*:/i.test(href)) continue;
      check(href, skillDir, 'link target');
    }
    for (const m of line.matchAll(/`((?:references|scripts)\/[^`\s]+)`/g)) {
      check(m[1] as string, skillDir, 'referenced path');
    }
  });
  return problems;
}

export function lintSkill(skillDir: string, pluginDir: string): Problem[] {
  const file = join(skillDir, 'SKILL.md');
  if (!existsSync(file)) return [{ file, line: 1, message: 'SKILL.md is missing' }];
  const text = readFileSync(file, 'utf8');
  const problems: Problem[] = [];
  const total = text.replace(/\r?\n$/, '').split(/\r?\n/).length;
  if (total > MAX_LINES) {
    problems.push({ file, line: MAX_LINES + 1, message: `file has ${total} lines, limit is ${MAX_LINES}` });
  }
  const fm = parseFrontmatter(text);
  if (!fm) {
    problems.push({ file, line: 1, message: FRONTMATTER_MESSAGE });
    return problems;
  }
  const at = (key: string): number => fm.lines.get(key) ?? 1;
  const name = fm.fields.get('name') ?? '';
  if (name !== basename(skillDir)) {
    problems.push({ file, line: at('name'), message: `name must equal directory name "${basename(skillDir)}", got "${name}"` });
  }
  const description = fm.fields.get('description') ?? '';
  if (description === '') {
    problems.push({ file, line: at('description'), message: 'description is required' });
  } else if (description.length > MAX_DESCRIPTION) {
    problems.push({ file, line: at('description'), message: `description is ${description.length} chars, limit is ${MAX_DESCRIPTION}` });
  }
  if (fm.fields.get('disable-model-invocation') !== 'true') {
    problems.push({ file, line: at('disable-model-invocation'), message: 'disable-model-invocation: true is required' });
  }
  problems.push(...lintReferences(file, text, skillDir, pluginDir));
  return problems;
}

export function lintAgent(file: string): Problem[] {
  const fm = parseFrontmatter(readFileSync(file, 'utf8'));
  if (!fm) return [{ file, line: 1, message: FRONTMATTER_MESSAGE }];
  const problems: Problem[] = [];
  for (const key of ['name', 'description']) {
    if ((fm.fields.get(key) ?? '') === '') {
      problems.push({ file, line: fm.lines.get(key) ?? 1, message: `${key} is required` });
    }
  }
  return problems;
}

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => join(dir, entry))
    .sort();
}

export function lintPlugin(pluginDir: string): Problem[] {
  const problems: Problem[] = [];
  const skills = join(pluginDir, 'skills');
  if (isDir(skills)) {
    for (const entry of readdirSync(skills).sort()) {
      if (isDir(join(skills, entry))) problems.push(...lintSkill(join(skills, entry), pluginDir));
    }
  }
  const agents = join(pluginDir, 'agents');
  if (isDir(agents)) {
    for (const file of markdownFiles(agents)) problems.push(...lintAgent(file));
  }
  return problems;
}

export function formatProblem(problem: Problem): string {
  return `${problem.file}:${problem.line}: ${problem.message}`;
}

export function main(argv: string[], out: (line: string) => void): number {
  const pluginDir = resolve(argv[0] ?? join(import.meta.dirname, '..', 'plugins', 'h7'));
  const problems = lintPlugin(pluginDir);
  for (const problem of problems) out(formatProblem(problem));
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), (line) => console.error(line));
}
