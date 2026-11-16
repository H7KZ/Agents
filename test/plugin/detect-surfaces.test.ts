import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Crate, GoModule, NodePkg, PyProject } from '../../plugins/h7/scripts/detect-scan.ts';
import { crateSurface, goSurfaces, nodeSurface, PY_PREFIX, pythonSurface, RUNNABLE } from '../../plugins/h7/scripts/detect-surfaces.ts';

const node = (o: Partial<NodePkg> = {}): NodePkg => ({ dir: 'apps/a', name: '@x/a', deps: [], scripts: {}, bins: [], hasEntry: false, private: false, workspaces: [], packageManager: null, ...o });
const crate = (o: Partial<Crate> = {}): Crate => ({ dir: '.', name: 'c', workspaceMembers: [], isWorkspace: false, hasBin: true, hasLib: false, deps: [], ...o });
const gomod = (o: Partial<GoModule> = {}): GoModule => ({ dir: 'svc', name: 'example.com/svc', mains: ['.'], deps: [], ...o });
const py = (o: Partial<PyProject> = {}): PyProject => ({ dir: 'py', manager: 'pip', scripts: [], deps: [], sections: [], hasManage: false, ...o });

describe('detect-surfaces: node', () => {
  const WEB = ['next', 'vite', 'react-scripts', 'astro', 'nuxt', '@sveltejs/kit', '@remix-run/dev', '@angular/core', 'gatsby', '@vue/cli-service', '@solidjs/start'];
  const API = ['express', 'fastify', 'koa', 'hono', '@nestjs/core', 'elysia', '@hapi/hapi', 'restify'];
  const DESKTOP = ['electron', '@tauri-apps/cli', '@tauri-apps/api'];

  for (const [kind, list] of [['web', WEB], ['api', API], ['desktop', DESKTOP]] as const) {
    for (const dep of list) {
      it(`${dep} is a ${kind} surface that runs the dev script`, () => {
        assert.deepEqual(nodeSurface({ pkg: node({ deps: ['left-pad', dep] }), devRun: 'pnpm dev' }), { kind, name: '@x/a', dir: 'apps/a', run: 'pnpm dev', evidence: `dep:${dep}` });
        assert.equal(nodeSurface({ pkg: node({ deps: [dep] }), devRun: null })?.run, null);
      });
    }
  }

  it('desktop beats web beats api beats cli beats library', () => {
    const all = node({ deps: ['express', 'vite', 'electron'], bins: ['b.js'], hasEntry: true });
    assert.equal(nodeSurface({ pkg: all, devRun: null })?.kind, 'desktop');
    assert.equal(nodeSurface({ pkg: { ...all, deps: ['express', 'vite'] }, devRun: null })?.kind, 'web');
    assert.equal(nodeSurface({ pkg: { ...all, deps: ['express'] }, devRun: null })?.kind, 'api');
    assert.equal(nodeSurface({ pkg: { ...all, deps: [] }, devRun: null })?.kind, 'cli');
    assert.equal(nodeSurface({ pkg: { ...all, deps: [], bins: [] }, devRun: null })?.kind, 'library');
  });

  it('a package with a bin is a cli run through node, named by its first bin', () => {
    assert.deepEqual(nodeSurface({ pkg: node({ bins: ['bin/cli.js', 'bin/other.js'] }), devRun: 'pnpm dev' }), { kind: 'cli', name: '@x/a', dir: 'apps/a', run: 'node bin/cli.js', evidence: 'bin:bin/cli.js' });
  });

  it('an entry-only package is a library without a run command, and nothing else is a surface', () => {
    assert.deepEqual(nodeSurface({ pkg: node({ hasEntry: true }), devRun: 'x' }), { kind: 'library', name: '@x/a', dir: 'apps/a', run: null, evidence: 'package.json entry fields' });
    assert.equal(nodeSurface({ pkg: node(), devRun: 'x' }), null);
  });
});

describe('detect-surfaces: rust', () => {
  it('a nameless crate is no surface, even with a binary', () => {
    assert.equal(crateSurface(crate({ name: null })), null);
    assert.equal(crateSurface(crate({ name: null, hasLib: true, hasBin: false })), null);
  });

  it('a library crate has no run command; a crate without targets is nothing', () => {
    assert.deepEqual(crateSurface(crate({ hasBin: false, hasLib: true, deps: ['tauri', 'axum'] })), { kind: 'library', name: 'c', dir: '.', run: null, evidence: 'src/lib.rs' });
    assert.equal(crateSurface(crate({ hasBin: false })), null);
  });

  it('run command depends on whether the crate is the root', () => {
    assert.equal(crateSurface(crate())?.run, 'cargo run');
    assert.equal(crateSurface(crate({ dir: 'crates/c' }))?.run, 'cargo run -p c');
  });

  it('tauri beats web frameworks; each framework is an api; otherwise a cli', () => {
    assert.deepEqual(crateSurface(crate({ deps: ['axum', 'tauri'], dir: 'd' })), { kind: 'desktop', name: 'c', dir: 'd', run: 'cargo run -p c', evidence: 'cargo:tauri' });
    for (const fw of ['axum', 'actix-web', 'rocket', 'warp', 'poem', 'tide']) {
      assert.deepEqual(crateSurface(crate({ deps: ['serde', fw] })), { kind: 'api', name: 'c', dir: '.', run: 'cargo run', evidence: `cargo:${fw}` });
    }
    assert.deepEqual(crateSurface(crate({ deps: ['serde'] })), { kind: 'cli', name: 'c', dir: '.', run: 'cargo run', evidence: 'cargo bin target' });
  });
});

