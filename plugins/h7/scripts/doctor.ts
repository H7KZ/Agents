import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { duplicateSkillLinks, installedPlugins, LEGACY_PLUGIN, OFFICIAL_PLUGIN, readJson } from './duplicates.ts';

export type Status = 'pass' | 'warn' | 'fail';

export interface Check {
  id: string;
  status: Status;
  detail: string;
  fix?: string;
}

export interface RunResult {
  status: number | null;
  stdout: string;
}

export interface DoctorEnv {
  home: string;
  nodeVersion: string;
  run: (command: string, args: string[]) => RunResult;
}

const MIN_NODE = [22, 18];

export function nodeAtLeast(version: string, min: number[] = MIN_NODE): boolean {
  const parts = version.replace(/^v/, '').split('.').map(Number);
  const major = parts[0] as number;
  const minor = parts[1] ?? 0;
  return major > (min[0] as number) || (major === min[0] && minor >= (min[1] as number));
}

export function spawnRun(command: string, args: string[], spawn: typeof spawnSync = spawnSync): RunResult {
  const result = spawn([command, ...args].join(' '), { shell: true, encoding: 'utf8', timeout: 15000, windowsHide: true });
  return { status: result.status, stdout: result.stdout ?? '' };
}

function tool(env: DoctorEnv, id: string, command: string, args: string[], fix: string): Check {
  const result = env.run(command, args);
  if (result.status === 0) return { id, status: 'pass', detail: result.stdout.trim().split('\n')[0] as string };
  return { id, status: 'fail', detail: `${command} not found or not working`, fix };
}

function nodeCheck(env: DoctorEnv): Check {
  const ok = nodeAtLeast(env.nodeVersion);
  return ok
    ? { id: 'node', status: 'pass', detail: `node ${env.nodeVersion}` }
    : { id: 'node', status: 'fail', detail: `node ${env.nodeVersion} is older than ${MIN_NODE.join('.')}`, fix: `Install Node ${MIN_NODE.join('.')} or newer (type stripping is required by h7 scripts).` };
}

function ghAuthCheck(env: DoctorEnv): Check {
  const result = env.run('gh', ['auth', 'status']);
  return result.status === 0
    ? { id: 'gh-auth', status: 'pass', detail: 'gh is authenticated' }
    : { id: 'gh-auth', status: 'fail', detail: 'gh is not authenticated (or not installed)', fix: 'Run: gh auth login' };
}

function marketplaceChecks(env: DoctorEnv): Check[] {
  const known = readJson(join(env.home, '.claude', 'plugins', 'known_marketplaces.json'));
  const entry = known?.h7kz as { source?: { source?: string }; autoUpdate?: unknown } | undefined;
  if (entry === undefined) {
    return [
      { id: 'marketplace', status: 'fail', detail: 'marketplace h7kz is not known to Claude Code', fix: 'Run bootstrap/install.ps1 (Windows) or bootstrap/install.sh, or: claude plugin marketplace add H7KZ/Agents' },
      { id: 'auto-update', status: 'warn', detail: 'cannot check auto-update without the marketplace' },
    ];
  }
  const settings = readJson(join(env.home, '.claude', 'settings.json'));
  const extra = (settings?.extraKnownMarketplaces as Record<string, { autoUpdate?: unknown }> | undefined)?.h7kz;
  const local = entry.source?.source === 'directory';
  const auto = local || entry.autoUpdate === true || extra?.autoUpdate === true;
  return [
    { id: 'marketplace', status: 'pass', detail: local ? 'h7kz is a local directory marketplace (live edits)' : 'h7kz marketplace is known' },
    auto
      ? { id: 'auto-update', status: 'pass', detail: local ? 'not needed for a local directory marketplace' : 'autoUpdate is enabled' }
      : { id: 'auto-update', status: 'fail', detail: 'autoUpdate is not enabled for h7kz', fix: 'Set extraKnownMarketplaces.h7kz.autoUpdate to true in ~/.claude/settings.json (bootstrap does this).' },
  ];
}

function mattpocockChecks(env: DoctorEnv): Check[] {
  const plugins = installedPlugins(env.home);
  const links = duplicateSkillLinks(env.home);
  const legacy = plugins.includes(LEGACY_PLUGIN);
  const checks: Check[] = [];
  checks.push(
    plugins.includes(OFFICIAL_PLUGIN)
      ? { id: 'mattpocock', status: 'pass', detail: `${OFFICIAL_PLUGIN} is installed` }
      : { id: 'mattpocock', status: 'fail', detail: `${OFFICIAL_PLUGIN} is not installed`, fix: `Run: claude plugin install ${OFFICIAL_PLUGIN}` },
  );
  const dupes: string[] = [];
  const fixes: string[] = [];
  if (legacy) {
    dupes.push(`plugin ${LEGACY_PLUGIN}`);
    fixes.push(`claude plugin uninstall ${LEGACY_PLUGIN}`);
  }
  if (links.length > 0) {
    dupes.push(`${links.length} skill symlink(s) in ~/.claude/skills pointing to ~/.agents/skills (${links.slice(0, 3).map((l) => l.split(/[\\/]/).pop()).join(', ')}${links.length > 3 ? ', ...' : ''})`);
    fixes.push('remove those symlinks (bootstrap lists them and asks first)');
  }
  checks.push(
    dupes.length === 0
      ? { id: 'mattpocock-duplicates', status: 'pass', detail: 'no duplicate mattpocock/skills copies' }
      : { id: 'mattpocock-duplicates', status: 'fail', detail: `duplicate copies: ${dupes.join('; ')}`, fix: `Run bootstrap with --yes, or manually: ${fixes.join(' and ')}` },
  );
  return checks;
}

function h7DirCheck(env: DoctorEnv): Check {
  const dir = join(env.home, '.h7');
  try {
    if (statSync(dir).isDirectory()) return { id: 'h7-dir', status: 'pass', detail: `${dir} exists` };
  } catch {
    // falls through to the failure below
  }
  return { id: 'h7-dir', status: 'fail', detail: `${dir} does not exist`, fix: `Create it: mkdir ${dir}` };
}

export function runChecks(env: DoctorEnv): Check[] {
  return [
    nodeCheck(env),
    tool(env, 'git', 'git', ['--version'], 'Install git: https://git-scm.com/downloads'),
    tool(env, 'gh', 'gh', ['--version'], 'Install the GitHub CLI: https://cli.github.com'),
    ghAuthCheck(env),
    tool(env, 'claude', 'claude', ['--version'], 'Install Claude Code: https://code.claude.com/docs/en/setup'),
    ...marketplaceChecks(env),
    ...mattpocockChecks(env),
    h7DirCheck(env),
  ];
}

export function summarize(checks: Check[]): { ok: boolean; pass: number; warn: number; fail: number } {
  const count = (status: Status): number => checks.filter((c) => c.status === status).length;
  return { ok: count('fail') === 0, pass: count('pass'), warn: count('warn'), fail: count('fail') };
}

export function main(env: DoctorEnv, out: (text: string) => void): number {
  const checks = runChecks(env);
  out(JSON.stringify({ ...summarize(checks), checks }, null, 2));
  return 0;
}

if (import.meta.main) {
  const home = process.env.H7_HOME ?? homedir();
  process.exitCode = main({ home, nodeVersion: process.versions.node, run: spawnRun }, (text) => console.log(text));
}
