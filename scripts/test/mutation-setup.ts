import fc from 'fast-check';

if (process.env.H7_MUTATION === '1') fc.configureGlobal({ numRuns: 20 });
