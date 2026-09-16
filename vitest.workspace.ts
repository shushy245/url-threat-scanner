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
            // Integration tests share one Postgres schema; running files in parallel
            // would let them clobber each other's rows.
            fileParallelism: false,
            testTimeout: 20_000,
            hookTimeout: 30_000,
        },
    },
]);
