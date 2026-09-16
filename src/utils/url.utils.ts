/**
 * URL normalization and the SSRF guard.
 *
 * A URL scanner is, structurally, a server-side request forgery engine: it fetches addresses chosen
 * by whoever is being attacked. This module is what stops it being one (ADR-0004).
 *
 * Two entry points, deliberately separate:
 *   validateSubmittedUrl — runs at the API boundary, on the literal the client sent.
 *   isBlockedIpAddress   — runs again after DNS resolution and after every redirect hop.
 *
 * The second is not redundant. A guard that only inspects the literal is defeated by a perfectly
 * public hostname whose A record points at 127.0.0.1 (DNS rebinding); what must be checked is the
 * address actually connected to.
 */

import { parseUrl } from './parse-url.utils';

export type TargetValidation =
    | { readonly kind: 'valid'; readonly normalizedUrl: string; readonly domain: string }
    | { readonly kind: 'invalid'; readonly reason: string };

export const isValidTarget = (
    validation: TargetValidation,
): validation is Extract<TargetValidation, { kind: 'valid' }> => validation.kind === 'valid';

const ALLOWED_PROTOCOLS = ['http:', 'https:'];

/**
 * Blocked IPv4 space. A data table rather than a chain of comparisons: adding a range is a new row,
 * never an edit to control flow (Open/Closed).
 */
const BLOCKED_IPV4_RANGES = [
    { cidr: '0.0.0.0/8', label: 'reserved (unspecified)' },
    { cidr: '10.0.0.0/8', label: 'private' },
    { cidr: '100.64.0.0/10', label: 'private (carrier-grade NAT)' },
    { cidr: '127.0.0.0/8', label: 'loopback' },
    { cidr: '169.254.0.0/16', label: 'link-local (cloud metadata)' },
    { cidr: '172.16.0.0/12', label: 'private' },
    { cidr: '192.0.0.0/24', label: 'reserved (IETF protocol assignments)' },
    { cidr: '192.0.2.0/24', label: 'reserved (TEST-NET-1)' },
    { cidr: '192.168.0.0/16', label: 'private' },
    { cidr: '198.18.0.0/15', label: 'reserved (benchmarking)' },
    { cidr: '198.51.100.0/24', label: 'reserved (TEST-NET-2)' },
    { cidr: '203.0.113.0/24', label: 'reserved (TEST-NET-3)' },
    { cidr: '224.0.0.0/4', label: 'reserved (multicast)' },
    { cidr: '240.0.0.0/4', label: 'reserved (future use)' },
] as const;

/**
 * One numeric part of an inet_aton host. `0x7f` is hex, `0177` is octal, `127` is decimal — and
 * every one of them is a valid way to write part of an address that browsers and curl accept.
 */
const parseNumericPart = (part: string): number | undefined => {
    if (/^0[xX][0-9a-fA-F]+$/u.test(part)) return Number.parseInt(part.slice(2), 16);
    if (/^0[0-7]+$/u.test(part)) return Number.parseInt(part.slice(1), 8);
    if (/^[0-9]+$/u.test(part)) return Number.parseInt(part, 10);

    return undefined;
};

/**
 * inet_aton semantics: a host may have 1–4 parts, and a short form packs the remaining bytes into
 * the last part. `127.1` is 127.0.0.1; `2130706433` is 127.0.0.1.
 *
 * Node's WHATWG URL parser already normalizes these to dotted-quad, so for URL-sourced hosts this is
 * belt and braces. It is implemented anyway because depending on an undocumented normalization
 * inside a dependency is exactly the assumption that breaks silently on upgrade.
 */
const parseIpv4 = (hostname: string): number | undefined => {
    const parts = hostname.split('.');
    if (parts.length > 4) return undefined;

    const values = parts.map(parseNumericPart).filter((value): value is number => value !== undefined);
    if (values.length !== parts.length) return undefined;

    const [first, second, third, fourth] = values;
    if (first === undefined) return undefined;

    if (second === undefined) return first <= 0xff_ff_ff_ff ? first : undefined;

    if (third === undefined) {
        return first <= 0xff && second <= 0xff_ff_ff ? first * 0x1_00_00_00 + second : undefined;
    }

    if (fourth === undefined) {
        return first <= 0xff && second <= 0xff && third <= 0xff_ff
            ? first * 0x1_00_00_00 + second * 0x1_00_00 + third
            : undefined;
    }

    return [first, second, third, fourth].every((value) => value <= 0xff)
        ? first * 0x1_00_00_00 + second * 0x1_00_00 + third * 0x1_00 + fourth
        : undefined;
};

const PARSED_BLOCKED_RANGES = BLOCKED_IPV4_RANGES.map(({ cidr, label }) => {
    const [address = '', prefixBits = '32'] = cidr.split('/');
    const bits = Number.parseInt(prefixBits, 10);

    return {
        base: parseIpv4(address) ?? 0,
        label,
        mask: bits === 0 ? 0 : (0xff_ff_ff_ff << (32 - bits)) >>> 0,
    };
});

const findBlockedIpv4Label = (value: number): string | undefined => {
    const range = PARSED_BLOCKED_RANGES.find((candidate) => (value & candidate.mask) >>> 0 === candidate.base);
    if (range === undefined) return undefined;

    return range.label;
};

