import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Repo } from '../../plugins/h7/scripts/detect-fs.ts';
import { crates, filesNamed, globToRegex, goModules, goWorkUses, nodePackages, pythonProjects, targets, tokens, tomlSection, tomlSections, yamlList } from '../../plugins/h7/scripts/detect-scan.ts';

const repoOf = (tree: Record<string, string>): Repo => ({
  root: '/r',
  files: Object.keys(tree),
  truncated: false,
  read: (rel) => tree[rel] ?? null,
  has: (rel) => rel in tree,
});

describe('detect-scan: nodePackages', () => {
  it('reads every field of a package.json', () => {
    const warnings: string[] = [];
    const repo = repoOf({
      'apps/a/package.json': JSON.stringify({
        name: '@x/a',
        dependencies: { z: '1', m: '1' },
        devDependencies: { a: '1' },
        peerDependencies: { p: '1' },
        optionalDependencies: { o: '1' },
        scripts: { test: 'vitest', bad: 3 },
        bin: { cli: 'bin/cli.js', bad: 5 },
        main: 'index.js',
        private: true,
        workspaces: ['packages/*', 3],
        packageManager: 'pnpm@9.0.0',
      }),
    });
    assert.deepEqual(nodePackages(repo, warnings), [
      {
        dir: 'apps/a',
        name: '@x/a',
        deps: ['a', 'm', 'o', 'p', 'z'],
        scripts: { test: 'vitest' },
        bins: ['apps/a/bin/cli.js'],
        hasEntry: true,
        private: true,
        workspaces: ['packages/*'],
        packageManager: 'pnpm@9.0.0',
      },
    ]);
    assert.deepEqual(warnings, []);
  });

  it('defaults: name from dir, no deps, string bin, falsy flags', () => {
    const [pkg] = nodePackages(repoOf({ 'tools/t/package.json': JSON.stringify({ bin: 'run.js', private: 'true', packageManager: 9, workspaces: 'x' }) }), []);
    assert.deepEqual(pkg, { dir: 'tools/t', name: 'tools/t', deps: [], scripts: {}, bins: ['tools/t/run.js'], hasEntry: false, private: false, workspaces: [], packageManager: null });
  });

  it('private only when exactly true', () => {
    const priv = (v: unknown) => nodePackages(repoOf({ 'package.json': JSON.stringify({ private: v }) }), [])[0]?.private;
    assert.equal(priv(true), true);
    assert.equal(priv(false), false);
    assert.equal(priv(1), false);
    assert.equal(priv(undefined), false);
  });

  it('every entry field alone makes an entry; others do not', () => {
    const entry = (o: object) => nodePackages(repoOf({ 'package.json': JSON.stringify(o) }), [])[0]?.hasEntry;
    for (const k of ['main', 'module', 'exports', 'types']) assert.equal(entry({ [k]: 'x' }), true, k);
    for (const k of ['bin', 'files', 'browser', 'name']) assert.equal(entry({ [k]: 'x' }), false, k);
    assert.equal(entry({ main: null }), true);
  });

  it('workspaces object form and the packageManager string', () => {
    const [pkg] = nodePackages(repoOf({ 'package.json': JSON.stringify({ workspaces: { packages: ['a', 'b'] }, packageManager: 'yarn@4' }) }), []);
    assert.deepEqual(pkg?.workspaces, ['a', 'b']);
    assert.equal(pkg?.packageManager, 'yarn@4');
  });

  it('only files named exactly package.json, unparseable ones warn', () => {
    const warnings: string[] = [];
    const repo = repoOf({ 'package.json.bak': '{}', 'xpackage.json': '{}', 'a/package.json': '[1]', 'b/package.json': 'nope', 'c/package.json': '{"name":"c"}', 'd/package.json': 'null' });
    assert.deepEqual(nodePackages(repo, warnings).map((p) => p.name), ['c']);
    assert.deepEqual(warnings, ['unparseable a/package.json', 'unparseable b/package.json', 'unparseable d/package.json']);
    assert.deepEqual(filesNamed(repo, (b) => b === 'package.json').length, 4);
  });
});

