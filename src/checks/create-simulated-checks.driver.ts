import { expect, vi } from 'vitest';

import { CheckId } from '../domain/scan/model';
import type { Clock } from '../utils/clock.utils';
import type { Random } from '../utils/random.utils';
import { seededRandom } from '../utils/random.utils';
import type { CheckOutcome } from '../domain/scan/model';
import type { CheckResult, SecurityCheck } from './check.port';
import { createSimulatedChecks, simulatedDelayRange } from './create-simulated-checks';

type DriverState = {
    random: Random;
    clockReading: number;
    checks: readonly SecurityCheck[];
    controller: AbortController;
    settled: boolean;
    result: CheckResult | undefined;
    previousResult: CheckResult | undefined;
    rejection: unknown;
    pending: Promise<void>;
};

export type SimulatedChecksDriver = {
    readonly given: {
        readonly rolls: (rolls: readonly number[]) => void;
        readonly seed: (seed: number) => void;
        readonly clockReading: (milliseconds: number) => void;
    };
    readonly when: {
        readonly created: () => void;
        readonly started: (checkId: CheckId) => void;
        readonly timePasses: (milliseconds: number) => Promise<void>;
        readonly aborted: () => Promise<void>;
        readonly ranToCompletion: (checkId: CheckId) => Promise<void>;
        readonly ranAgainToCompletion: (checkId: CheckId) => Promise<void>;
    };
    readonly assert: {
        readonly checkIdsAre: (checkIds: readonly CheckId[]) => void;
        readonly stillRunning: () => void;
        readonly outcomeIs: (outcome: CheckOutcome) => void;
        readonly scoreIs: (score: number) => void;
        readonly detailsRecordClockReading: (milliseconds: number) => void;
        readonly rejected: () => void;
        readonly noTimersLeft: () => void;
        readonly bothRunsAgree: () => void;
    };
};

/**
 * A Random that yields exactly the rolls the test names, repeating the last one forever. Distinct
 * from seededRandom, which proves determinism but cannot express "give me a roll of exactly 0.9".
 */
const scriptedRandom = (rolls: readonly number[]): Random => {
    const cursor = { index: 0 };

    return {
        next: () => {
            const roll = rolls[Math.min(cursor.index, rolls.length - 1)];
            cursor.index += 1;

            if (roll === undefined) throw new Error('scriptedRandom: no rolls were scripted');

            return roll;
        },
    };
};

export const createSimulatedChecksDriver = (): SimulatedChecksDriver => {
    const state: DriverState = {
        random: scriptedRandom([0.5]),
        clockReading: 1_700_000_000_000,
        checks: [],
        controller: new AbortController(),
        settled: false,
        result: undefined,
        previousResult: undefined,
        rejection: undefined,
        pending: Promise.resolve(),
    };

    const clock: Clock = { now: () => state.clockReading };

    const create = (): void => {
        state.checks = createSimulatedChecks({ clock, random: state.random });
    };

    const checkBy = (checkId: CheckId): SecurityCheck => {
        const check = state.checks.find((candidate) => candidate.checkId === checkId);

        if (check === undefined) throw new Error(`driver: no simulated check for checkId=${checkId}`);

        return check;
    };

    const start = (checkId: CheckId): void => {
        state.settled = false;
        state.controller = new AbortController();
        state.pending = checkBy(checkId)
            .run({ domain: 'example.com', normalizedUrl: 'https://example.com/', signal: state.controller.signal })
            .then((result) => {
                state.settled = true;
                state.result = result;
            })
            .catch((error: unknown) => {
                state.settled = true;
                state.rejection = error;
            });
    };

    const runToCompletion = async (checkId: CheckId): Promise<void> => {
        create();
        start(checkId);
        await vi.advanceTimersByTimeAsync(simulatedDelayRange.maxMs);
        await state.pending;
    };

    const resultOrThrow = (): CheckResult => {
        if (state.result === undefined) throw new Error('driver: the check has not produced a result');

        return state.result;
    };

    return {
        given: {
            rolls: (rolls) => {
                state.random = scriptedRandom(rolls);
            },
            seed: (seed) => {
                state.random = seededRandom(seed);
            },
            clockReading: (milliseconds) => {
                state.clockReading = milliseconds;
            },
        },
        when: {
            created: create,
            started: (checkId) => {
                create();
                start(checkId);
            },
            timePasses: async (milliseconds) => {
                await vi.advanceTimersByTimeAsync(milliseconds);
            },
            aborted: async () => {
                state.controller.abort();
                await state.pending;
            },
            ranToCompletion: runToCompletion,
            ranAgainToCompletion: async (checkId) => {
                state.previousResult = resultOrThrow();
                await runToCompletion(checkId);
            },
        },
        assert: {
            checkIdsAre: (checkIds) => {
                expect(state.checks.map((check) => check.checkId)).toEqual(checkIds);
            },
            stillRunning: () => {
                expect(state.settled).toBe(false);
            },
            outcomeIs: (outcome) => {
                expect(resultOrThrow().outcome).toBe(outcome);
            },
            scoreIs: (score) => {
                expect(resultOrThrow().score).toBe(score);
            },
            detailsRecordClockReading: (milliseconds) => {
                expect(resultOrThrow().details).toMatchObject({ checkedAt: milliseconds });
            },
            rejected: () => {
                expect(state.rejection).toBeInstanceOf(Error);
            },
            noTimersLeft: () => {
                expect(vi.getTimerCount()).toBe(0);
            },
            bothRunsAgree: () => {
                expect(resultOrThrow()).toEqual(state.previousResult);
            },
        },
    };
};
