import { spawnSync } from 'node:child_process';
import { existsSync, copyFileSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { duplicateSkillLinks, installedPlugins, LEGACY_PLUGIN, OFFICIAL_PLUGIN, readJson } from '../plugins/h7/scripts/duplicates.ts';
import { nodeAtLeast } from '../plugins/h7/scripts/doctor.ts';

export const GITHUB_SOURCE = 'H7KZ/Agents';
export const PLUGIN = 'h7@h7kz';

export interface Options {
  dryRun: boolean;
  yes: boolean;
  help: boolean;
  local: string | null;
}

export interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface Deps {
  home: string;
  nodeVersion: string;
  run: (command: string, args: string[]) => CommandResult;
  log: (line: string) => void;
  confirm: (question: string) => Promise<boolean>;
}

export class Fatal extends Error {}

export const USAGE = `Usage: install [--dry-run] [--local <path>] [--yes] [--help]

  --dry-run       print what would happen, change nothing
  --local <path>  add the h7kz marketplace from a local clone instead of ${GITHUB_SOURCE}
  --yes           do not ask before removing stale duplicate skills
  --help          show this text`;

export function parseOptions(argv: string[]): Options {
  const options: Options = { dryRun: false, yes: false, help: false, local: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--local') {
      const value = argv[++i];
      if (value === undefined || value.startsWith('--')) throw new Fatal('--local needs a path');
      options.local = value;
    } else throw new Fatal(`unknown argument: ${arg}`);
  }
  return options;
}

export interface SettingsResult {
  text: string;
  changed: boolean;
}

export function mergeSettings(original: string | null, entry: Record<string, unknown>): SettingsResult {
  let settings: Record<string, unknown> = {};
  if (original !== null && original.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(original);
    } catch (error) {
      throw new Fatal(`settings.json is not valid JSON, refusing to touch it: ${(error as Error).message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Fatal('settings.json is not a JSON object, refusing to touch it');
    settings = parsed as Record<string, unknown>;
  }
  const existing = settings.extraKnownMarketplaces;
  const marketplaces = existing !== null && typeof existing === 'object' && !Array.isArray(existing) ? (existing as Record<string, unknown>) : {};
  if (JSON.stringify(marketplaces.h7kz) === JSON.stringify(entry)) return { text: original as string, changed: false };
  settings.extraKnownMarketplaces = { ...marketplaces, h7kz: entry };
  const indent = original === null ? '  ' : (/^([ \t]+)"/m.exec(original)?.[1] ?? '  ');
  const eol = original?.includes('\r\n') ? '\r\n' : '\n';
  const trailing = original === null || /\n\s*$/.test(original);
  const body = JSON.stringify(settings, null, indent).replaceAll('\n', eol);
  return { text: trailing ? body + eol : body, changed: true };
}

export function marketplaceEntry(local: string | null): Record<string, unknown> {
  const source = local === null ? { source: 'github', repo: GITHUB_SOURCE } : { source: 'directory', path: local };
  return { source, autoUpdate: true };
}

function quote(arg: string): string {
  return /^[\w@./:\\-]+$/.test(arg) ? arg : `"${arg}"`;
}

export function shellRun(command: string, args: string[], spawn: typeof spawnSync = spawnSync): CommandResult {
  if (args.some((a) => /["\n\r%$`]/.test(a))) throw new Fatal(`refusing argument with shell metacharacters: ${args.join(' ')}`);
  const result = spawn([command, ...args.map(quote)].join(' '), { shell: true, encoding: 'utf8', windowsHide: true });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