describe('detect-scan: toml', () => {
  it('tomlSection returns the body up to the next header, indented headers included', () => {
    assert.equal(tomlSection('[a]\nx=1\ny=2\n[b]\nz=3', 'a'), 'x=1\ny=2');
    assert.equal(tomlSection('  [a]  \nx=1\n  [b]\nz=3', 'a'), 'x=1');
    assert.equal(tomlSection('[a]\nlist = ["x"]\nnext = [1, 2]\n[b]\n', 'a'), 'list = ["x"]\nnext = [1, 2]');
    assert.equal(tomlSection('[a]\r\nx=1\r\n[b]', 'a'), 'x=1');
    assert.equal(tomlSection('[a]\n', 'a'), '');
    assert.equal(tomlSection('[ab]\nx', 'a'), null);
  });

  it('tomlSections lists headers, arrays of tables, padded and indented ones', () => {
    assert.deepEqual(tomlSections('[a]\n[ b.c ]\n[[d]]\n  [e]  \n[f]\t\nx = [g]\ny = ["h"]\n[[ i ]]\n'), ['a', 'b.c', 'd', 'e', 'f', 'i']);
    assert.deepEqual(tomlSections('x = 1\n'), []);
  });
});

describe('detect-scan: crates', () => {
  it('a package crate', () => {
    const repo = repoOf({
      'Cargo.toml': '[package]\ncrate_name = "bad"\n  name  =  "tool"\n\n[dependencies]\nserde = "1"\naxum = { version = "0.7" }\n[[bin]]\n',
      'src/lib.rs': '',
    });
    assert.deepEqual(crates(repo), [{ dir: '.', name: 'tool', workspaceMembers: [], isWorkspace: false, hasBin: true, hasLib: true, deps: tokens(repo.read('Cargo.toml') as string) }]);
    assert.ok(crates(repo)[0]?.deps.includes('axum'));
  });

  it('a workspace root and its members', () => {
    const repo = repoOf({
      'Cargo.toml': '[workspace]\nmembers  =  [\n  "crates/a",\n  \'crates/b\',\n]\n',
      'crates/a/Cargo.toml': '[package]\nname = "a"\n',
      'crates/a/src/main.rs': '',
      'crates/b/Cargo.toml': '[package]\nname="b"\n',
      'crates/b/src/lib.rs': '',
      'crates/c/Cargo.toml': '[workspace]\nmembers=["x"]\n',
    });
    const [root, a, b, c] = crates(repo);
    assert.deepEqual([root?.name, root?.isWorkspace, root?.workspaceMembers, root?.hasBin, root?.hasLib], [null, true, ['crates/a', 'crates/b'], false, false]);
    assert.deepEqual([a?.name, a?.isWorkspace, a?.hasBin, a?.hasLib], ['a', false, true, false]);
    assert.deepEqual([b?.name, b?.hasBin, b?.hasLib], ['b', false, true]);
    assert.deepEqual(c?.workspaceMembers, ['x']);
  });

  it('members spacing variants, and bin tables only when they start a line', () => {
    assert.deepEqual(crates(repoOf({ 'Cargo.toml': 'members=["m"]' }))[0]?.workspaceMembers, ['m']);
    assert.deepEqual(crates(repoOf({ 'Cargo.toml': 'members   =   ["m"]' }))[0]?.workspaceMembers, ['m']);
    assert.equal(crates(repoOf({ 'Cargo.toml': 'notes = "[[bin]]"\n' }))[0]?.hasBin, false);
    assert.equal(crates(repoOf({ 'Cargo.toml': '  [[bin]]\n' }))[0]?.hasBin, true);
    assert.equal(crates(repoOf({ 'Cargo.toml': '[package]\nname = "x"', 'sub/src/main.rs': '' }))[0]?.hasBin, false);
  });
});

