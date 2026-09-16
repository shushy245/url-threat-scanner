import { and, eq } from 'drizzle-orm';

import type { Database } from '../db/client';
import { fromRows } from '../domain/scan/translator';
import { generateUniqueId } from '../utils/id.utils';
import type { ScanModel } from '../domain/scan/model';
import { isUniqueViolation } from '../utils/postgres-error.utils';
import { outboxEventTable, scanCheckTable, scanTable } from '../db/schema';
import type { ScanRepositoryPort, SubmitScanInput, SubmitScanResult } from './scan.repository.port';
import { SCAN_REQUESTED_EVENT_TYPE, SCAN_REQUESTED_EVENT_VERSION } from '../events/scan-requested.event';

const IDEMPOTENCY_CONSTRAINT = 'scan_client_idempotency_key_uq';
const SCAN_AGGREGATE = 'scan';

export const createScanRepository = ({ db }: { db: Database }): ScanRepositoryPort => {
    const findExistingByKey = async ({
        clientId,
        idempotencyKey,
    }: {
        clientId: string;
        idempotencyKey: string;
    }): Promise<{ id: string; createdAt: Date; updatedAt: Date; requestHash: string | undefined } | undefined> => {
        const [existing] = await db
            .select({
                createdAt: scanTable.createdAt,
                id: scanTable.id,
                requestHash: scanTable.requestHash,
                updatedAt: scanTable.updatedAt,
            })
            .from(scanTable)
            .where(and(eq(scanTable.clientId, clientId), eq(scanTable.idempotencyKey, idempotencyKey)))
            .limit(1);

        if (existing === undefined) return undefined;

        return { ...existing, requestHash: existing.requestHash ?? undefined };
    };

    const submit = async (input: SubmitScanInput): Promise<SubmitScanResult> => {
        try {
            const summary = await db.transaction(async (tx) => {
                const [inserted] = await tx
                    .insert(scanTable)
                    .values({
                        clientId: input.clientId,
                        domain: input.domain,
                        id: input.id,
                        idempotencyKey: input.idempotencyKey,
                        normalizedUrl: input.normalizedUrl,
                        requestHash: input.requestHash,
                        url: input.url,
                    })
                    .returning({
                        createdAt: scanTable.createdAt,
                        id: scanTable.id,
                        updatedAt: scanTable.updatedAt,
                    });

                if (inserted === undefined) {
                    throw new Error(`submit: insert returned no row — scanId=${input.id}`);
                }

                // Same transaction, no exceptions. This line is the whole of ADR-0001: there is no
                // moment where the scan exists and its event does not, in either direction.
                await tx.insert(outboxEventTable).values({
                    aggregateId: input.id,
                    aggregateType: SCAN_AGGREGATE,
                    eventType: SCAN_REQUESTED_EVENT_TYPE,
                    eventVersion: SCAN_REQUESTED_EVENT_VERSION,
                    id: generateUniqueId('obx'),
                    payload: {
                        clientId: input.clientId,
                        domain: input.domain,
                        normalizedUrl: input.normalizedUrl,
                        scanId: input.id,
                    },
                });

                return inserted;
            });

            return { kind: 'created', scan: summary };
        } catch (error) {
            if (!isUniqueViolation({ constraint: IDEMPOTENCY_CONSTRAINT, error })) throw error;
            if (input.idempotencyKey === undefined) throw error;

            // The key was already used. Let the database, not a prior read, decide that — this branch
            // is reached by two concurrent identical submissions, which a check-then-insert would
            // have let through as two scans.
            const existing = await findExistingByKey({
                clientId: input.clientId,
                idempotencyKey: input.idempotencyKey,
            });

            if (existing === undefined) throw error;

            // Same key, different request. Silently returning the first scan here is the failure mode
            // that makes idempotency keys dangerous, so this is a conflict, loudly.
            if (existing.requestHash !== input.requestHash) return { kind: 'conflict' };

            return {
                kind: 'replayed',
                scan: {
                    createdAt: existing.createdAt,
                    id: existing.id,
                    updatedAt: existing.updatedAt,
                },
            };
        }
    };

    const findById = async (id: string): Promise<ScanModel | undefined> => {
        const [scan] = await db.select().from(scanTable).where(eq(scanTable.id, id)).limit(1);
        if (scan === undefined) return undefined;

        const checks = await db.select().from(scanCheckTable).where(eq(scanCheckTable.scanId, id));

        return fromRows({ checks, scan });
    };

    return { findById, submit };
};
