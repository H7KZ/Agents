import { lstatSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './duplicates.ts';

export const PLUGIN_NAME = 'h7';

export type DevLinkState = 'absent' | 'not-a-link' | 'broken' | 'foreign' | 'ok';

export interface DevLink {
  path: string;
  state: DevLinkState;
  target: string | null;
}

/** ~/.claude/skills/h7: a link there makes Claude Code load the plugin directory in place (h7@skills-dir). */
export function devLinkPath(home: string): string {
  return join(home, '.claude', 'skills', PLUGIN_NAME);
}

export function inspectDevLink(home: string): DevLink {
  const path = devLinkPath(home);
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (stat === undefined) return { path, state: 'absent', target: null };
  if (!stat.isSymbolicLink()) return { path, state: 'not-a-link', target: null };
  let target: string;
  try {
    target = realpathSync(path);
  } catch {
    return { path, state: 'broken', target: null };
  }
  const manifest = readJson(join(target, '.claude-plugin', 'plugin.json'));
  return { path, state: manifest?.name === PLUGIN_NAME ? 'ok' : 'foreign', target };
}
