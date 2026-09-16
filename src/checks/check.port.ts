import type { CheckId, CheckOutcome } from '../domain/scan/model';

/**
 * The port every security check implements — simulated today (ADR-0005), RDAP and TLS tomorrow.
 * Nothing downstream of it (the runner, the scorer, persistence) knows which is in use.
 */

export type CheckInput = {
    readonly normalizedUrl: string;
    readonly domain: string;
    /**
     * Cancellation, owned by the runner. A check that performs I/O must pass this to it and stop
     * when it fires: the runner's timeout ends its own wait, but only the signal stops the work.
     */
    readonly signal: AbortSignal;
};

export type CheckResult = {
    readonly outcome: CheckOutcome;
    /**
     * The raw severity of THIS check's own finding, 0..100. A check never knows its contribution to
     * the composite score — the weighting is the scorer's policy (see checkWeightMap).
     */
    readonly score: number;
    readonly details: Record<string, unknown>;
};

export type SecurityCheck = {
    readonly checkId: CheckId;
    readonly run: (input: CheckInput) => Promise<CheckResult>;
};
