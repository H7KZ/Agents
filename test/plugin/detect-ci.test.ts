import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { detectCi, workflowJobs, workflowTriggers } from '../../plugins/h7/scripts/detect-ci.ts';
import type { Repo } from '../../plugins/h7/scripts/detect-fs.ts';

const repoOf = (tree: Record<string, string>): Repo => ({
  root: '/r',
  files: Object.keys(tree),
  truncated: false,
  read: (rel) => tree[rel] ?? null,
  has: (rel) => rel in tree,
});

describe('detect-ci: workflowTriggers', () => {
  it('inline forms, quotes, brackets, empties and comments', () => {
    assert.deepEqual(workflowTriggers('on: push'), ['push']);
    assert.deepEqual(workflowTriggers('"on": push'), ['push']);
    assert.deepEqual(workflowTriggers("'on': [a, 'b']"), ['a', 'b']);
    assert.deepEqual(workflowTriggers('on: [push]   \n'), ['push']);
    assert.deepEqual(workflowTriggers('on: [push, ]'), ['push']);
    assert.deepEqual(workflowTriggers('on: [push,, pull_request]'), ['push', 'pull_request']);
    assert.deepEqual(workflowTriggers('on:   push   # why'), ['push']);
    assert.deepEqual(workflowTriggers('on: [a[b, c]'), ['a[b', 'c']);
    assert.deepEqual(workflowTriggers('on: [a]x, c]'), ['a]x', 'c']);
    assert.deepEqual(workflowTriggers('on: [x"a"]'), ['x"a"']);
    assert.deepEqual(workflowTriggers('on: ["a"b]'), ['"a"b']);
    assert.deepEqual(workflowTriggers('on: ["a", \'b\', " c "]'), ['a', 'b', ' c ']);
    assert.deepEqual(workflowTriggers('on: ["a\']'), ['"a\'']);
    assert.deepEqual(workflowTriggers('on: []'), []);
  });

  it('the on key must start the line and be a whole key', () => {
    assert.deepEqual(workflowTriggers('rebon: [a]\non: [push]'), ['push']);
    assert.deepEqual(workflowTriggers('  on: [a]\nname: x'), []);
    assert.deepEqual(workflowTriggers('name: x'), []);
  });

  it('block forms take the first key indentation, skipping blanks and comments of any indent', () => {
    assert.deepEqual(workflowTriggers('on:\n      # deep comment\n  push:\n    branches: [a]\n  pull_request:\njobs:\n  x:\n'), ['push', 'pull_request']);
    assert.deepEqual(workflowTriggers('on:\n      \n  push:\n  schedule:\n'), ['push', 'schedule']);
    assert.deepEqual(workflowTriggers('on:\n  -  push\n  - pull_request\n  -   a.b-c\n'), ['push', 'pull_request', 'a.b-c']);
    assert.deepEqual(workflowTriggers('on:\r\n  push:\r\n  workflow_dispatch:\r\njobs:\r\n'), ['push', 'workflow_dispatch']);
  });
});

