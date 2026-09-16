import { randomBytes } from 'node:crypto';

/**
 * Prefixed, lexicographically time-sortable identifiers.
 *
 * The alphabet is deliberately in ASCII order (digits < uppercase < lowercase), which is what makes
 * a fixed-width base-62 encoding sort lexicographically in the same order it sorts numerically.
 * That buys three things for free: the id names its own type in logs and DB rows, keyset pagination
 * gets a stable sort key, and inserts stay local in the B-tree instead of scattering like a UUIDv4.
 *
 * These are identifiers, not secrets — never use one as a capability token.
 */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const BASE = ALPHABET.length;

// 62^8 ms of range — good past the year 8000. Fixed width is load-bearing: a variable-width
// timestamp would sort '9' after '10' and silently break the ordering guarantee.
const TIMESTAMP_WIDTH = 8;
const RANDOM_WIDTH = 12;

type GenerateIdOptions = { readonly now: number };

const encodeFixedWidthBase62 = ({ value, width }: { value: number; width: number }): string =>
    Array.from({ length: width }, (_digit, index) =>
        ALPHABET.charAt(Math.floor(value / BASE ** (width - 1 - index)) % BASE),
    ).join('');

const randomBase62 = (width: number): string =>
    Array.from(randomBytes(width), (byte) => ALPHABET.charAt(byte % BASE)).join('');

// The clock is a default argument rather than an optional field: default arguments are evaluated
// per call, so this stays a real clock read while remaining injectable from a test.
export const generateUniqueId = (prefix: string, { now }: GenerateIdOptions = { now: Date.now() }): string =>
    `${prefix}_${encodeFixedWidthBase62({ value: now, width: TIMESTAMP_WIDTH })}${randomBase62(RANDOM_WIDTH)}`;
