import { expect, vi } from 'vitest';

import { runChecks } from './run-checks';
import type { Clock } from '../utils/clock.utils';
import { CheckOutcome } from '../domain/scan/model';
import type { CheckResult, SecurityCheck } from './check.port';
import type { CheckId, ScanCheckModel } from '../domain/scan/model';

/** Longer than any timeout a test sets, so "hanging" means hanging until something aborts it. */
const FOREVER_MS = 60 * 60 * 1_000;

const A_NORMALIZED_URL = 'https://example.com/login';
const A_DOMAIN = 'example.com';

type DriverState = {
    checks: SecurityCheck[];
    timeoutMs: number;
    clockReading: number;
    results: readonly ScanCheckModel[];
    abortedCheckIds: CheckId[];
    inputsSeen: string[];
    thrown: unknown;
};

export type RunChecksDriver = {
    readonly given: {
        readonly timeoutMs: (milliseconds: number) => void;
        readonly passingCheck: (checkId: CheckId) => void;
        readonly checkReporting: (options: { checkId: CheckId; outcome: CheckOutcome; score: number }) => void;
        readonly checkTakingClockTime: (options: { checkId: CheckId; elapsesMs: number }) => void;
        readonly throwingCheck: (options: { checkId: CheckId; message: string }) => void;
        readonly hangingCheck: (checkId: CheckId) => void;
    };
    readonly when: {
        readonly run: () => Promise<void>;
    };
    readonly assert: {
        readonly recordedCheckIds: (checkIds: readonly CheckId[]) => void;
        readonly outcomeFor: (options: { checkId: CheckId; outcome: CheckOutcome }) => void;
        readonly scoreFor: (options: { checkId: CheckId; score: number }) => void;
        readonly durationFor: (options: { checkId: CheckId; durationMs: number }) => void;
        readonly detailsFor: (options: { checkId: CheckId; details: Record<string, unknown> }) => void;
        readonly errorDetailMentions: (options: { checkId: CheckId; fragment: string }) => void;
        readonly workWasAborted: (checkId: CheckId) => void;
        readonly everyCheckSawTheTarget: () => void;
        readonly noTimersLeft: () => void;
        readonly neverThrew: () => void;
    };
};

export const createRunChecksDriver = (): RunChecksDriver => {
    const state: DriverState = {
        checks: [],
        timeoutMs: 1_000,
        clockReading: 1_700_000_000_000,
        results: [],
        abortedCheckIds: [],
        inputsSeen: [],
        thrown: undefined,
    };

    const clock: Clock = { now: () => state.clockReading };

    const recordInput = (normalizedUrl: string): void => {
        state.inputsSeen.push(normalizedUrl);
    };

    const resultFor = (checkId: CheckId): ScanCheckModel => {
        const result = state.results.find((candidate) => candidate.checkId === checkId);

        if (result === undefined) throw new Error(`driver: no recorded check for checkId=${checkId}`);

        return result;
    };

    const addCheck = (check: SecurityCheck): void => {
        state.checks.push(check);
    };

    const resolvingCheck = (options: { checkId: CheckId; result: CheckResult; elapsesMs: number }): SecurityCheck => ({
        checkId: options.checkId,
        run: (input) => {
            recordInput(input.normalizedUrl);
            state.clockReading += options.elapsesMs;

            return Promise.resolve(options.result);
        },
    });

    return {
        given: {
            timeoutMs: (milliseconds) => {
                state.timeoutMs = milliseconds;
            },
            passingCheck: (checkId) => {
                addCheck(
                    resolvingCheck({
                        checkId,
                        elapsesMs: 0,
                        result: { details: { observed: 'nothing unusual' }, outcome: CheckOutcome.Pass, score: 0 },
                    }),
                );
            },
            checkReporting: ({ checkId, outcome, score }) => {
                addCheck(resolvingCheck({ checkId, elapsesMs: 0, result: { details: {}, outcome, score } }));
            },
            checkTakingClockTime: ({ checkId, elapsesMs }) => {
                addCheck(
                    resolvingCheck({
                        checkId,
                        elapsesMs,
                        result: { details: {}, outcome: CheckOutcome.Pass, score: 0 },
                    }),
                );
            },
            throwingCheck: ({ checkId, message }) => {
                addCheck({
                    checkId,
                    run: (input) => {
                        recordInput(input.normalizedUrl);

                        return Promise.reject(new Error(message));
                    },
                });
            },
            hangingCheck: (checkId) => {
                addCheck({
                    checkId,
                    run: (input) =>
                        new Promise((_resolve, reject) => {
                            recordInput(input.normalizedUrl);
                            const timer = setTimeout(
                                () => _resolve({ details: {}, outcome: CheckOutcome.Pass, score: 0 }),
                                FOREVER_MS,
                            );

                            input.signal.addEventListener(
                                'abort',
                                () => {
                                    clearTimeout(timer);
                                    state.abortedCheckIds.push(checkId);
                                    reject(new Error('the check observed the abort'));
                                },
                                { once: true },
                            );
                        }),
                });
            },
        },
        when: {
            run: async () => {
                const pending = runChecks({
                    checks: state.checks,
                    clock,
                    domain: A_DOMAIN,
                    normalizedUrl: A_NORMALIZED_URL,
                    timeoutMs: state.timeoutMs,
                })
                    .then((results) => {
                        state.results = results;
                    })
                    .catch((error: unknown) => {
                        state.thrown = error;
                    });

                await vi.advanceTimersByTimeAsync(state.timeoutMs + 1);
                await pending;
            },
        },
        assert: {
            recordedCheckIds: (checkIds) => {
                expect(state.results.map((result) => result.checkId)).toEqual(checkIds);
            },
            outcomeFor: ({ checkId, outcome }) => {
                expect(resultFor(checkId).outcome).toBe(outcome);
            },
            scoreFor: ({ checkId, score }) => {
                expect(resultFor(checkId).score).toBe(score);
            },
            durationFor: ({ checkId, durationMs }) => {
                expect(resultFor(checkId).durationMs).toBe(durationMs);
            },
            detailsFor: ({ checkId, details }) => {
                expect(resultFor(checkId).details).toEqual(details);
            },
            errorDetailMentions: ({ checkId, fragment }) => {
                expect(JSON.stringify(resultFor(checkId).details)).toContain(fragment);
            },
            workWasAborted: (checkId) => {
                expect(state.abortedCheckIds).toContain(checkId);
            },
            everyCheckSawTheTarget: () => {
                expect(state.inputsSeen).toEqual(state.checks.map(() => A_NORMALIZED_URL));
            },
            noTimersLeft: () => {
                expect(vi.getTimerCount()).toBe(0);
            },
            neverThrew: () => {
                expect(state.thrown).toBe(undefined);
            },
        },
    };
};
