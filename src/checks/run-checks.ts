import type { Clock } from '../utils/clock.utils';
import type { ScanCheckModel } from '../domain/scan/model';
import { CheckId, CheckOutcome } from '../domain/scan/model';
import type { CheckResult, SecurityCheck } from './check.port';

type RunChecksOptions = {
    readonly checks: readonly SecurityCheck[];
    readonly normalizedUrl: string;
    readonly domain: string;
    readonly timeoutMs: number;
    readonly clock: Clock;
};

type RunOneCheckOptions = {
    readonly check: SecurityCheck;
    readonly normalizedUrl: string;
    readonly domain: string;
    readonly timeoutMs: number;
    readonly clock: Clock;
};

type StartTimeoutOptions = {
    readonly checkId: CheckId;
    readonly timeoutMs: number;
    readonly controller: AbortController;
};

type ExpiringTimeout = { readonly expired: Promise<never>; readonly cancel: () => void };

/** An errored check carries no severity — score 0 here is an absence of signal, not a pass. */
const NO_SCORE = 0;

const noop = (): void => undefined;

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * A timeout that both ends our wait AND stops the work.
 *
 * Promise.race on its own does only the first half: it returns early while the check keeps running
 * and its timer keeps the process alive. Aborting the controller is what actually cancels the work;
 * cancel() clears the timer so a check that answered in time leaves nothing behind.
 */
const startTimeout = ({ checkId, timeoutMs, controller }: StartTimeoutOptions): ExpiringTimeout => {
    // The Promise executor runs synchronously, so `cancel` is wired before this function returns.
    const handle: { cancel: () => void } = { cancel: noop };

    const expired = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => {
            controller.abort();
            reject(new Error(`runChecks: check exceeded its timeout — checkId=${checkId}, timeoutMs=${timeoutMs}`));
        }, timeoutMs);

        handle.cancel = () => clearTimeout(timer);
    });

    return { expired, cancel: () => handle.cancel() };
};

const toScanCheck = (options: {
    readonly checkId: CheckId;
    readonly result: CheckResult;
    readonly durationMs: number;
}): ScanCheckModel => ({
    checkId: options.checkId,
    outcome: options.result.outcome,
    score: options.result.score,
    details: options.result.details,
    durationMs: options.durationMs,
});

const toErroredScanCheck = (options: {
    readonly checkId: CheckId;
    readonly error: unknown;
    readonly durationMs: number;
}): ScanCheckModel => ({
    checkId: options.checkId,
    outcome: CheckOutcome.Error,
    score: NO_SCORE,
    details: { error: messageOf(options.error) },
    durationMs: options.durationMs,
});

/**
 * Runs one check to a recorded result. This function is the containment boundary: it resolves for
 * every possible ending — success, throw, or timeout — and never rejects, which is what lets the
 * caller's Promise.all be a fan-out rather than a short-circuit.
 */
const runOneCheck = async ({
    check,
    normalizedUrl,
    domain,
    timeoutMs,
    clock,
}: RunOneCheckOptions): Promise<ScanCheckModel> => {
    const startedAt = clock.now();
    const controller = new AbortController();
    const timeout = startTimeout({ checkId: check.checkId, controller, timeoutMs });

    try {
        const result = await Promise.race([
            check.run({ domain, normalizedUrl, signal: controller.signal }),
            timeout.expired,
        ]);

        return toScanCheck({ checkId: check.checkId, durationMs: clock.now() - startedAt, result });
    } catch (error) {
        return toErroredScanCheck({ checkId: check.checkId, durationMs: clock.now() - startedAt, error });
    } finally {
        // Success, throw and timeout alike: the timer must go, or it holds the event loop open for
        // the rest of its duration.
        timeout.cancel();
    }
};

/**
 * Runs every check against one target and records what each one found.
 *
 * It never throws and never short-circuits: the consumer calls it unguarded, and a rejection here
 * would dead-letter the message for a scan that mostly succeeded. A check that is down is recorded
 * as an error next to the checks that answered — a WHOIS outage must not blackhole the scan.
 */
export const runChecks = async ({
    checks,
    normalizedUrl,
    domain,
    timeoutMs,
    clock,
}: RunChecksOptions): Promise<readonly ScanCheckModel[]> =>
    Promise.all(checks.map((check) => runOneCheck({ check, clock, domain, normalizedUrl, timeoutMs })));