describe('detect-scan: go', () => {
  const MAIN = 'package main\n\nfunc main() {}\n';

  it('modules with their own mains, nested modules excluded from the parent', () => {
    const repo = repoOf({
      'go.mod': 'module  example.com/root\n\nrequire github.com/gin-gonic/gin v1\n',
      'main.go': MAIN,
      'cmd/app/main.go': MAIN,
      'lib/main.go': 'package lib\n',
      'tools/go.mod': 'module example.com/tools\n',
      'tools/main.go': MAIN,
      'docs/readme.txt': '',
      'docs/main.go': MAIN,
    });
    const [root, tools] = goModules(repo);
    assert.deepEqual([root?.dir, root?.name, root?.mains], ['.', 'example.com/root', ['.', 'cmd/app', 'docs']]);
    assert.ok(root?.deps.includes('github.com/gin-gonic/gin'));
    assert.deepEqual([tools?.dir, tools?.name, tools?.mains], ['tools', 'example.com/tools', ['tools']]);
  });

  it('a nested module keeps its own files even when its parent is a module too', () => {
    const repo = repoOf({ 'a/go.mod': 'module a\n', 'a/b/go.mod': 'module b\n', 'a/b/main.go': MAIN, 'a/main.go': MAIN, 'a/b/c/main.go': MAIN });
    const [a, b] = goModules(repo);
    assert.deepEqual(a?.mains, ['a']);
    assert.deepEqual(b?.mains, ['a/b', 'a/b/c']);
  });

  it('only main.go files of the module directory with a real package main clause', () => {
    const repo = repoOf({
      'svc/go.mod': '// module fake\nmodule real\n',
      'svc/main.go': MAIN,
      'svc/other.go': MAIN,
      'svc/cmd/main.go': '// see package main\npackage cmd\n',
      'svc/x/main.go': 'package  main\n',
      'svc/y/main.go': 'package mainframe\n',
      'svc/z/main.go': '\n\npackage main // entry\n',
      'other/main.go': MAIN,
      'svcx/main.go': MAIN,
    });
    const [m] = goModules(repo);
    assert.equal(m?.name, 'real');
    assert.deepEqual(m?.mains, ['svc', 'svc/x', 'svc/z']);
  });

  it('a module without a name line', () => {
    assert.equal(goModules(repoOf({ 'go.mod': 'go 1.22\n' }))[0]?.name, null);
  });

  it('go.work use directories: blocks, single lines, comments, blanks, nested files', () => {
    const repo = repoOf({
      'go.work': 'go 1.22\n\nuse (\n\t./a\n\t// skipped\n\n\t./b\n)\nuse  ./c\nuse ./d // trailing\n// reuse ./zzz\n  use ./indented\n',
      'sub/go.work': 'use ./e\nuse (\n  ../f\n)\n',
      'go.work.sum': 'use ./nope',
    });
    assert.deepEqual(goWorkUses(repo).sort(), ['a', 'b', 'c', 'd', 'f', 'sub/e'].sort());
    assert.deepEqual(goWorkUses(repoOf({})), []);
  });
});

