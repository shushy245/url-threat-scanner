import { expect } from 'vitest';

import { createLogger } from '../../src/utils/logger';
import { systemClock } from '../../src/utils/clock.utils';
import { generateUniqueId } from '../../src/utils/id.utils';
import { seededRandom } from '../../src/utils/random.utils';
import { isCompleted } from '../../src/domain/scan/selectors';
import { createTestDatabase } from '../support/test-database';
import { createProcessScan } from '../../src/worker/process-scan';
import type { OutboxEvent } from '../../src/outbox/outbox.repository';
import { createOutboxRepository } from '../../src/outbox/outbox.repository';
import { createScanRepository } from '../../src/repositories/scan.repository';
import { createSimulatedChecks } from '../../src/checks/create-simulated-checks';

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

/**
 * Drives the real pipeline units in the real order — submit, drain, consume — with RabbitMQ replaced
 * by capturing the published event. The broker's own delivery is Rabbit's to guarantee; what this
 * proves is that OUR pieces agree with each other, including when an event arrives twice.
 */
export const aPipelineDriver = (): PipelineDriver => {
    const state: {
        database?: Awaited<ReturnType<typeof createTestDatabase>>;
        published: OutboxEvent[];
        scanId?: string;
    } = { published: [] };

    const database = async (): Promise<Awaited<ReturnType<typeof createTestDatabase>>> => {
        state.database ??= await createTestDatabase();

        return state.database;
    };

    const scanId = (): string => {
        const id = state.scanId;
        if (id === undefined) throw new Error('driver: no url has been submitted yet');

        return id;
    };

    const lastPublished = (): OutboxEvent => {
        const event = state.published[state.published.length - 1];
        if (event === undefined) throw new Error('driver: nothing has been published yet');

        return event;
    };

    const consumeOnce = async (): Promise<void> => {
        const { db } = await database();
        const event = lastPublished();

        const processScan = createProcessScan({
            checkTimeoutMs: 5_000,
            // A fixed seed makes the simulated checks deterministic — the brief asks for randomized
            // results AND for pipeline tests, and those conflict unless the randomness is injected.
            checks: createSimulatedChecks({ clock: systemClock, random: seededRandom(42) }),
            clock: systemClock,
            logger: createLogger({ level: 'silent', service: 'test-worker' }),
            repository: createScanRepository({ db }),
        });

        await processScan({ correlationId: 'test-correlation', payload: event.payload });
    };

    return {
        assert: {
            everyCheckRecordedExactlyOnce: async (): Promise<void> => {
                const { db } = await database();
                const scan = await createScanRepository({ db }).findById(scanId());
                if (scan === undefined) throw new Error('driver: scan disappeared');

                const checkIds = scan.checks.map((check) => check.checkId);

                expect(checkIds).toHaveLength(2);
                expect(new Set(checkIds).size).toBe(checkIds.length);
            },
            scanCompleted: async (): Promise<void> => {
                const { db } = await database();
                const scan = await createScanRepository({ db }).findById(scanId());

                if (scan === undefined) throw new Error('driver: scan disappeared');

                expect(isCompleted(scan)).toBe(true);
            },
            threatScoreWithinBounds: async (): Promise<void> => {
                const { db } = await database();
                const scan = await createScanRepository({ db }).findById(scanId());

                if (scan === undefined || !isCompleted(scan)) {
                    throw new Error('driver: expected a completed scan to score');
                }

                expect(Number.isNaN(scan.threatScore)).toBe(false);
                expect(scan.threatScore).toBeGreaterThanOrEqual(0);
                expect(scan.threatScore).toBeLessThanOrEqual(100);
            },
        },
        close: async (): Promise<void> => {
            const existing = state.database;
            if (existing === undefined) return;

            await existing.close();
        },
        given: {
            aCleanDatabase: async (): Promise<void> => {
                const existing = await database();
                await existing.truncate();
                state.published = [];
                state.scanId = undefined;
            },
        },
        when: {
            theRelayDrains: async (): Promise<void> => {
                const { db } = await database();

                await createOutboxRepository({ db }).drainAndPublish({
                    batchSize: 10,
                    publish: async (event) => {
                        state.published.push(event);
                    },
                });
            },
            theWorkerConsumes: consumeOnce,
            theWorkerConsumesTheSameEventAgain: consumeOnce,
            urlIsSubmitted: async (url: string): Promise<void> => {
                const { db } = await database();
                const id = generateUniqueId('scan');

                await createScanRepository({ db }).submit({
                    clientId: 'pipeline-test-client',
                    domain: new URL(url).hostname,
                    id,
                    idempotencyKey: undefined,
                    normalizedUrl: url,
                    requestHash: `hash-${id}`,
                    url,
                });

                state.scanId = id;
            },
        },
    };
};
