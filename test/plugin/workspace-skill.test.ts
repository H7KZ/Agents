import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

const read = (name: string): string => readFileSync(join(import.meta.dirname, '../../plugins/h7/skills', name, 'SKILL.md'), 'utf8');

describe('workspace mode in the skills', () => {
  it('every skill that keeps state or settings sends the agent to workspace.ts show', () => {
    for (const name of ['setup', 'verify', 'work', 'ship', 'review', 'retro']) assert.match(read(name), /scripts\/workspace\.ts" show/, name);
  });

  it('setup makes no branch or commit and writes workspace files in workspace mode', () => {
    const text = read('setup');
    for (const phrase of ['No branch `h7/setup`', 'no commits', 'verification-<repo>.md', '<ws>/.claude/skills/verify-<repo>/SKILL.md', 'workspace `AGENTS.md`', '150-line cap', 'GLOSSARY.md']) assert.ok(text.includes(phrase), phrase);
  });

  it('verify takes the base from the workspace and builds the baseline in the OS temp dir', () => {
    const text = read('verify');
    for (const phrase of ['origin/HEAD', 'origin/develop', 'baseline-tree.ts', 'git archive | tar -x']) assert.ok(text.includes(phrase), phrase);
    assert.ok(text.includes('Never `git worktree add ../h7-base`'));
    assert.ok(!/^\s*git worktree add \.\.\/h7-base/m.test(text));
  });

  it('ship reads settings from the workspace and follows the PR template headings', () => {
    const text = read('ship');
    for (const phrase of ['prTemplate', 'not from `origin/<default>`', 'ITS headings in ITS order', 'trusted']) assert.ok(text.includes(phrase), phrase);
  });

  it('retro targets the workspace AGENTS.md, doctor explains the trust check', () => {
    assert.ok(read('retro').includes('workspace `AGENTS.md`'));
    for (const phrase of ['workspace mode: <dir> (n repos)', 'trust command', '`models`']) assert.ok(read('doctor').includes(phrase), phrase);
  });
});
