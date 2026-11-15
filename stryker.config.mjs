import { availableParallelism } from 'node:os';

process.env.H7_MUTATION = '1';

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
  testRunner: 'tap',
  tap: {
    testFiles: ['plugins/h7/test/**/*.test.ts', 'scripts/test/**/*.test.ts', 'bootstrap/test/**/*.test.ts'],
    nodeArgs: ['--import', './scripts/test/mutation-setup.ts', '--test-reporter=tap'],
  },
  mutate: ['plugins/h7/scripts/**/*.ts', 'scripts/**/*.ts', 'bootstrap/**/*.ts', '!**/test/**', '!**/*.test.ts'],
  coverageAnalysis: 'perTest',
  reporters: ['clear-text', 'progress', 'html'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  thresholds: { high: 90, low: 85, break: 80 },
  concurrency: Math.max(1, availableParallelism() - 1),
  timeoutMS: 20000,
  timeoutFactor: 1.5,
  incremental: true,
  incrementalFile: 'reports/stryker-incremental.json',
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
};
