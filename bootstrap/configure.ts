import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { inspectDevLink } from '../plugins/h7/scripts/devlink.ts';
import { duplicateSkillLinks, installedPlugins, knownMarketplaces, LEGACY_PLUGIN, mattpocockSkillNames, OFFICIAL_MARKETPLACE, OFFICIAL_MARKETPLACE_SOURCE, OFFICIAL_PLUGIN, removeMattpocockLockEntries } from '../plugins/h7/scripts/duplicates.ts';
import { nodeAtLeast } from '../plugins/h7/scripts/doctor.ts';

export const GITHUB_SOURCE = 'H7KZ/Agents';
export const PLUGIN = 'h7@h7kz';

export interface Options {
  dryRun: boolean;
  yes: boolean;
  help: boolean;
  local: string | null;
  dev: string | null;
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

export const USAGE = `Usage: install [--dry-run] [--local <path> | --dev <path>] [--yes] [--help]

  --dry-run       print what would happen, change nothing
  --local <path>  add the h7kz marketplace from a local clone instead of ${GITHUB_SOURCE}
                  (Claude Code copies the plugin into its cache, so uncommitted edits are NOT live)
  --dev <path>    authoring machine: link <path>/plugins/h7 into ~/.claude/skills/h7 so Claude Code loads
                  it in place (live edits); no marketplace is added and h7@h7kz is uninstalled
  --yes           do not ask before removing stale duplicate skills
  --help          show this text`;

export function parseOptions(argv: string[]): Options {
  const options: Options = { dryRun: false, yes: false, help: false, local: null, dev: null };
  const pathValue = (flag: string, value: string | undefined): string => {
    if (value === undefined || value.startsWith('--')) throw new Fatal(`${flag} needs a path`);
    return value;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--yes' || arg === '-y') options.yes = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--local') options.local = pathValue(arg, argv[++i]);
    else if (arg === '--dev') options.dev = pathValue(arg, argv[++i]);
    else throw new Fatal(`unknown argument: ${arg}`);
  }
  if (options.local !== null && options.dev !== null) throw new Fatal('--local and --dev cannot be combined');
  return options;
}

export interface SettingsResult {
  text: string;
  changed: boolean;
}

const BOM = '﻿';

