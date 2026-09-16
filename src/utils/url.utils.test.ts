import { describe, expect, it } from 'vitest';

import { isBlockedIpAddress, isValidTarget, redactUrl, validateSubmittedUrl } from './url.utils';

const reasonFor = (rawUrl: string): string => {
    const result = validateSubmittedUrl(rawUrl);

    return isValidTarget(result) ? 'UNEXPECTEDLY VALID' : result.reason;
};

describe('validateSubmittedUrl — scheme and shape', () => {
    it('accepts an ordinary https url', () => {
        const result = validateSubmittedUrl('https://example.com/login?next=/home');

        expect(isValidTarget(result) && result.domain).toBe('example.com');
    });

    it.each(['file:///etc/passwd', 'gopher://example.com', 'javascript:alert(1)', 'ftp://x.com'])(
        'rejects the non-http scheme %s',
        (rawUrl) => {
            expect(reasonFor(rawUrl)).toMatch(/scheme/iu);
        },
    );

    it('rejects credentials embedded in the url', () => {
        expect(reasonFor('https://admin:hunter2@example.com/')).toMatch(/credential/iu);
    });

    it('rejects a url that does not parse at all', () => {
        expect(reasonFor('not a url')).toMatch(/parse|invalid/iu);
    });
});

describe('validateSubmittedUrl — normalization', () => {
    it('lowercases the host and drops the default port', () => {
        const result = validateSubmittedUrl('HTTPS://ExAmPlE.CoM:443/Path');

        expect(isValidTarget(result) && result.normalizedUrl).toBe('https://example.com/Path');
    });

    it('drops the fragment, which is never sent to the server', () => {
        const result = validateSubmittedUrl('https://example.com/a#section');

        expect(isValidTarget(result) && result.normalizedUrl).toBe('https://example.com/a');
    });

    it('keeps a non-default port', () => {
        const result = validateSubmittedUrl('https://example.com:8443/a');

        expect(isValidTarget(result) && result.normalizedUrl).toBe('https://example.com:8443/a');
    });
});

describe('validateSubmittedUrl — SSRF literals', () => {
    it.each([
        'http://127.0.0.1/',
        'http://10.1.2.3/',
        'http://192.168.1.1/',
        'http://172.16.0.1/',
        'http://169.254.169.254/latest/meta-data/',
        'http://0.0.0.0/',
        'http://[::1]/',
        'http://[fd00::1]/',
        'http://[fe80::1]/',
    ])('rejects the private or loopback target %s', (rawUrl) => {
        expect(reasonFor(rawUrl)).toMatch(/private|loopback|reserved|link-local/iu);
    });

    // inet_aton accepts all of these as 127.0.0.1. A guard that only string-matches "127." misses
    // every one of them.
    it.each([
        'http://2130706433/',
        'http://0x7f000001/',
        'http://017700000001/',
        'http://127.1/',
        'http://0x7f.0.0.1/',
    ])('rejects the obfuscated loopback encoding %s', (rawUrl) => {
        expect(reasonFor(rawUrl)).toMatch(/private|loopback|reserved/iu);
    });

    it('rejects an IPv4-mapped IPv6 loopback address', () => {
        expect(reasonFor('http://[::ffff:127.0.0.1]/')).toMatch(/private|loopback|reserved/iu);
    });

    it('still accepts a public IP literal', () => {
        expect(isValidTarget(validateSubmittedUrl('http://8.8.8.8/'))).toBe(true);
    });
});

describe('isBlockedIpAddress — the post-DNS re-check', () => {
    it('blocks an address a public hostname resolved to (DNS rebinding)', () => {
        expect(isBlockedIpAddress('127.0.0.1')).toBe(true);
        expect(isBlockedIpAddress('169.254.169.254')).toBe(true);
    });

    it('allows a genuinely public address', () => {
        expect(isBlockedIpAddress('93.184.216.34')).toBe(false);
    });
});

describe('redactUrl', () => {
    it('keeps the query keys but removes their values, which may be session tokens', () => {
        expect(redactUrl('https://example.com/a?token=abc123&page=2')).toBe(
            'https://example.com/a?token=REDACTED&page=REDACTED',
        );
    });

    it('leaves a url without a query untouched', () => {
        expect(redactUrl('https://example.com/a')).toBe('https://example.com/a');
    });

    it('never throws on an unparseable url', () => {
        expect(redactUrl('not a url')).toBe('[unparseable url]');
    });
});
