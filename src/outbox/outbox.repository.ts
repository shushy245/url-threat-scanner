import { asc, inArray, isNull } from 'drizzle-orm';

import type { Database } from '../db/client';
import { outboxEventTable } from '../db/schema';

export type OutboxEvent = {
    readonly id: string;
    readonly aggregateId: string;
    readonly aggregateType: string;
    readonly eventType: string;
    readonly eventVersion: number;
    readonly payload: Record<string, unknown>;
};

export type OutboxRepositoryPort = {
    /**
     * Drains a batch, publishes each event, and marks them published — all inside ONE transaction.
     *
     * The transaction boundary is the design. `FOR UPDATE SKIP LOCKED` means a second relay instance
     * simply skips rows this one holds, so no event is ever published twice by concurrent relays. If
     * any publish fails the whole transaction rolls back and published_at stays NULL, so the batch is
     * retried on the next pass rather than being silently lost.
     *
     * Trade-off, accepted knowingly: this holds row locks across a network round-trip to the broker.
     * That is why publishing is bounded by a timeout — an unresponsive broker must not pin a
     * transaction open. The locks cover only the drained rows and other relays skip them, so the
     * blast radius is a short delay on a bounded batch, not contention on the table.
     */
    drainAndPublish: (args: { batchSize: number; publish: (event: OutboxEvent) => Promise<void> }) => Promise<number>;
};

export const createOutboxRepository = ({ db }: { db: Database }): OutboxRepositoryPort => ({
    drainAndPublish: async ({ batchSize, publish }) =>
        db.transaction(async (tx) => {
            const rows = await tx
                .select()
                .from(outboxEventTable)
                .where(isNull(outboxEventTable.publishedAt))
                // Ids are time-sortable, so this publishes in roughly the order events happened.
                .orderBy(asc(outboxEventTable.id))
                .limit(batchSize)
                .for('update', { skipLocked: true });

            if (rows.length === 0) return 0;

            for (const row of rows) {
                // Sequential on purpose: publishing concurrently would reorder events on the wire,
                // and the ordering is the only thing the id sort just bought us.
                await publish({
                    aggregateId: row.aggregateId,
                    aggregateType: row.aggregateType,
                    eventType: row.eventType,
                    eventVersion: row.eventVersion,
                    id: row.id,
                    payload: row.payload,
                });
            }

            await tx
                .update(outboxEventTable)
                .set({ publishedAt: new Date() })
                .where(
                    inArray(
                        outboxEventTable.id,
                        rows.map((row) => row.id),
                    ),
                );

            return rows.length;
        }),
});
