import type { ScanModel } from '../../domain/scan/model';
import { isCompleted, isFailed, isInProgress } from '../../domain/scan/selectors';

type ScanCheckResponse = {
    readonly checkId: string;
    readonly outcome: string;
    readonly score: number;
    readonly details: Record<string, unknown>;
    readonly durationMs: number;
};

export type ScanResponse = {
    readonly id: string;
    readonly url: string;
    readonly domain: string;
    readonly status: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly checks: readonly ScanCheckResponse[];
    readonly startedAt?: string;
    readonly completedAt?: string;
    readonly threatScore?: number;
    readonly verdict?: string;
    readonly error?: string;
};

/**
 * Model to wire. The status union is narrowed with the selectors, so each branch reads its own
 * fields directly — no optional chaining, no "it should be there by now" assumptions.
 */
export const toScanResponse = (scan: ScanModel): ScanResponse => {
    const base = {
        checks: scan.checks.map((check) => ({
            checkId: check.checkId,
            details: check.details,
            durationMs: check.durationMs,
            outcome: check.outcome,
            score: check.score,
        })),
        createdAt: scan.createdAt.toISOString(),
        domain: scan.domain,
        id: scan.id,
        status: scan.status,
        updatedAt: scan.updatedAt.toISOString(),
        url: scan.url,
    };

    if (isInProgress(scan)) return { ...base, startedAt: scan.startedAt.toISOString() };

    if (isCompleted(scan)) {
        return {
            ...base,
            completedAt: scan.completedAt.toISOString(),
            startedAt: scan.startedAt.toISOString(),
            threatScore: scan.threatScore,
            verdict: scan.verdict,
        };
    }

    if (isFailed(scan)) {
        return {
            ...base,
            completedAt: scan.completedAt.toISOString(),
            error: scan.error,
            ...(scan.startedAt === undefined ? {} : { startedAt: scan.startedAt.toISOString() }),
        };
    }

    return base;
};
