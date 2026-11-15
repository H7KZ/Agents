import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ManifestProblem {
  file: string;
  message: string;
}

type Json = Record<string, unknown>;

const ROOT_VAR = '${CLAUDE_PLUGIN_ROOT}/';

function readJson(file: string, problems: ManifestProblem[]): Json | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Json;
  } catch (error) {
    problems.push({ file, message: `invalid JSON: ${(error as Error).message}` });
    return null;
  }
}

function hookArgs(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node)) {
    for (const item of node) hookArgs(item, found);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === 'args' && Array.isArray(value)) {
        found.push(...value.filter((a): a is string => typeof a === 'string'));
      } else {
        hookArgs(value, found);
      }
    }
  }
  return found;
}

function checkPlugin(pluginDir: string, entryName: unknown, problems: ManifestProblem[]): void {
  const manifestFile = join(pluginDir, '.claude-plugin', 'plugin.json');
  const manifest = readJson(manifestFile, problems);
  if (manifest) {
    if (manifest.name !== entryName) {
      problems.push({ file: manifestFile, message: `name "${String(manifest.name)}" must equal marketplace entry "${String(entryName)}"` });
    }
    if ('version' in manifest) {
      problems.push({ file: manifestFile, message: 'version must be omitted (commit SHA is the version)' });
    }
  }
  const hooksFile = join(pluginDir, 'hooks', 'hooks.json');
  if (!existsSync(hooksFile)) return;
  const hooks = readJson(hooksFile, problems);
  for (const arg of hookArgs(hooks)) {
    if (arg.startsWith(ROOT_VAR) && !existsSync(join(pluginDir, arg.slice(ROOT_VAR.length)))) {
      problems.push({ file: hooksFile, message: `hook script does not exist: ${arg}` });
    }
  }
}

export function checkManifests(root: string): ManifestProblem[] {
  const problems: ManifestProblem[] = [];
  const marketplaceFile = join(root, '.claude-plugin', 'marketplace.json');
  const marketplace = readJson(marketplaceFile, problems);
  if (!marketplace) return problems;
  if (marketplace.name !== 'h7kz') {
    problems.push({ file: marketplaceFile, message: 'marketplace name must be "h7kz"' });
  }
  const entries = Array.isArray(marketplace.plugins) ? (marketplace.plugins as Json[]) : [];
  for (const entry of entries) {
    const source = typeof entry.source === 'string' ? entry.source : '';
    if (!source.startsWith('./') || !existsSync(resolve(root, source))) {
      problems.push({ file: marketplaceFile, message: `plugin "${String(entry.name)}" source does not exist: ${source}` });
    } else {
      checkPlugin(resolve(root, source), entry.name, problems);
    }
  }
  for (const rel of ['package.json', 'plugins/h7/package.json']) {
    const file = join(root, rel);
    if (existsSync(file)) readJson(file, problems);
  }
  return problems;
}

export function main(argv: string[], out: (line: string) => void): number {
  const root = resolve(argv[0] ?? join(import.meta.dirname, '..'));
  const problems = checkManifests(root);
  for (const p of problems) out(`${p.file}: ${p.message}`);
  return problems.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = main(process.argv.slice(2), (line) => console.error(line));
}
