import { describe, expect, it } from 'vitest';

import { generateUniqueId } from './id.utils';

describe('generateUniqueId', () => {
    it('prefixes the id with the given type name', () => {
        expect(generateUniqueId('scan')).toMatch(/^scan_[0-9A-Za-z]+$/u);
    });

    it('produces a fixed-width id so ids of the same type are comparable', () => {
        expect(generateUniqueId('scan')).toHaveLength(generateUniqueId('scan').length);
    });

    it('never collides across a tight loop within the same millisecond', () => {
        const ids = new Set(Array.from({ length: 10_000 }, () => generateUniqueId('scan')));

        expect(ids.size).toBe(10_000);
    });

    it('sorts lexicographically in the order the ids were created', () => {
        const earlier = generateUniqueId('scan', { now: 1_700_000_000_000 });
        const later = generateUniqueId('scan', { now: 1_700_000_000_001 });

        expect([later, earlier].sort()).toEqual([earlier, later]);
    });

    it('keeps sorting correctly across a base-62 digit rollover', () => {
        const before = generateUniqueId('scan', { now: 62 ** 6 - 1 });
        const after = generateUniqueId('scan', { now: 62 ** 6 });

        expect([after, before].sort()).toEqual([before, after]);
    });
});
