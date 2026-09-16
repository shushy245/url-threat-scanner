import { expect } from 'vitest';

import type { Database } from '../../src/db/client';
import { createTestDatabase } from '../support/test-database';

/**
 * The test's view of the pipeline's public API. Written before the units it drives, so the units are
 * shaped by how they need to be used rather than the other way round.
 *
 * Deliberately incomplete while the big circle is skipped — each `when` is filled in as its inner
 * circle goes green.
 */
export type PipelineDriver = {
    assert: {
        everyCheckRecordedExactlyOnce: () => Promise<void>;
        scanCompleted: () => Promise<void>;
        threatScoreWithinBounds: () => Promise<void>;
    };
    close: () => Promise<void>;
    given: { aCleanDatabase: () => Promise<void> };
    when: {
        theRelayDrains: () => Promise<void>;
        theWorkerConsumes: () => Promise<void>;
        theWorkerConsumesTheSameEventAgain: () => Promise<void>;
        urlIsSubmitted: (url: string) => Promise<void>;
    };
};

export const aPipelineDriver = (): PipelineDriver => {
    const state: { database?: Awaited<ReturnType<typeof createTestDatabase>>; scanId?: string } = {};

    const database = async (): Promise<Database> => {
        state.database ??= await createTestDatabase();

        return state.database.db;
    };

    return {
        assert: {
            everyCheckRecordedExactlyOnce: async (): Promise<void> => {
                expect.fail('not implemented until src/checks/ lands');
            },
            scanCompleted: async (): Promise<void> => {
                expect.fail('not implemented until src/checks/ lands');
            },
            threatScoreWithinBounds: async (): Promise<void> => {
                expect.fail('not implemented until src/checks/ lands');
            },
        },
        close: async (): Promise<void> => {
            const database = state.database;
            if (database === undefined) return;

            await database.close();
        },
        given: {
            aCleanDatabase: async (): Promise<void> => {
                await database();
                const database_ = state.database;
                if (database_ === undefined) throw new Error('driver: no database');

                await database_.truncate();
            },
        },
        when: {
            theRelayDrains: async (): Promise<void> => {
                expect.fail('not implemented until src/checks/ lands');
            },
            theWorkerConsumes: async (): Promise<void> => {
                expect.fail('not implemented until src/checks/ lands');
            },
            theWorkerConsumesTheSameEventAgain: async (): Promise<void> => {
                expect.fail('not implemented until src/checks/ lands');
            },
            urlIsSubmitted: async (_url: string): Promise<void> => {
                expect.fail('not implemented until src/checks/ lands');
            },
        },
    };
};
