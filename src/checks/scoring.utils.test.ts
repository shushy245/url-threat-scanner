import { describe, expect, it } from 'vitest';

import { aScanCheck } from './testkit/builders/scan-check.builder';
import { CheckId, CheckOutcome, Verdict } from '../domain/scan/model';
import { checkWeightMap, scoreScan, verdictThresholds } from './scoring.utils';

const passing = (checkId: CheckId) =>
    aScanCheck().withCheckId(checkId).withOutcome(CheckOutcome.Pass).withScore(0).build();

const failing = (checkId: CheckId) =>
    aScanCheck().withCheckId(checkId).withOutcome(CheckOutcome.Fail).withScore(100).build();

const errored = (checkId: CheckId) => aScanCheck().withCheckId(checkId).asErrored().build();

const scoredAt = (score: number) => aScanCheck().withOutcome(CheckOutcome.Warn).withScore(score).build();

describe('scoreScan — the happy paths', () => {
    it('scores a scan whose every check passed at zero, and calls it clean', () => {
        const result = scoreScan([passing(CheckId.DomainAge), passing(CheckId.SslCertificate)]);

        expect(result).toEqual({ threatScore: 0, verdict: Verdict.Clean });
    });

    it('scores a scan whose every check failed at one hundred, and calls it malicious', () => {
        const result = scoreScan([failing(CheckId.DomainAge), failing(CheckId.SslCertificate)]);

        expect(result).toEqual({ threatScore: 100, verdict: Verdict.Malicious });
    });

    it('lets the heavier check move the score further than the lighter one', () => {
        const heavierFailed = scoreScan([failing(CheckId.DomainAge), passing(CheckId.SslCertificate)]);
        const lighterFailed = scoreScan([passing(CheckId.DomainAge), failing(CheckId.SslCertificate)]);

        expect(checkWeightMap[CheckId.DomainAge]).toBeGreaterThan(checkWeightMap[CheckId.SslCertificate]);
        expect(heavierFailed.threatScore).toBeGreaterThan(lighterFailed.threatScore);
    });

    it('keeps a weight in the table for every check id, so adding a check cannot silently unweight it', () => {
        expect(Object.keys(checkWeightMap).sort()).toEqual(Object.values(CheckId).sort());
    });
});

describe('scoreScan — the absence of signal', () => {
    it('excludes an errored check from the denominator rather than diluting a real failure with it', () => {
        const withOutage = scoreScan([failing(CheckId.DomainAge), errored(CheckId.SslCertificate)]);
        const alone = scoreScan([failing(CheckId.DomainAge)]);

        expect(withOutage.threatScore).toBe(alone.threatScore);
        expect(withOutage.threatScore).toBe(100);
    });

    it('reports unknown rather than clean when every check errored — "could not tell" is not "safe"', () => {
        const result = scoreScan([errored(CheckId.DomainAge), errored(CheckId.SslCertificate)]);

        expect(result).toEqual({ threatScore: 0, verdict: Verdict.Unknown });
    });

    it('never divides by an empty denominator: no checks at all still yields a number, not NaN', () => {
        const result = scoreScan([]);

        expect(Number.isNaN(result.threatScore)).toBe(false);
        expect(result).toEqual({ threatScore: 0, verdict: Verdict.Unknown });
    });
});

describe('scoreScan — the integer column contract', () => {
    it('rounds a weighted mean that does not divide evenly to a whole number', () => {
        const result = scoreScan([failing(CheckId.DomainAge), passing(CheckId.SslCertificate)]);

        expect(Number.isInteger(result.threatScore)).toBe(true);
    });

    it('clamps a check reporting above the scale down to one hundred', () => {
        expect(scoreScan([scoredAt(1_000)]).threatScore).toBe(100);
    });

    it('clamps a check reporting below the scale up to zero', () => {
        expect(scoreScan([scoredAt(-50)]).threatScore).toBe(0);
    });
});

describe('scoreScan — verdict boundaries', () => {
    it('calls one point below the suspicious threshold clean', () => {
        expect(scoreScan([scoredAt(verdictThresholds.suspicious - 1)]).verdict).toBe(Verdict.Clean);
    });

    it('calls exactly the suspicious threshold suspicious', () => {
        expect(scoreScan([scoredAt(verdictThresholds.suspicious)]).verdict).toBe(Verdict.Suspicious);
    });

    it('calls one point below the malicious threshold suspicious', () => {
        expect(scoreScan([scoredAt(verdictThresholds.malicious - 1)]).verdict).toBe(Verdict.Suspicious);
    });

    it('calls exactly the malicious threshold malicious', () => {
        expect(scoreScan([scoredAt(verdictThresholds.malicious)]).verdict).toBe(Verdict.Malicious);
    });
});
