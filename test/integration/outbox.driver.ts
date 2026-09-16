import { expect } from 'vitest';

import type { Database } from '../../src/db/client';
import { outboxEventTable } from '../../src/db/schema';
import type { OutboxEvent } from '../../src/outbox/outbox.repository';
import { createOutboxRepository } from '../../src/outbox/outbox.repository';

export type OutboxDriver = {
    assert: {
        drainFailed: () => void;
        publishedIdsInOrder: (expected: readonly string[]) => void;
        rowsMarkedPublished: (expected: number) => Promise<void>;
        drainedCountWas: (expected: number) => void;
    };
    given: { unpublishedEvents: (ids: readonly string[]) => Promise<void> };
    when: {
        drainedSuccessfully: () => Promise<void>;
        drainedWithAFailingBroker: () => Promise<void>;
    };
};

export const anOutboxDriver = ({ db }: { db: Database }): OutboxDriver => {
    const repository = createOutboxRepository({ db });
    const state: { published: OutboxEvent[]; drained: number; failure?: unknown } = {
        drained: 0,
        published: [],
    };

    const drainWith = async (publish: (event: OutboxEvent) => Promise<void>): Promise<void> => {
        try {
            state.drained = await repository.drainAndPublish({ batchSize: 10, publish });
        } catch (error) {
            state.failure = error;
        }
    };

    return {
        assert: {
            drainFailed: (): void => {
                expect(state.failure).toBeDefined();
            },
            publishedIdsInOrder: (expected: readonly string[]): void => {
                expect(state.published.map((event) => event.id)).toEqual(expected);
            },
            rowsMarkedPublished: async (expected: number): Promise<void> => {
                const rows = await db.select().from(outboxEventTable);
                const published = rows.filter((row) => (row.publishedAt ?? undefined) !== undefined);

                expect(published).toHaveLength(expected);
            },
            drainedCountWas: (expected: number): void => {
                expect(state.drained).toBe(expected);
            },
        },
        given: {
            unpublishedEvents: async (ids: readonly string[]): Promise<void> => {
                await db.insert(outboxEventTable).values(
                    ids.map((id) => ({
                        aggregateId: `scan_${id}`,
                        aggregateType: 'scan',
                        eventType: 'ScanRequested',
                        eventVersion: 1,
                        id,
                        payload: { scanId: `scan_${id}` },
                    })),
                );
            },
        },
        when: {
            drainedSuccessfully: async (): Promise<void> => {
                await drainWith(async (event) => {
                    state.published.push(event);
                });
            },
            drainedWithAFailingBroker: async (): Promise<void> => {
                await drainWith(async (event) => {
                    state.published.push(event);
                    throw new Error('broker unavailable');
                });
            },
        },
    };
};
