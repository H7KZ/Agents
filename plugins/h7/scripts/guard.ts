import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { runGuard } from './guard-core.ts';
import { spawnRunner } from './git.ts';

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);

const result = runGuard({
  stdin: Buffer.concat(chunks).toString('utf8'),
  env: process.env,
  platform: process.platform,
  runner: spawnRunner,
  realpath: realpathSync,
  homedir: homedir(),
  fallbackCwd: process.cwd(),
  now: () => new Date(),
});
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.code;