export function mergeSettings(original: string | null, entry: Record<string, unknown>): SettingsResult {
  const bom = original?.startsWith(BOM) === true ? BOM : '';
  const source = original === null ? null : original.slice(bom.length);
  let settings: Record<string, unknown> = {};
  if (source !== null && source.trim() !== '') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
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
  const indent = source === null ? '  ' : (/^([ \t]+)"/m.exec(source)?.[1] ?? '  ');
  const eol = source?.includes('\r\n') ? '\r\n' : '\n';
  const trailing = source === null || /\n\s*$/.test(source);
  const body = JSON.stringify(settings, null, indent).replaceAll('\n', eol);
  return { text: bom + (trailing ? body + eol : body), changed: true };
}

export function marketplaceEntry(local: string | null): Record<string, unknown> {
  const source = local === null ? { source: 'github', repo: GITHUB_SOURCE } : { source: 'directory', path: local };
  return { source, autoUpdate: true };
}

export interface AtomicOps {
  write: typeof writeFileSync;
  rename: typeof renameSync;
  remove: typeof unlinkSync;
}

/** Writes through a temp file in the same directory and renames it over the target, so a crash never leaves a half-written file. */
export function writeFileAtomic(file: string, text: string, ops: AtomicOps = { write: writeFileSync, rename: renameSync, remove: unlinkSync }): void {
  const temp = `${file}.h7tmp`;
  try {
    ops.write(temp, text);
    ops.rename(temp, file);
  } catch (error) {
    try {
      ops.remove(temp);
    } catch {
      // the temp file may never have been created
    }
    throw error;
  }
}

export function quote(arg: string): string {
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

function sameSource(known: unknown, wanted: Record<string, unknown>): boolean {
  const have = (known as { source?: Record<string, unknown> } | null)?.source ?? {};
  const want = wanted.source as Record<string, unknown>;
  if (have?.source !== want.source) return false;
  return want.source === 'github' ? have.repo === want.repo : resolve(String(have.path)) === resolve(String(want.path));
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
    const line = [command, ...args.map(quote)].join(' ');
    this.say(`run: ${line}`);
    if (this.options.dryRun) return;
    const result = this.deps.run(command, args);
    if (result.status !== 0) {
      throw new Fatal(`${line} failed (exit ${result.status}): ${(result.stderr || result.stdout).trim()}`);
    }
  }

  prerequisites(): void {
    if (!nodeAtLeast(this.deps.nodeVersion)) throw new Fatal(`Node 22.18 or newer is required (found ${this.deps.nodeVersion})`);
    for (const tool of ['git', 'claude']) {
      if (this.deps.run(tool, ['--version']).status !== 0) throw new Fatal(`${tool} is not installed or not on PATH`);
    }
    const { file, original } = this.readSettings();
    this.backUp(file, original);
    this.deps.log('prerequisites ok: node, git, claude, settings.json readable');
  }

  /** The backup must be the settings.json as the user had it, so it is taken before any claude command can rewrite it. */
  backUp(file: string, original: string | null): void {
    const backup = `${file}.h7bak`;
    if (original === null || existsSync(backup)) return;
    this.say(`back up ${quote(file)} to ${quote(backup)}`);
    if (this.options.dryRun) return;
    copyFileSync(file, backup);
  }

  marketplace(): void {
    if (this.options.dev !== null) {
      this.deps.log('dev mode: no marketplace is added, the plugin is linked instead');
      return;
    }
    const known = knownMarketplaces(this.deps.home)?.h7kz;
    if (known !== undefined) {
      const wanted = marketplaceEntry(this.options.local);
      if (sameSource(known, wanted)) this.deps.log('marketplace h7kz already added, skipping');
      else this.deps.log(`warning: marketplace h7kz is already added from a different source than requested; to switch run: claude plugin marketplace remove h7kz, then run this installer again`);
      return;
    }
    this.exec('claude', ['plugin', 'marketplace', 'add', this.options.local ?? GITHUB_SOURCE]);
  }

  officialMarketplace(): void {
    if (knownMarketplaces(this.deps.home)?.[OFFICIAL_MARKETPLACE] !== undefined) return;
    this.exec('claude', ['plugin', 'marketplace', 'add', OFFICIAL_MARKETPLACE_SOURCE]);
  }

  readSettings(): { file: string; original: string | null; merged: SettingsResult } {
    const file = join(this.deps.home, '.claude', 'settings.json');
    const original = existsSync(file) ? readFileSync(file, 'utf8') : null;
    return { file, original, merged: mergeSettings(original, marketplaceEntry(this.options.local)) };
  }

  /** Runs after every `claude plugin marketplace add`, which itself rewrites settings.json and records h7kz without autoUpdate. */
  settings(): void {
    if (this.options.dev !== null) return;
    const { file, merged } = this.readSettings();
    if (!merged.changed) {
      this.deps.log('settings.json already has h7kz with autoUpdate, skipping');
      return;
    }
    this.say(`merge extraKnownMarketplaces.h7kz (autoUpdate: true) into ${quote(file)}`);
    if (this.options.dryRun) return;
    mkdirSync(dirname(file), { recursive: true });
    writeFileAtomic(file, merged.text);
  }

  install(plugin: string): void {
    if (installedPlugins(this.deps.home).includes(plugin)) {
      this.deps.log(`${plugin} already installed, skipping`);
      return;
    }
    this.exec('claude', ['plugin', 'install', plugin]);
  }

  /** Marketplace mode installs h7@h7kz; dev mode links the working tree instead, and the marketplace copy must go or h7 would load twice. */
  h7Plugin(): void {
    const link = inspectDevLink(this.deps.home);
    if (this.options.dev === null) {
      if (link.state !== 'absent') this.deps.log(`warning: ${quote(link.path)} exists (dev mode); h7 would load twice. Remove it, or run this installer with --dev`);
      this.install(PLUGIN);
      return;
    }
    const target = join(resolve(this.options.dev), 'plugins', 'h7');
    if (installedPlugins(this.deps.home).includes(PLUGIN)) {
      this.deps.log(`dev mode: ${PLUGIN} would load twice next to the linked copy, uninstalling it`);
      this.exec('claude', ['plugin', 'uninstall', PLUGIN]);
    }
    if (link.state === 'ok' && link.target === realpathSync(target)) {
      this.deps.log(`${quote(link.path)} already links to ${quote(target)}, skipping`);
      return;
    }
    if (link.state !== 'absent') throw new Fatal(`${link.path} already exists (${link.state}${link.target === null ? '' : `, points to ${link.target}`}); remove it and run this installer again`);
    this.say(`link ${quote(link.path)} -> ${quote(target)}`);
    if (this.options.dryRun) return;
    mkdirSync(dirname(link.path), { recursive: true });
    symlinkSync(target, link.path, 'junction');
  }

  h7Dir(): void {
    const dir = join(this.deps.home, '.h7');
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      this.deps.log(`${dir} exists, skipping`);
      return;
    }
    this.say(`create ${quote(dir)}`);
    if (!this.options.dryRun) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  async cleanup(): Promise<void> {
    const legacy = installedPlugins(this.deps.home).includes(LEGACY_PLUGIN);
    const links = duplicateSkillLinks(this.deps.home);
    if (!legacy && links.length === 0) {
      this.deps.log('no stale duplicates to clean up');
      return;
    }
    const locked = mattpocockSkillNames(this.deps.home).size;
    this.deps.log('stale duplicates of mattpocock/skills:');
    if (legacy) this.deps.log(`  plugin ${LEGACY_PLUGIN} (will be uninstalled)`);
    for (const link of links) this.deps.log(`  symlink ${link} (will be removed)`);
    if (locked > 0) this.deps.log(`note: ~/.agents/.skill-lock.json still lists ${locked} mattpocock/skills entries; \`npx skills update\` can re-add the symlinks`);
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
    if (locked > 0 && (this.options.yes || (await this.deps.confirm(`Also remove those ${locked} mattpocock/skills entries from ~/.agents/.skill-lock.json (a .h7bak copy is kept)?`)))) {
      const lock = join(this.deps.home, '.agents', '.skill-lock.json');
      copyFileSync(lock, `${lock}.h7bak`);
      const removed = removeMattpocockLockEntries(this.deps.home, writeFileAtomic);
      this.deps.log(`removed ${removed} mattpocock/skills entries from ${lock}`);
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
    if (options.dev !== null) {
      options.dev = resolve(options.dev);
      if (!existsSync(join(options.dev, 'plugins', 'h7', '.claude-plugin', 'plugin.json'))) throw new Fatal(`--dev: no plugins/h7/.claude-plugin/plugin.json in ${options.dev}`);
    }
    const steps = new Runner(options, deps);
    steps.prerequisites();
    steps.marketplace();
    steps.officialMarketplace();
    steps.settings();
    steps.h7Plugin();
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
