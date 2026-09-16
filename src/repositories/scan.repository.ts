import { and, eq } from 'drizzle-orm';

import type { Database } from '../db/client';
import { fromRows } from '../domain/scan/translator';
import { generateUniqueId } from '../utils/id.utils';
import { isUniqueViolation } from '../utils/postgres-error.utils';
import { outboxEventTable, scanCheckTable, scanTable } from '../db/schema';
import { type ScanModel, ScanStatus, type Verdict } from '../domain/scan/model';
import { SCAN_REQUESTED_EVENT_TYPE, SCAN_REQUESTED_EVENT_VERSION } from '../events/scan-requested.event';
import type {
    ClaimResult,
    CompletedCheck,
    ScanRepositoryPort,
    SubmitScanInput,
    SubmitScanResult,
} from './scan.repository.port';

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

    const claimForProcessing = async (scanId: string): Promise<ClaimResult> => {
        const claimed = await db
            .update(scanTable)
            .set({ startedAt: new Date(), status: ScanStatus.InProgress, updatedAt: new Date() })
            .where(and(eq(scanTable.id, scanId), eq(scanTable.status, ScanStatus.Pending)))
            .returning({ domain: scanTable.domain, normalizedUrl: scanTable.normalizedUrl });

        const [row] = claimed;
        if (row !== undefined) {
            return { domain: row.domain, kind: 'claimed', normalizedUrl: row.normalizedUrl };
        }

        // Zero rows changed. Disambiguate rather than guess — see ClaimResult.
        const [existing] = await db
            .select({ status: scanTable.status })
            .from(scanTable)
            .where(eq(scanTable.id, scanId))
            .limit(1);

        if (existing === undefined) return { kind: 'missing' };

        return { kind: 'already-handled', status: existing.status };
    };

    const completeScan = async ({
        scanId,
        checks,
        threatScore,
        verdict,
    }: {
        scanId: string;
        checks: readonly CompletedCheck[];
        threatScore: number;
        verdict: Verdict;
    }): Promise<void> => {
        await db.transaction(async (tx) => {
            if (checks.length > 0) {
                await tx.insert(scanCheckTable).values(
                    checks.map((check) => ({
                        checkId: check.checkId,
                        details: check.details,
                        durationMs: check.durationMs,
                        id: generateUniqueId('chk'),
                        outcome: check.outcome,
                        scanId,
                        score: check.score,
                    })),
                );
            }

            await tx
                .update(scanTable)
                .set({
                    completedAt: new Date(),
                    status: ScanStatus.Completed,
                    threatScore,
                    updatedAt: new Date(),
                    verdict,
                })
                .where(eq(scanTable.id, scanId));
        });
    };

    const failScan = async ({ scanId, error }: { scanId: string; error: string }): Promise<void> => {
        await db
            .update(scanTable)
            .set({
                completedAt: new Date(),
                error,
                status: ScanStatus.Failed,
                updatedAt: new Date(),
            })
            .where(eq(scanTable.id, scanId));
    };

    return { claimForProcessing, completeScan, failScan, findById, submit };
};
