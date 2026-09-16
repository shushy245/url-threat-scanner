import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
    {
        test: {
            name: 'unit',
            include: ['src/**/*.test.ts'],
            environment: 'node',
        },
    },
    {
        test: {
            name: 'integration',
            include: ['test/integration/**/*.test.ts'],
            environment: 'node',
            // Integration tests share one Postgres schema, so they must run strictly one at a
            // time — in parallel, one file's truncate wipes another's rows mid-test. singleFork is
            // the setting that actually enforces it; fileParallelism alone does not.
            fileParallelism: false,
            poolOptions: { forks: { singleFork: true } },
            sequence: { concurrent: false },
            testTimeout: 20_000,
            hookTimeout: 30_000,
        },
    },
]);
