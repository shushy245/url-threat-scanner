import type { Clock } from '../utils/clock.utils';
import type { Random } from '../utils/random.utils';
import { CheckId, CheckOutcome } from '../domain/scan/model';
import type { CheckInput, CheckResult, SecurityCheck } from './check.port';

type CreateSimulatedChecksOptions = { readonly random: Random; readonly clock: Clock };

type RunSimulatedCheckOptions = {
    readonly checkId: CheckId;
    readonly random: Random;
    readonly clock: Clock;
    readonly signal: AbortSignal;
};

type SleepOptions = { readonly milliseconds: number; readonly signal: AbortSignal };

/** ADR-0005: a simulated check takes 0.5–3s, the plausible range for a real RDAP or TLS round trip. */
export const simulatedDelayRange: { readonly minMs: number; readonly maxMs: number } = { minMs: 500, maxMs: 3_000 };

type OutcomeBand = { readonly belowRoll: number; readonly outcome: CheckOutcome; readonly score: number };

/**
 * The simulated verdict distribution: most URLs are fine, a few look odd, a few are bad. Bands are
 * a table rather than a branch chain so re-weighting the simulation is an edit to data, and
 * CheckOutcome.Error is deliberately absent — an error is the runner's finding about a check, never
 * a check's finding about a URL.
 */
const outcomeBandMap: readonly OutcomeBand[] = [
    { belowRoll: 0.6, outcome: CheckOutcome.Pass, score: 0 },
    { belowRoll: 0.85, outcome: CheckOutcome.Warn, score: 50 },
    { belowRoll: 1, outcome: CheckOutcome.Fail, score: 100 },
];

/** The redirect chain is a documented non-goal for this phase — adding it is one entry here. */
const simulatedCheckIds: readonly CheckId[] = [CheckId.DomainAge, CheckId.SslCertificate];

const drawDelayMs = (random: Random): number =>
    Math.round(simulatedDelayRange.minMs + random.next() * (simulatedDelayRange.maxMs - simulatedDelayRange.minMs));

const bandFor = (roll: number): OutcomeBand => {
    const band = outcomeBandMap.find((candidate) => roll < candidate.belowRoll);

    // Unreachable while next() honours its [0,1) contract, and loud rather than silent if it ever
    // does not: a Random that returns 1 or NaN is a broken dependency, not a URL we may call clean.
    if (band === undefined) throw new Error(`bandFor: roll outside the [0,1) contract — roll=${roll}`);

    return band;
};

/**
 * A sleep that a signal can cut short. clearTimeout on abort is the load-bearing half: without it
 * the caller stops waiting but the timer keeps the work — and the event loop — alive.
 */
const sleep = ({ milliseconds, signal }: SleepOptions): Promise<void> =>
    new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, milliseconds);

        signal.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                reject(new Error(`simulatedCheck: aborted while sleeping — plannedDelayMs=${milliseconds}`));
            },
            { once: true },
        );
    });

/**
 * Draw order is load-bearing for the seeded tests: the delay is drawn first, then the outcome.
 * Swapping them silently changes every seeded expectation in the suite.
 */
const runSimulatedCheck = async ({
    checkId,
    random,
    clock,
    signal,
}: RunSimulatedCheckOptions): Promise<CheckResult> => {
    signal.throwIfAborted();

    const delayMs = drawDelayMs(random);

    await sleep({ milliseconds: delayMs, signal });

    const roll = random.next();
    const band = bandFor(roll);

    return {
        outcome: band.outcome,
        score: band.score,
        details: { checkId, checkedAt: clock.now(), delayMs, roll, simulated: true },
    };
};

/**
 * The simulated implementations of the check port (ADR-0005). Both nondeterministic inputs — how
 * long the check takes and what it finds — are injected, which is what keeps the pipeline tests
 * deterministic while the brief's "randomized results" requirement is still met.
 */
export const createSimulatedChecks = ({ random, clock }: CreateSimulatedChecksOptions): readonly SecurityCheck[] =>
    simulatedCheckIds.map((checkId) => ({
        checkId,
        run: (input: CheckInput): Promise<CheckResult> =>
            runSimulatedCheck({ checkId, clock, random, signal: input.signal }),
    }));
