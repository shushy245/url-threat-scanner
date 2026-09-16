/**
 * The scan domain model. Types and enums only — no logic (that lives in selectors, scoring and the
 * translator).
 */

export enum ScanStatus {
    Pending = 'pending',
    InProgress = 'in_progress',
    Completed = 'completed',
    Failed = 'failed',
}

export enum CheckId {
    DomainAge = 'domain_age',
    SslCertificate = 'ssl_certificate',
    RedirectChain = 'redirect_chain',
}

export enum CheckOutcome {
    Pass = 'pass',
    Warn = 'warn',
    Fail = 'fail',
    /** The check itself could not run — not a judgement about the URL. */
    Error = 'error',
}

export enum Verdict {
    Clean = 'clean',
    Suspicious = 'suspicious',
    Malicious = 'malicious',
    /**
     * We ran and learned nothing — every check errored. Deliberately distinct from Clean: a security
     * product must never report "safe" when it means "could not tell".
     */
    Unknown = 'unknown',
}

export type ScanCheckModel = {
    readonly checkId: CheckId;
    readonly outcome: CheckOutcome;
    readonly score: number;
    readonly details: Record<string, unknown>;
    readonly durationMs: number;
};

type ScanIdentity = {
    readonly id: string;
    readonly clientId: string;
    readonly url: string;
    readonly normalizedUrl: string;
    readonly domain: string;
    readonly createdAt: Date;
    readonly updatedAt: Date;
    readonly checks: readonly ScanCheckModel[];
};

/**
 * Status is a discriminated union rather than a flat row of optional fields, because the presence of
 * threatScore, verdict and completedAt DEPENDS on status — that is a variant, not an optional.
 *
 * Flat optionals would allow a completed scan with no score and force every consumer to defensively
 * re-check fields it already knows are there. Here, narrowing once gives clean access everywhere.
 */
export type ScanModel = ScanIdentity &
    (
        | { readonly status: ScanStatus.Pending }
        | { readonly status: ScanStatus.InProgress; readonly startedAt: Date }
        | {
              readonly status: ScanStatus.Completed;
              readonly startedAt: Date;
              readonly completedAt: Date;
              readonly threatScore: number;
              readonly verdict: Verdict;
          }
        | {
              readonly status: ScanStatus.Failed;
              readonly startedAt: Date | undefined;
              readonly completedAt: Date;
              readonly error: string;
          }
    );
