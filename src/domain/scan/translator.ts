import { ScanStatus } from './model';
import type { ScanCheckModel, ScanModel } from './model';
import type { scanCheckTable, scanTable } from '../../db/schema';

type ScanRow = typeof scanTable.$inferSelect;
type ScanCheckRow = typeof scanCheckTable.$inferSelect;

const toCheckModel = (row: ScanCheckRow): ScanCheckModel => ({
    checkId: row.checkId,
    details: row.details,
    durationMs: row.durationMs,
    outcome: row.outcome,
    score: row.score,
});

/**
 * A row that reached a status without the columns that status requires is corrupt, not merely odd.
 * Failing loudly here beats propagating a half-built model — and the message is written to be read
 * at 2am: what operation, which entity, expected versus found.
 */
const required = <T>({
    value,
    field,
    scanId,
    status,
}: {
    value: T | undefined;
    field: string;
    scanId: string;
    status: string;
}): T => {
    if (value === undefined) {
        throw new Error(
            `fromRows: corrupt scan row — id=${scanId}, status=${status}, expected ${field} to be set, found none`,
        );
    }

    return value;
};

export const fromRows = ({ scan, checks }: { scan: ScanRow; checks: readonly ScanCheckRow[] }): ScanModel => {
    const identity = {
        checks: checks.map(toCheckModel),
        clientId: scan.clientId,
        createdAt: scan.createdAt,
        domain: scan.domain,
        id: scan.id,
        normalizedUrl: scan.normalizedUrl,
        updatedAt: scan.updatedAt,
        url: scan.url,
    };

    const context = { scanId: scan.id, status: scan.status };

    if (scan.status === ScanStatus.Pending) {
        return { ...identity, status: ScanStatus.Pending };
    }

    if (scan.status === ScanStatus.InProgress) {
        return {
            ...identity,
            startedAt: required({ ...context, field: 'startedAt', value: scan.startedAt ?? undefined }),
            status: ScanStatus.InProgress,
        };
    }

    if (scan.status === ScanStatus.Completed) {
        return {
            ...identity,
            completedAt: required({ ...context, field: 'completedAt', value: scan.completedAt ?? undefined }),
            startedAt: required({ ...context, field: 'startedAt', value: scan.startedAt ?? undefined }),
            status: ScanStatus.Completed,
            threatScore: required({ ...context, field: 'threatScore', value: scan.threatScore ?? undefined }),
            verdict: required({ ...context, field: 'verdict', value: scan.verdict ?? undefined }),
        };
    }

    return {
        ...identity,
        completedAt: required({ ...context, field: 'completedAt', value: scan.completedAt ?? undefined }),
        error: required({ ...context, field: 'error', value: scan.error ?? undefined }),
        startedAt: scan.startedAt ?? undefined,
        status: ScanStatus.Failed,
    };
};

export type { ScanRow };
