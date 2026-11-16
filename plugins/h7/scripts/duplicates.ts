import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

export const MATTPOCOCK_SOURCE = 'mattpocock/skills';
export const LEGACY_PLUGIN = 'mattpocock-skills@local-desktop-app-uploads';
export const OFFICIAL_PLUGIN = 'mattpocock-skills@claude-plugins-official';

export function readJson(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8').replace(/^﻿/, ''));
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function installedPlugins(home: string): string[] {
  const file = readJson(join(home, '.claude', 'plugins', 'installed_plugins.json'));
  const plugins = file?.plugins;
  return plugins !== null && typeof plugins === 'object' ? Object.keys(plugins) : [];
}

export function mattpocockSkillNames(home: string): Set<string> {
  const lock = readJson(join(home, '.agents', '.skill-lock.json'));
  const skills = lock?.skills;
  const names = new Set<string>();
  if (skills === null || typeof skills !== 'object') return names;
  for (const [name, entry] of Object.entries(skills)) {
    if ((entry as { source?: unknown } | null)?.source === MATTPOCOCK_SOURCE) names.add(name);
  }
  return names;
}

function isLinkIntoAgentsSkills(path: string): boolean {
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink() !== true) return false;
  return readlinkSync(path).replaceAll('\\', '/').includes('/.agents/skills/');
}

export function duplicateSkillLinks(home: string): string[] {
  const names = mattpocockSkillNames(home);
  const dir = join(home, '.claude', 'skills');
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => names.has(entry) && isLinkIntoAgentsSkills(join(dir, entry)))
    .sort()
    .map((entry) => join(dir, entry));
}

export const OFFICIAL_MARKETPLACE = 'claude-plugins-official';
export const OFFICIAL_MARKETPLACE_SOURCE = 'anthropics/claude-plugins-official';

export function knownMarketplaces(home: string): Record<string, unknown> | null {
  return readJson(join(home, '.claude', 'plugins', 'known_marketplaces.json'));
}

export function lockPath(home: string): string {
  return join(home, '.agents', '.skill-lock.json');
}

/** Removes the mattpocock/skills entries from ~/.agents/.skill-lock.json, keeping indentation and line endings. Returns how many were removed. */
export function removeMattpocockLockEntries(home: string, write: (file: string, text: string) => void): number {
  const file = lockPath(home);
  const names = mattpocockSkillNames(home);
  if (names.size === 0) return 0;
  const original = readFileSync(file, 'utf8');
  const lock = JSON.parse(original.replace(/^﻿/, '')) as { skills: Record<string, unknown> };
  for (const name of names) delete lock.skills[name];
  const indent = /^([ \t]+)"/m.exec(original)?.[1] ?? '  ';
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const body = JSON.stringify(lock, null, indent).replaceAll('\n', eol);
  write(file, (original.startsWith('﻿') ? '﻿' : '') + body + (/\n\s*$/.test(original) ? eol : ''));
  return names.size;
}

/** Words of 3+ characters, lowercased: path-like tokens (`../../../AGENTS.md` vs `AGENTS.md`) reduce to the same words. */
const words = (text: string): Set<string> => new Set(text.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);

/** Jaccard similarity of the word sets of two texts, 0 to 1 (two empty texts: 0). */
export function similarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  const total = left.size + right.size - shared;
  return total === 0 ? 0 : shared / total;
}

export const SIMILAR = 0.6;

/** SKILL.md text of every skill the installed mattpocock plugin ships, by skill name. Unreadable installs contribute nothing. */
export function pluginSkillTexts(home: string): Map<string, string> {
  const texts = new Map<string, string>();
  const installs = (readJson(join(home, '.claude', 'plugins', 'installed_plugins.json'))?.plugins as Record<string, unknown> | undefined)?.[OFFICIAL_PLUGIN];
  for (const install of Array.isArray(installs) ? installs : []) {
    const base = (install as { installPath?: unknown } | null)?.installPath;
    if (typeof base !== 'string') continue;
    let names: string[];
    try {
      names = readdirSync(join(base, 'skills'));
    } catch {
      continue;
    }
    for (const name of names) {
      try {
        texts.set(name, readFileSync(join(base, 'skills', name, 'SKILL.md'), 'utf8'));
      } catch {
        // a skill dir without SKILL.md is not a skill
      }
    }
  }
  return texts;
}

/**
 * Real directories (not the symlinks `duplicateSkillLinks` finds) in the given skills folders that are copies of a mattpocock skill: the name is a
 * mattpocock skill (plugin or install lock) and, when the plugin copy is readable, the text is at least SIMILAR to it. Installer-mangled copies match.
 */
export function unmarkedCopies(home: string, dirs: string[]): string[] {
  const plugin = pluginSkillTexts(home);
  const names = new Set([...mattpocockSkillNames(home), ...plugin.keys()]);
  const found: string[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const entry of entries.sort()) {
      const skill = join(dir, entry);
      if (!names.has(entry) || lstatSync(skill).isSymbolicLink()) continue;
      let text: string;
      try {
        text = readFileSync(join(skill, 'SKILL.md'), 'utf8');
      } catch {
        continue;
      }
      const original = plugin.get(entry);
      if (original === undefined || similarity(text, original) >= SIMILAR) found.push(skill);
    }
  }
  return found;
}