const parseHexGroup = (group: string): number | undefined =>
    /^[0-9a-fA-F]{1,4}$/u.test(group) ? Number.parseInt(group, 16) : undefined;

/** Converts one side of an IPv6 address to 16-bit groups, expanding a trailing dotted quad. */
const toIpv6Groups = (segment: string): readonly number[] | undefined => {
    if (segment === '') return [];

    const parts = segment.split(':');
    const last = parts[parts.length - 1] ?? '';

    if (!last.includes('.')) {
        const groups = parts.map(parseHexGroup).filter((g): g is number => g !== undefined);

        return groups.length === parts.length ? groups : undefined;
    }

    const embedded = parseIpv4(last);
    if (embedded === undefined) return undefined;

    const head = parts
        .slice(0, -1)
        .map(parseHexGroup)
        .filter((g): g is number => g !== undefined);
    if (head.length !== parts.length - 1) return undefined;

    return [...head, Math.floor(embedded / 0x1_00_00), embedded % 0x1_00_00];
};

const parseIpv6 = (raw: string): readonly number[] | undefined => {
    const sections = raw.split('::');
    if (sections.length > 2) return undefined;

    const head = toIpv6Groups(sections[0] ?? '');
    if (head === undefined) return undefined;

    if (sections.length === 1) return head.length === 8 ? head : undefined;

    const tail = toIpv6Groups(sections[1] ?? '');
    if (tail === undefined || head.length + tail.length > 7) return undefined;

    return [...head, ...Array.from({ length: 8 - head.length - tail.length }, () => 0), ...tail];
};

const findBlockedIpv6Label = (groups: readonly number[]): string | undefined => {
    const [first = 0, , , , fifth = 0, sixth = 0, seventh = 0, eighth = 0] = groups;

    // ::ffff:a.b.c.d — an IPv4 address wearing an IPv6 coat. Unwrap it and judge the real address.
    const isIpv4Mapped = groups.slice(0, 5).every((group) => group === 0) && sixth === 0xff_ff;
    if (isIpv4Mapped) return findBlockedIpv4Label(seventh * 0x1_00_00 + eighth);

    if (groups.every((group) => group === 0)) return 'reserved (unspecified)';
    if (groups.slice(0, 7).every((group) => group === 0) && eighth === 1) return 'loopback';
    if ((first & 0xfe_00) === 0xfc_00) return 'private (unique local)';
    if ((first & 0xff_c0) === 0xfe_80) return 'link-local';
    if (first === 0x00_64 && fifth === 0) return undefined;

    return undefined;
};

/**
 * The post-resolution / post-redirect check. Takes a bare address, not a URL, because by this point
 * the hostname has already been resolved and the hostname is no longer the thing that matters.
 */
export const isBlockedIpAddress = (address: string): boolean => {
    const ipv4 = parseIpv4(address);
    if (ipv4 !== undefined) return findBlockedIpv4Label(ipv4) !== undefined;

    const ipv6 = parseIpv6(address.replace(/^\[|\]$/gu, ''));
    if (ipv6 !== undefined) return findBlockedIpv6Label(ipv6) !== undefined;

    return false;
};

const findBlockedHostLabel = (hostname: string): string | undefined => {
    const bare = hostname.replace(/^\[|\]$/gu, '');

    const ipv4 = parseIpv4(bare);
    if (ipv4 !== undefined) return findBlockedIpv4Label(ipv4);

    const ipv6 = parseIpv6(bare);
    if (ipv6 !== undefined) return findBlockedIpv6Label(ipv6);

    return undefined;
};

/**
 * Normalization drops what the server never sees or never varies on: the fragment, a default port,
 * host casing, and credentials. It deliberately does NOT reorder or strip query parameters — two
 * URLs differing only in query are genuinely different pages to scan.
 */
const normalize = (url: URL): string => `${url.protocol}//${url.host}${url.pathname}${url.search}`;

export const validateSubmittedUrl = (rawUrl: string): TargetValidation => {
    const parsed = parseUrl(rawUrl);

    if (parsed === undefined) {
        return { kind: 'invalid', reason: `could not parse "${rawUrl}" as a URL` };
    }

    if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
        return {
            kind: 'invalid',
            reason: `unsupported scheme "${parsed.protocol}" — only http and https are scannable`,
        };
    }

    if (parsed.username !== '' || parsed.password !== '') {
        return { kind: 'invalid', reason: 'credentials in the URL are not accepted' };
    }

    const blockedLabel = findBlockedHostLabel(parsed.hostname);
    if (blockedLabel !== undefined) {
        return {
            kind: 'invalid',
            reason: `refusing to scan a ${blockedLabel} address (${parsed.hostname})`,
        };
    }

    return { domain: parsed.hostname, kind: 'valid', normalizedUrl: normalize(parsed) };
};

/**
 * Submitted URLs routinely carry session tokens, reset tokens and API keys in the query string.
 * Logging one verbatim turns our own logs into a credential store, so keys are kept (they are useful
 * for debugging) and values are not.
 */
export const redactUrl = (rawUrl: string): string => {
    const parsed = parseUrl(rawUrl);
    if (parsed === undefined) return '[unparseable url]';

    const base = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    if (parsed.search === '') return base;

    const keys = [...parsed.searchParams.keys()].map((key) => `${key}=REDACTED`);

    return `${base}?${keys.join('&')}`;
};
