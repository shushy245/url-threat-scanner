import type { CheckId, CheckOutcome, ScanModel, Verdict } from '../domain/scan/model';

export type ScanSummary = {
    readonly id: string;
    readonly createdAt: Date;
    readonly updatedAt: Date;
};

export type SubmitScanInput = {
    readonly id: string;
    readonly clientId: string;
    readonly url: string;
    readonly normalizedUrl: string;
    readonly domain: string;
    readonly idempotencyKey: string | undefined;
    readonly requestHash: string;
};

/**
 * Three outcomes, as a discriminated union rather than a nullable result plus a flag — the caller
 * maps each to a different status code and must handle all three.
 */
export type SubmitScanResult =
    | { readonly kind: 'created'; readonly scan: ScanSummary }
    | { readonly kind: 'replayed'; readonly scan: ScanSummary }
    | { readonly kind: 'conflict' };

/**
 * Why three outcomes and not a boolean: a compare-and-swap that changes no rows is ambiguous. The
 * scan may already have been handled (a redelivery — correct, ack and move on) or it may not exist
 * at all (a genuine fault — dead-letter it). Collapsing both into "false" silently discards real
 * work, which is the failure this union exists to make impossible.
 */
export type ClaimResult =
    | { readonly kind: 'claimed'; readonly normalizedUrl: string; readonly domain: string }
    | { readonly kind: 'already-handled'; readonly status: string }
    | { readonly kind: 'missing' };

export type CompletedCheck = {
    readonly checkId: CheckId;
    readonly outcome: CheckOutcome;
    readonly score: number;
    readonly details: Record<string, unknown>;
    readonly durationMs: number;
};

export type ScanRepositoryPort = {
    /**
     * Writes the scan and its ScanRequested outbox row in ONE transaction (ADR-0001). Returning the
     * server-generated timestamps is a deliberate exception to command-query separation: they are
     * precisely the values the client cannot know, and a second read to fetch them would reintroduce
     * the race the single transaction exists to remove.
     */
    submit: (input: SubmitScanInput) => Promise<SubmitScanResult>;
    findById: (id: string) => Promise<ScanModel | undefined>;

    /**
     * Moves pending -> in_progress with a single conditional UPDATE. This one statement is both the
     * idempotency guard and the stale-update guard: a redelivered event finds the row no longer
     * pending and changes nothing, so reprocessing is a no-op rather than duplicate work.
     */
    claimForProcessing: (scanId: string) => Promise<ClaimResult>;

    /** Writes every check result, the score and the terminal status in ONE transaction. */
    completeScan: (args: {
        scanId: string;
        checks: readonly CompletedCheck[];
        threatScore: number;
        verdict: Verdict;
    }) => Promise<void>;

    failScan: (args: { scanId: string; error: string }) => Promise<void>;
};
