import type { ScanModel } from '../domain/scan/model';

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

export type ScanRepositoryPort = {
    /**
     * Writes the scan and its ScanRequested outbox row in ONE transaction (ADR-0001). Returning the
     * server-generated timestamps is a deliberate exception to command-query separation: they are
     * precisely the values the client cannot know, and a second read to fetch them would reintroduce
     * the race the single transaction exists to remove.
     */
    submit: (input: SubmitScanInput) => Promise<SubmitScanResult>;
    findById: (id: string) => Promise<ScanModel | undefined>;
};
