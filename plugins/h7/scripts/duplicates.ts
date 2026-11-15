import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';

export const MATTPOCOCK_SOURCE = 'mattpocock/skills';
export const LEGACY_PLUGIN = 'mattpocock-skills@local-desktop-app-uploads';
export const OFFICIAL_PLUGIN = 'mattpocock-skills@claude-plugins-official';

export function readJson(file: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
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

function mattpocockSkillNames(home: string): Set<string> {
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