describe('detect-ci: workflowJobs', () => {
  const commands = (text: string): string[][] => workflowJobs('f.yml', text).map((j) => j.commands);

  it('only the jobs section counts', () => {
    assert.deepEqual(workflowJobs('f', '  a:\n    run: x\njobs:\n  b:\n'), [{ file: 'f', id: 'b', uses: null, commands: [], kinds: [] }]);
    assert.deepEqual(workflowJobs('f', 'myjobs:\n  a:\n'), []);
    assert.deepEqual(workflowJobs('f', 'jobs: {}\n  a:\n'), []);
    assert.deepEqual(workflowJobs('f', 'jobsx:\n  a:\n'), []);
    assert.deepEqual(workflowJobs('f', 'name: x\non:\n  push:\n'), []);
    assert.deepEqual(workflowJobs('f', 'jobs:\n  a:\nother:\n  b:\n'), [{ file: 'f', id: 'a', uses: null, commands: [], kinds: [] }]);
  });

  it('the jobs key tolerates trailing spaces and comments', () => {
    for (const head of ['jobs:   # a long comment', 'jobs:   ', 'jobs: # c', 'jobs:']) {
      assert.deepEqual(workflowJobs('f', `${head}\n  a:\n    steps:\n      - run: x\n`).map((j) => j.id), ['a'], head);
    }
  });

  it('job keys: trailing spaces and comments allowed, list items are not jobs', () => {
    assert.deepEqual(workflowJobs('f', 'jobs:\n  a:   \n  b:  # a long comment\n  c.d-e:\n').map((j) => j.id), ['a', 'b', 'c.d-e']);
    assert.deepEqual(workflowJobs('f', 'jobs:\n  - x:\n'), []);
    assert.deepEqual(workflowJobs('f', 'jobs:\n  a:\n    steps:\n      - name:\n  b:\n').map((j) => j.id), ['a', 'b']);
  });

  it('only keys at the first job indentation are jobs', () => {
    assert.deepEqual(workflowJobs('f', 'jobs:\n    a:\n      needs:\n      with:\n    b:\n').map((j) => j.id), ['a', 'b']);
  });

  it('uses only counts directly under the job', () => {
    const text = 'jobs:\n  a:\n    uses:   "./.github/workflows/x.yml"\n  b:\n    with:\n      uses: deep\n    description: uses: no\n  c:\n    uses:./x.yml\n';
    assert.deepEqual(workflowJobs('f', text).map((j) => j.uses), ['./.github/workflows/x.yml', null, './x.yml']);
  });

  it('run commands: inline, quoted, dash forms and comments', () => {
    const text = [
      'jobs:',
      '  a:',
      '    steps:',
      '      - run: npm ci',
      '      -   run: npm test   # trailing',
      '      - run: "npm run lint"',
      '        run: x',
      '      - name: not run: x',
      '      - run: echo jobs: done',
      '      - run: echo a >',
      '      - run: >out.txt',
      '      - run: |foo',
    ].join('\n');
    assert.deepEqual(commands(text), [['npm ci', 'npm test', 'npm run lint', 'x', 'echo jobs: done', 'echo a >', '>out.txt', '|foo']]);
  });

  it('block scalars end at the key indentation, skip comments and whitespace-only lines', () => {
    const text = [
      'jobs:',
      '  a:',
      '    steps:',
      '      - run: |   ',
      '          one',
      '          # note',
      '      ',
      '          two',
      '        shell: bash',
      '      - run: >+',
      '          three',
      '    other: 1',
      '  b:',
      '    steps:',
      '      run: |-',
      '        four',
      '      next: y',
    ].join('\n');
    assert.deepEqual(commands(text), [['one', 'two', 'three'], ['four']]);
  });

  it('a block scalar at the end of the file and an empty one', () => {
    assert.deepEqual(commands('jobs:\n  a:\n    steps:\n      - run: |\n          last'), [['last']]);
    assert.deepEqual(commands('jobs:\n  a:\n    steps:\n      - run: |'), [[]]);
    assert.deepEqual(commands('jobs:\r\n  a:\r\n    steps:\r\n      - run: |\r\n          x\r\n          y\r\n'), [['x', 'y']]);
  });

  it('kinds are the union over commands, without repeats', () => {
    const jobs = workflowJobs('f', 'jobs:\n  a:\n    steps:\n      - run: pnpm lint\n      - run: pnpm test && pnpm lint\n');
    assert.deepEqual(jobs[0]?.kinds, ['lint', 'unit']);
  });
});

describe('detect-ci: detectCi', () => {
  it('no ci at all', () => {
    assert.deepEqual(detectCi(repoOf({ 'README.md': '' })), { provider: null, providers: [], files: [], parsed: false, triggers: {}, jobs: [] });
  });

  it('github workflows: only direct yml and yaml files under .github/workflows', () => {
    const ci = detectCi(repoOf({
      '.github/workflows/ci.yml': 'on: push\njobs:\n  t:\n    steps:\n      - run: npm test\n',
      '.github/workflows/rel.yaml': 'on: [release]\n',
      '.github/workflows/sub/x.yml': 'on: push\n',
      '.github/workflows/x.yml.bak': 'on: push\n',
      '.github/workflows/x.txt': 'on: push\n',
      'pkg/.github/workflows/y.yml': 'on: push\n',
      'github/workflows/z.yml': 'on: push\n',
    }));
    assert.equal(ci.provider, 'github-actions');
    assert.deepEqual(ci.providers, ['github-actions']);
    assert.deepEqual(ci.files, ['.github/workflows/ci.yml', '.github/workflows/rel.yaml']);
    assert.equal(ci.parsed, true);
    assert.deepEqual(ci.triggers, { 'ci.yml': ['push'], 'rel.yaml': ['release'] });
    assert.deepEqual(ci.jobs.map((j) => [j.file, j.id, j.commands, j.kinds]), [['.github/workflows/ci.yml', 't', ['npm test'], ['unit']]]);
  });

  it('every single file provider, in order, after github actions', () => {
    const all: [string, string][] = [
      ['.gitlab-ci.yml', 'gitlab-ci'],
      ['.circleci/config.yml', 'circleci'],
      ['azure-pipelines.yml', 'azure-pipelines'],
      ['bitbucket-pipelines.yml', 'bitbucket-pipelines'],
      ['.travis.yml', 'travis'],
      ['Jenkinsfile', 'jenkins'],
    ];
    for (const [file, provider] of all) {
      const ci = detectCi(repoOf({ [file]: '' }));
      assert.deepEqual(ci, { provider, providers: [provider], files: [file], parsed: false, triggers: {}, jobs: [] }, file);
    }
    const together = detectCi(repoOf({ Jenkinsfile: '', '.travis.yml': '', '.github/workflows/a.yml': 'on: push\n', '.gitlab-ci.yml': '' }));
    assert.deepEqual(together.providers, ['github-actions', 'gitlab-ci', 'travis', 'jenkins']);
    assert.deepEqual(together.files, ['.github/workflows/a.yml', '.gitlab-ci.yml', '.travis.yml', 'Jenkinsfile']);
    assert.equal(together.provider, 'github-actions');
    assert.equal(detectCi(repoOf({ Jenkinsfile: '', '.travis.yml': '' })).provider, 'travis');
  });
});
