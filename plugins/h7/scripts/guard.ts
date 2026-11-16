// Stryker disable all: thin process entry; its logic lives in guard-core.ts (run) and is mutation-tested there.
import { defaultDeps, readAll, run } from './guard-core.ts';

const result = run(await readAll(process.stdin), process.env, defaultDeps());
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.code;