describe('detect-scan: python', () => {
  it('finds project directories, sorted and deduplicated, from every marker file', () => {
    const repo = repoOf({ 'z/setup.py': '', 'a/requirements-dev.txt': '', 'a/requirements.txt': '', 'm/Pipfile': '', 'n/setup.cfg': '', 'o/pyproject.toml': '', 'p/requirements.txt.bak': '', 'q/xpyproject.toml': '', 'r/Pipfile.lock': '', 'req/requirements_x.in': '' });
    assert.deepEqual(pythonProjects(repo).map((p) => p.dir), ['a', 'm', 'n', 'o', 'z']);
  });

  it('deps come from the marker files of that directory only, not glued together', () => {
    const repo = repoOf({
      'app/requirements.txt': 'flask',
      'app/setup.py': 'requests',
      'app/sub/requirements.txt': 'nested',
      'app/notes.txt': 'ignored',
      'other/requirements.txt': 'elsewhere',
    });
    const app = pythonProjects(repo).find((p) => p.dir === 'app');
    assert.deepEqual(app?.deps, ['flask', 'requests']);
  });

  it('manager precedence: poetry, uv, pdm, pipenv, pip; sections or lock files', () => {
    const mgr = (tree: Record<string, string>) => pythonProjects(repoOf({ 'pyproject.toml': '', ...tree }))[0]?.manager;
    assert.equal(mgr({}), 'pip');
    assert.equal(mgr({ 'pyproject.toml': '[tool.poetry]\n' }), 'poetry');
    assert.equal(mgr({ 'pyproject.toml': '[tool.poetry.dependencies]\n' }), 'poetry');
    assert.equal(mgr({ 'poetry.lock': '' }), 'poetry');
    assert.equal(mgr({ 'pyproject.toml': '[tool.uv]\n' }), 'uv');
    assert.equal(mgr({ 'uv.lock': '' }), 'uv');
    assert.equal(mgr({ 'pyproject.toml': '[tool.pdm.dev]\n' }), 'pdm');
    assert.equal(mgr({ 'pdm.lock': '' }), 'pdm');
    assert.equal(mgr({ Pipfile: '' }), 'pipenv');
    assert.equal(mgr({ 'pyproject.toml': '[tool.uv]\n[tool.poetry]\n', Pipfile: '' }), 'poetry');
    assert.equal(mgr({ 'uv.lock': '', 'pdm.lock': '', Pipfile: '' }), 'uv');
    assert.equal(mgr({ 'pdm.lock': '', Pipfile: '' }), 'pdm');
    assert.equal(mgr({ 'pyproject.toml': '[mytool.poetry]\n[tool.other]\n' }), 'pip');
  });

  it('lock files and manage.py are looked up in the project directory', () => {
    const repo = repoOf({ 'a/pyproject.toml': '', 'a/manage.py': '', 'b/pyproject.toml': '', 'poetry.lock': '' });
    const [a, b] = pythonProjects(repo);
    assert.deepEqual([a?.manager, a?.hasManage], ['pip', true]);
    assert.deepEqual([b?.manager, b?.hasManage], ['pip', false]);
  });

  it('console scripts from both tables, sections list', () => {
    const toml = '[project]\nname = "x"\n[project.scripts]\n  tool = "x:main"\nother-tool=\'x:o\'\n[tool.poetry.scripts]\npoet.run = "x:p"\n\n[tool.black]\nline = 3\n';
    const [p] = pythonProjects(repoOf({ 'pyproject.toml': toml }));
    assert.deepEqual(p?.scripts, ['tool', 'other-tool', 'poet.run']);
    assert.deepEqual(p?.sections, ['project', 'project.scripts', 'tool.poetry.scripts', 'tool.black']);
    assert.deepEqual(pythonProjects(repoOf({ 'requirements.txt': 'django' }))[0], { dir: '.', manager: 'pip', scripts: [], deps: ['django'], sections: [], hasManage: false });
  });
});