describe('detect-surfaces: go', () => {
  it('a module without main packages is a library named by module, else by directory', () => {
    assert.deepEqual(goSurfaces(gomod({ mains: [] })), [{ kind: 'library', name: 'example.com/svc', dir: 'svc', run: null, evidence: 'go.mod without package main' }]);
    assert.equal(goSurfaces(gomod({ mains: [], name: null }))[0]?.name, 'svc');
  });

  it('each main package is a surface with its own run command', () => {
    assert.deepEqual(goSurfaces(gomod({ mains: ['.', 'cmd/a'] })), [
      { kind: 'cli', name: 'example.com/svc', dir: '.', run: 'go run .', evidence: 'go package main' },
      { kind: 'cli', name: 'example.com/svc', dir: 'cmd/a', run: 'go run ./cmd/a', evidence: 'go package main' },
    ]);
    assert.equal(goSurfaces(gomod({ name: null }))[0]?.name, 'svc');
  });

  it('web frameworks by module prefix make it an api; wails makes it desktop and wins', () => {
    for (const fw of ['github.com/gin-gonic/gin', 'github.com/labstack/echo', 'github.com/go-chi/chi', 'github.com/gofiber/fiber', 'github.com/gorilla/mux']) {
      assert.deepEqual(goSurfaces(gomod({ deps: ['golang.org/x/net', `${fw}/v5`] })), [{ kind: 'api', name: 'example.com/svc', dir: '.', run: 'go run .', evidence: `go:${fw}` }]);
      assert.equal(goSurfaces(gomod({ deps: [fw] }))[0]?.kind, 'api');
      assert.equal(goSurfaces(gomod({ deps: [`vendor/${fw}`] }))[0]?.kind, 'cli', 'only a prefix counts');
    }
    const desktop = goSurfaces(gomod({ deps: ['github.com/gin-gonic/gin', 'github.com/wailsapp/wails/v2'] }));
    assert.deepEqual(desktop, [{ kind: 'desktop', name: 'example.com/svc', dir: '.', run: 'go run .', evidence: 'go:github.com/wailsapp/wails' }]);
    assert.equal(goSurfaces(gomod({ deps: ['x/github.com/wailsapp/wails'] }))[0]?.kind, 'cli');
  });
});

describe('detect-surfaces: python', () => {
  it('run prefixes per package manager', () => {
    assert.deepEqual(PY_PREFIX, { poetry: 'poetry run ', uv: 'uv run ', pdm: 'pdm run ', pipenv: 'pipenv run ', pip: '' });
  });

  it('manage.py means a django style api with a run command, whatever else is declared', () => {
    assert.deepEqual(pythonSurface(py({ hasManage: true, manager: 'uv', deps: ['flask'], scripts: ['x'] })), { kind: 'api', name: 'py', dir: 'py', run: 'uv run python manage.py runserver', evidence: 'manage.py' });
    assert.equal(pythonSurface(py({ hasManage: true }))?.run, 'python manage.py runserver');
  });

  it('web frameworks are apis without a derivable run command', () => {
    for (const fw of ['fastapi', 'flask', 'django', 'starlette', 'aiohttp']) {
      assert.deepEqual(pythonSurface(py({ deps: ['requests', fw], scripts: ['s'] })), { kind: 'api', name: 'py', dir: 'py', run: null, evidence: `py:${fw}` });
    }
  });

  it('console scripts are a cli run through the manager', () => {
    assert.deepEqual(pythonSurface(py({ scripts: ['tool', 'other'], manager: 'poetry', sections: ['project'] })), { kind: 'cli', name: 'py', dir: 'py', run: 'poetry run tool', evidence: 'pyproject scripts' });
    assert.equal(pythonSurface(py({ scripts: ['tool'], manager: 'pipenv' }))?.run, 'pipenv run tool');
    assert.equal(pythonSurface(py({ scripts: ['tool'], manager: 'pdm' }))?.run, 'pdm run tool');
    assert.equal(pythonSurface(py({ scripts: ['tool'] }))?.run, 'tool');
  });

  it('a project table makes a library; anything else is nothing', () => {
    const lib = { kind: 'library', name: 'py', dir: 'py', run: null, evidence: 'pyproject project table' };
    assert.deepEqual(pythonSurface(py({ sections: ['build-system', 'project'] })), lib);
    assert.deepEqual(pythonSurface(py({ sections: ['tool.poetry'] })), lib);
    assert.deepEqual(pythonSurface(py({ sections: ['tool.poetry.dependencies'] })), lib);
    assert.equal(pythonSurface(py({ sections: ['project.optional-dependencies', 'tool.black', 'xtool.poetry', 'poetry'] })), null);
    assert.equal(pythonSurface(py()), null);
  });

  it('only these kinds can be run', () => {
    assert.deepEqual(RUNNABLE, ['web', 'api', 'cli', 'desktop']);
  });
});
