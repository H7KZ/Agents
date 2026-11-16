import type { Crate, GoModule, NodePkg, PyProject, PyManager } from './detect-scan.ts';

export type SurfaceKind = 'web' | 'api' | 'cli' | 'desktop' | 'library';

export interface Surface {
  kind: SurfaceKind;
  name: string;
  dir: string;
  /** Command that starts it, or null when it cannot be derived (a gap for runnable kinds). */
  run: string | null;
  evidence: string;
}

const WEB = ['next', 'vite', 'react-scripts', 'astro', 'nuxt', '@sveltejs/kit', '@remix-run/dev', '@angular/core', 'gatsby', '@vue/cli-service', '@solidjs/start'];
const API = ['express', 'fastify', 'koa', 'hono', '@nestjs/core', 'elysia', '@hapi/hapi', 'restify'];
const DESKTOP = ['electron', '@tauri-apps/cli', '@tauri-apps/api'];
const PY_API = ['fastapi', 'flask', 'django', 'starlette', 'aiohttp'];
const RUST_API = ['axum', 'actix-web', 'rocket', 'warp', 'poem', 'tide'];
const GO_API = ['github.com/gin-gonic/gin', 'github.com/labstack/echo', 'github.com/go-chi/chi', 'github.com/gofiber/fiber', 'github.com/gorilla/mux'];
const GO_DESKTOP = 'github.com/wailsapp/wails';

export const PY_PREFIX: Record<PyManager, string> = { poetry: 'poetry run ', uv: 'uv run ', pdm: 'pdm run ', pipenv: 'pipenv run ', pip: '' };

export interface NodeInput {
  pkg: NodePkg;
  /** Command that runs the package's dev or start script, if any. */
  devRun: string | null;
}

export function nodeSurface({ pkg, devRun }: NodeInput): Surface | null {
  const hit = (list: string[]): string | undefined => list.find((d) => pkg.deps.includes(d));
  const desktop = hit(DESKTOP);
  const web = hit(WEB);
  const api = hit(API);
  const make = (kind: SurfaceKind, evidence: string, run: string | null): Surface => ({ kind, name: pkg.name, dir: pkg.dir, run, evidence });
  if (desktop !== undefined) return make('desktop', `dep:${desktop}`, devRun);
  if (web !== undefined) return make('web', `dep:${web}`, devRun);
  if (api !== undefined) return make('api', `dep:${api}`, devRun);
  if (pkg.bins.length > 0) return make('cli', `bin:${pkg.bins[0]}`, `node ${pkg.bins[0]}`);
  if (pkg.hasEntry) return make('library', 'package.json entry fields', null);
  return null;
}

export function crateSurface(crate: Crate): Surface | null {
  if (crate.name === null) return null;
  const run = crate.dir === '.' ? 'cargo run' : `cargo run -p ${crate.name}`;
  const make = (kind: SurfaceKind, evidence: string, cmd: string | null): Surface => ({ kind, name: crate.name as string, dir: crate.dir, run: cmd, evidence });
  const tauri = crate.deps.includes('tauri');
  const api = RUST_API.find((d) => crate.deps.includes(d));
  if (!crate.hasBin) return crate.hasLib ? make('library', 'src/lib.rs', null) : null;
  if (tauri) return make('desktop', 'cargo:tauri', run);
  if (api !== undefined) return make('api', `cargo:${api}`, run);
  return make('cli', 'cargo bin target', run);
}

export function goSurfaces(mod: GoModule): Surface[] {
  const name = mod.name ?? mod.dir;
  if (mod.mains.length === 0) return [{ kind: 'library', name, dir: mod.dir, run: null, evidence: 'go.mod without package main' }];
  const api = GO_API.find((fw) => mod.deps.some((d) => d.startsWith(fw)));
  const desktop = mod.deps.some((d) => d.startsWith(GO_DESKTOP));
  return mod.mains.map((dir) => {
    const run = dir === '.' ? 'go run .' : `go run ./${dir}`;
    if (desktop) return { kind: 'desktop', name, dir, run, evidence: `go:${GO_DESKTOP}` };
    if (api !== undefined) return { kind: 'api', name, dir, run, evidence: `go:${api}` };
    return { kind: 'cli', name, dir, run, evidence: 'go package main' };
  });
}

export function pythonSurface(project: PyProject): Surface | null {
  const prefix = PY_PREFIX[project.manager];
  const name = project.dir;
  const api = PY_API.find((d) => project.deps.includes(d));
  if (project.hasManage) return { kind: 'api', name, dir: project.dir, run: `${prefix}python manage.py runserver`, evidence: 'manage.py' };
  if (api !== undefined) return { kind: 'api', name, dir: project.dir, run: null, evidence: `py:${api}` };
  if (project.scripts.length > 0) return { kind: 'cli', name, dir: project.dir, run: `${prefix}${project.scripts[0]}`, evidence: 'pyproject scripts' };
  if (project.sections.some((s) => s === 'project' || s.startsWith('tool.poetry'))) return { kind: 'library', name, dir: project.dir, run: null, evidence: 'pyproject project table' };
  return null;
}

export const RUNNABLE: SurfaceKind[] = ['web', 'api', 'cli', 'desktop'];