describe('detect-scan: targets', () => {
  it('make targets and recipe lines', () => {
    const text = 'VAR := 1\nVAR2 = x\ntest:\n\tpytest\n  \tspaced\nlint :\n\truff check .\nbuild/out.o: dep\n.hidden:\n_x:\n  indented:\nCAPS-1: a\n';
    const t = targets(repoOf({ Makefile: text }));
    assert.deepEqual(t.targets, [
      { source: 'make', dir: '.', name: 'test', command: 'make test' },
      { source: 'make', dir: '.', name: 'lint', command: 'make lint' },
      { source: 'make', dir: '.', name: 'build/out.o', command: 'make build/out.o' },
      { source: 'make', dir: '.', name: 'CAPS-1', command: 'make CAPS-1' },
    ]);
    assert.deepEqual(t.recipeLines, ['pytest', 'ruff check .']);
  });

  it('make files are matched by exact name and listed per directory, names de-duplicated', () => {
    const t = targets(repoOf({ 'sub/GNUmakefile': 'a:\na:\nb:\n', makefile: 'c:\n', 'Makefile.bak': 'z:\n', xMakefile: 'y:\n', makefile2: 'w:\n' }));
    assert.deepEqual(t.targets.map((x) => `${x.dir}:${x.name}`), ['sub:a', 'sub:b', '.:c']);
  });

  it('just recipes and indented lines', () => {
    const text = 'set shell := ["sh"]\nalias b := build\nbuild target="x":\n  cargo build\n\t@echo hi\n   \n@fmt:\n  cargo fmt\nx := "1"\n_hidden arg:\n  y\n';
    const t = targets(repoOf({ justfile: text }));
    assert.deepEqual(t.targets.map((x) => x.name), ['build', 'fmt', '_hidden']);
    assert.deepEqual(t.targets.map((x) => x.command), ['just build', 'just fmt', 'just _hidden']);
    assert.deepEqual(t.recipeLines, ['cargo build', '@echo hi', 'cargo fmt', 'y']);
  });

  it('just files by name', () => {
    const names = (f: string) => targets(repoOf({ [f]: 'a:\n  x\n' })).targets.length;
    assert.equal(names('justfile'), 1);
    assert.equal(names('Justfile'), 1);
    assert.equal(names('.justfile'), 1);
    assert.equal(names('justfile.bak'), 0);
    assert.equal(names('xjustfile'), 0);
    assert.equal(names('JUSTFILE'), 0);
  });

  it('taskfile tasks are the two-space keys under a top-level tasks key', () => {
    const text = 'version: 3\ntasks:  \n  check:\n    cmds: [x]\n  e2e:test:\n    deps:\n      inner:\n  a.b-c:\nother:\n  z: 1\n';
    assert.deepEqual(targets(repoOf({ 'Taskfile.yml': text })).targets.map((x) => x.name), ['check', 'e2e:test', 'a.b-c']);
    assert.deepEqual(targets(repoOf({ 'Taskfile.yaml': 'tasks:\n  a:\n', 'Taskfile.yml.bak': 'tasks:\n  b:\n', 'xTaskfile.yml': 'tasks:\n  c:\n' })).targets.map((x) => x.name), ['a']);
    assert.deepEqual(targets(repoOf({ 'Taskfile.yml': 'xtasks:\n  a:\n' })).targets, []);
    assert.deepEqual(targets(repoOf({ 'Taskfile.yml': 'version: 3\n' })).targets, []);
    assert.deepEqual(targets(repoOf({ 'Taskfile.yml': 'tasks:\n  a:\n  tasks:\n' })).targets.map((x) => x.name), ['a', 'tasks']);
    assert.deepEqual(targets(repoOf({ 'a/Taskfile.yml': 'tasks:\n  a:\n' })).targets, [{ source: 'task', dir: 'a', name: 'a', command: 'task a' }]);
  });

  it('nothing at all', () => {
    assert.deepEqual(targets(repoOf({ 'README.md': '' })), { targets: [], recipeLines: [] });
  });
});

describe('detect-scan: globs and yaml lists', () => {
  it('globToRegex handles stars, leading ./ and trailing slashes', () => {
    assert.ok(globToRegex('x./y').test('x./y'));
    assert.ok(!globToRegex('x./y').test('xy'));
    assert.ok(globToRegex('a//').test('a'));
    assert.ok(!globToRegex('a//').test('a/'));
    assert.ok(globToRegex('./a').test('a'));
    assert.ok(!globToRegex('./a').test('./a'));
    assert.ok(globToRegex('a/**/z').test('a/b/c/z'));
    assert.ok(!globToRegex('a/*/z').test('a/b/c/z'));
    assert.ok(globToRegex('a+b(c)').test('a+b(c)'));
    assert.ok(!globToRegex('a+b').test('aab'));
  });

  it('yamlList reads only the top-level key block list', () => {
    assert.deepEqual(yamlList('name: x\n  - a\npackages:\n  - b\n', 'packages'), ['b']);
    assert.deepEqual(yamlList('packages:  \n  - a\n  -   "b"\n  - \'c\' # note\n  - d e\n  - # bare\n  nested: x - y\n    name: a - b\nnext:\n  - z\n', 'packages'), ['a', 'b', 'c', 'd e']);
    assert.deepEqual(yamlList('packages:\r\n  - a\r\n', 'packages'), ['a']);
    assert.deepEqual(yamlList('  packages:\n  - a\n', 'packages'), []);
    assert.deepEqual(yamlList('x: 1\n', 'packages'), []);
  });
});
