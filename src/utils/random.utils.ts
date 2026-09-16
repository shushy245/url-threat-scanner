/**
 * Randomness as a dependency (ADR-0005).
 *
 * The brief asks for randomized check results AND for tests of the scanning pipeline. Those two
 * requirements are in direct conflict unless the randomness is injectable — ambient Math.random
 * would produce a suite that fails one run in twenty for reasons nobody can reproduce.
 */
export type Random = { readonly next: () => number };

export const systemRandom: Random = { next: () => Math.random() };

/**
 * Deterministic generator for tests: mulberry32, a small well-distributed PRNG. Seeded state is held
 * in a locally-constructed object, which is the one place mutation is safe — nothing outside this
 * closure can observe it.
 */
export const seededRandom = (seed: number): Random => {
    const state = { value: seed >>> 0 };

    return {
        next: () => {
            state.value = (state.value + 0x6d_2b_79_f5) >>> 0;
            const drafted = Math.imul(state.value ^ (state.value >>> 15), 1 | state.value);
            const mixed = (drafted + Math.imul(drafted ^ (drafted >>> 7), 61 | drafted)) ^ drafted;

            return ((mixed ^ (mixed >>> 14)) >>> 0) / 4_294_967_296;
        },
    };
};
