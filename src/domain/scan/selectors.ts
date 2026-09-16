import { CheckOutcome, ScanStatus } from './model';
import type { ScanCheckModel, ScanModel } from './model';

/**
 * The model's public API. Narrow with a guard clause, then access variant fields directly — no
 * optional chaining, no casts.
 */

export const isPending = (scan: ScanModel): scan is Extract<ScanModel, { status: ScanStatus.Pending }> =>
    scan.status === ScanStatus.Pending;

export const isInProgress = (scan: ScanModel): scan is Extract<ScanModel, { status: ScanStatus.InProgress }> =>
    scan.status === ScanStatus.InProgress;

export const isCompleted = (scan: ScanModel): scan is Extract<ScanModel, { status: ScanStatus.Completed }> =>
    scan.status === ScanStatus.Completed;

export const isFailed = (scan: ScanModel): scan is Extract<ScanModel, { status: ScanStatus.Failed }> =>
    scan.status === ScanStatus.Failed;

export const isTerminal = (scan: ScanModel): boolean => isCompleted(scan) || isFailed(scan);

/** An errored check is an absence of signal, not a judgement — scoring must exclude it. */
export const isErrored = (check: ScanCheckModel): boolean => check.outcome === CheckOutcome.Error;

export const hasUsableSignal = (checks: readonly ScanCheckModel[]): boolean =>
    checks.some((check) => !isErrored(check));
