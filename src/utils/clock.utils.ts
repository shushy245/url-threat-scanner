/**
 * Time as a dependency. The simulated checks and the timeout logic both read the clock, and a test
 * that cannot control time is a test that measures the machine it runs on.
 */
export type Clock = { readonly now: () => number };

export const systemClock: Clock = { now: () => Date.now() };