export async function askYesNo(question: string, input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Promise<boolean> {
  const rl = createInterface({ input, output });
  const closed = new Promise<string>((done) => rl.once('close', () => done('')));
  const answer = await Promise.race([rl.question(`${question} [y/N] `), closed]);
  rl.close();
  return /^y(es)?$/i.test(answer.trim());
}

class Runner {
  options: Options;
  deps: Deps;

  constructor(options: Options, deps: Deps) {
    this.options = options;
    this.deps = deps;
  }

  say(line: string): void {
    this.deps.log(this.options.dryRun ? `[dry-run] ${line}` : line);
  }

  exec(command: string, args: string[]): void {
    this.say(`run: ${[command, ...args].join(' ')}`);
    if (this.options.dryRun) return;
    const result = this.deps.run(command, args);
    if (result.status !== 0) {
      throw new Fatal(`${command} ${args.join(' ')} failed (exit ${result.status}): ${(result.stderr || result.stdout).trim()}`);
    }
  }

  prerequisites(): void {
    if (!nodeAtLeast(this.deps.nodeVersion)) throw new Fatal(`Node 22.18 or newer is required (found ${this.deps.nodeVersion})`);
    for (const tool of ['git', 'claude']) {
      if (this.deps.run(tool, ['--version']).status !== 0) throw new Fatal(`${tool} is not installed or not on PATH`);
    }
    this.readSettings();
    this.deps.log('prerequisites ok: node, git, claude, settings.json readable');
  }

  marketplace(): void {
    const known = readJson(join(this.deps.home, '.claude', 'plugins', 'known_marketplaces.json'));
    if (known?.h7kz !== undefined) {
      this.deps.log('marketplace h7kz already added, skipping');
      return;
    }
    this.exec('claude', ['plugin', 'marketplace', 'add', this.options.local ?? GITHUB_SOURCE]);
  }

  readSettings(): { file: string; original: string | null; merged: SettingsResult } {
    const file = join(this.deps.home, '.claude', 'settings.json');
    const original = existsSync(file) ? readFileSync(file, 'utf8') : null;
    return { file, original, merged: mergeSettings(original, marketplaceEntry(this.options.local)) };
  }

  settings(): void {
    const { file, original, merged } = this.readSettings();
    if (!merged.changed) {
      this.deps.log('settings.json already has h7kz with autoUpdate, skipping');
      return;
    }
    this.say(`merge extraKnownMarketplaces.h7kz (autoUpdate: true) into ${file}`);
    if (this.options.dryRun) return;
    mkdirSync(dirname(file), { recursive: true });
    if (original !== null) copyFileSync(file, `${file}.h7bak`);
    writeFileSync(file, merged.text);
    if (original !== null) this.deps.log(`backup written to ${file}.h7bak`);
  }

  install(plugin: string): void {
    if (installedPlugins(this.deps.home).includes(plugin)) {
      this.deps.log(`${plugin} already installed, skipping`);
      return;
    }
    this.exec('claude', ['plugin', 'install', plugin]);
  }

  h7Dir(): void {
    const dir = join(this.deps.home, '.h7');
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      this.deps.log(`${dir} exists, skipping`);
      return;
    }
    this.say(`create ${dir}`);
    if (!this.options.dryRun) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  async cleanup(): Promise<void> {
    const legacy = installedPlugins(this.deps.home).includes(LEGACY_PLUGIN);
    const links = duplicateSkillLinks(this.deps.home);
    if (!legacy && links.length === 0) {
      this.deps.log('no stale duplicates to clean up');
      return;
    }
    this.deps.log('stale duplicates of mattpocock/skills:');
    if (legacy) this.deps.log(`  plugin ${LEGACY_PLUGIN} (will be uninstalled)`);
    for (const link of links) this.deps.log(`  symlink ${link} (will be removed)`);
    if (this.options.dryRun) {
      this.say('would ask before removing them');
      return;
    }
    if (!this.options.yes && !(await this.deps.confirm('Remove these stale duplicates?'))) {
      this.deps.log('left stale duplicates in place');
      return;
    }
    if (legacy) this.exec('claude', ['plugin', 'uninstall', LEGACY_PLUGIN]);
    for (const link of links) {
      unlinkSync(link);
      this.deps.log(`removed ${link}`);
    }
  }
}

export async function configure(options: Options, deps: Deps): Promise<number> {
  if (options.help) {
    deps.log(USAGE);
    return 0;
  }
  try {
    if (options.local !== null) {
      options.local = resolve(options.local);
      if (!existsSync(join(options.local, '.claude-plugin', 'marketplace.json'))) throw new Fatal(`--local: no .claude-plugin/marketplace.json in ${options.local}`);
    }
    const steps = new Runner(options, deps);
    steps.prerequisites();
    steps.marketplace();
    steps.settings();
    steps.install(PLUGIN);
    steps.install(OFFICIAL_PLUGIN);
    steps.h7Dir();
    await steps.cleanup();
    deps.log(options.dryRun ? 'dry run complete, nothing was changed' : 'done. Restart Claude Code or run /reload-plugins, then try /h7:doctor');
    return 0;
  } catch (error) {
    if (!(error instanceof Fatal)) throw error;
    deps.log(`error: ${error.message}`);
    return 1;
  }
}

export async function main(argv: string[], deps: Deps): Promise<number> {
  let options: Options;
  try {
    options = parseOptions(argv);
  } catch (error) {
    deps.log(`error: ${(error as Error).message}`);
    deps.log(USAGE);
    return 2;
  }
  return configure(options, deps);
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2), {
    home: process.env.H7_HOME ?? homedir(),
    nodeVersion: process.versions.node,
    run: shellRun,
    log: (line) => console.log(line),
    confirm: askYesNo,
  });
}
