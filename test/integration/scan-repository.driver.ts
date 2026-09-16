import { expect } from 'vitest';

import type { Database } from '../../src/db/client';
import { outboxEventTable, scanTable } from '../../src/db/schema';
import { createScanRepository } from '../../src/repositories/scan.repository';
import type {
    ClaimResult,
    ScanRepositoryPort,
    SubmitScanInput,
    SubmitScanResult,
} from '../../src/repositories/scan.repository.port';

export type ScanRepositoryDriver = {
    assert: {
        claimReportedAlreadyHandled: () => void;
        claimReportedMissing: () => void;
        claimSucceeded: () => void;
        everyResultKind: (kinds: readonly string[]) => void;
        outboxRowCountIs: (expected: number) => Promise<void>;
        resultWas: (kind: SubmitScanResult['kind']) => void;
        scanRowCountIs: (expected: number) => Promise<void>;
        scanAndOutboxShareATransaction: () => Promise<void>;
        returnedTheSameScanIdBothTimes: () => void;
    };
    when: {
        claimed: (scanId: string) => Promise<void>;
        submitted: (input: SubmitScanInput) => Promise<void>;
        submittedConcurrently: (inputs: readonly SubmitScanInput[]) => Promise<void>;
    };
};

export const aScanRepositoryDriver = ({ db }: { db: Database }): ScanRepositoryDriver => {
    const repository: ScanRepositoryPort = createScanRepository({ db });
    const state: { results: SubmitScanResult[]; claim?: ClaimResult } = { results: [] };

    const lastClaim = (): ClaimResult => {
        const claim = state.claim;
        if (claim === undefined) throw new Error('driver: no claim has been attempted yet');

        return claim;
    };

    const lastResult = (): SubmitScanResult => {
        const result = state.results[state.results.length - 1];
        if (result === undefined) throw new Error('driver: no submit has been performed yet');

        return result;
    };

    return {
        assert: {
            claimReportedAlreadyHandled: (): void => {
                expect(lastClaim().kind).toBe('already-handled');
            },
            claimReportedMissing: (): void => {
                expect(lastClaim().kind).toBe('missing');
            },
            claimSucceeded: (): void => {
                expect(lastClaim().kind).toBe('claimed');
            },
            everyResultKind: (kinds: readonly string[]): void => {
                expect(state.results.map((result) => result.kind).sort()).toEqual([...kinds].sort());
            },
            outboxRowCountIs: async (expected: number): Promise<void> => {
                const rows = await db.select().from(outboxEventTable);

                expect(rows).toHaveLength(expected);
            },
            resultWas: (kind: SubmitScanResult['kind']): void => {
                expect(lastResult().kind).toBe(kind);
            },
            scanRowCountIs: async (expected: number): Promise<void> => {
                const rows = await db.select().from(scanTable);

                expect(rows).toHaveLength(expected);
            },
            scanAndOutboxShareATransaction: async (): Promise<void> => {
                const [scan] = await db.select().from(scanTable);
                const [event] = await db.select().from(outboxEventTable);

                if (scan === undefined || event === undefined) {
                    throw new Error('driver: expected a scan and an outbox row to compare');
                }

                // Postgres now() is transaction-start scoped, so identical timestamps are proof the
                // two rows committed together rather than merely close in time.
                expect(scan.createdAt.toISOString()).toBe(event.createdAt.toISOString());
            },
            returnedTheSameScanIdBothTimes: (): void => {
                const ids = state.results.flatMap((result) => (result.kind === 'conflict' ? [] : [result.scan.id]));

                expect(new Set(ids).size).toBe(1);
            },
        },
        when: {
            claimed: async (scanId: string): Promise<void> => {
                state.claim = await repository.claimForProcessing(scanId);
            },
            submitted: async (input: SubmitScanInput): Promise<void> => {
                state.results.push(await repository.submit(input));
            },
            submittedConcurrently: async (inputs: readonly SubmitScanInput[]): Promise<void> => {
                const settled = await Promise.allSettled(inputs.map(async (input) => repository.submit(input)));

                state.results.push(
                    ...settled.flatMap((outcome) => (outcome.status === 'fulfilled' ? [outcome.value] : [])),
                );
            },
        },
    };
};
