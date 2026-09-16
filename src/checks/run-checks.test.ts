import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import type { RunChecksDriver } from './run-checks.driver';
import { createRunChecksDriver } from './run-checks.driver';
import { CheckId, CheckOutcome } from '../domain/scan/model';

describe('runChecks — the happy path', () => {
    let driver: RunChecksDriver;

    beforeEach(() => {
        vi.useFakeTimers();
        driver = createRunChecksDriver();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('records one result per check, in the order the checks were registered', async () => {
        driver.given.passingCheck(CheckId.DomainAge);
        driver.given.passingCheck(CheckId.SslCertificate);

        await driver.when.run();

        driver.assert.recordedCheckIds([CheckId.DomainAge, CheckId.SslCertificate]);
        driver.assert.neverThrew();
    });

    it("carries each check's own outcome and severity through untouched", async () => {
        driver.given.checkReporting({ checkId: CheckId.DomainAge, outcome: CheckOutcome.Warn, score: 50 });

        await driver.when.run();

        driver.assert.outcomeFor({ checkId: CheckId.DomainAge, outcome: CheckOutcome.Warn });
        driver.assert.scoreFor({ checkId: CheckId.DomainAge, score: 50 });
        driver.assert.detailsFor({ checkId: CheckId.DomainAge, details: {} });
    });

    it('hands every check the target url and domain', async () => {
        driver.given.passingCheck(CheckId.DomainAge);
        driver.given.passingCheck(CheckId.SslCertificate);

        await driver.when.run();

        driver.assert.everyCheckSawTheTarget();
    });

    it('records nothing, and still does not throw, when there is nothing to run', async () => {
        await driver.when.run();

        driver.assert.recordedCheckIds([]);
        driver.assert.neverThrew();
    });

    it('measures duration from the injected clock, never the ambient one', async () => {
        driver.given.checkTakingClockTime({ checkId: CheckId.DomainAge, elapsesMs: 250 });

        await driver.when.run();

        driver.assert.durationFor({ checkId: CheckId.DomainAge, durationMs: 250 });
    });
});

describe('runChecks — a check that fails to run', () => {
    let driver: RunChecksDriver;

    beforeEach(() => {
        vi.useFakeTimers();
        driver = createRunChecksDriver();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('records a thrown check as an error carrying no severity, rather than letting it escape', async () => {
        driver.given.throwingCheck({ checkId: CheckId.DomainAge, message: 'whois refused the connection' });

        await driver.when.run();

        driver.assert.neverThrew();
        driver.assert.outcomeFor({ checkId: CheckId.DomainAge, outcome: CheckOutcome.Error });
        driver.assert.scoreFor({ checkId: CheckId.DomainAge, score: 0 });
        driver.assert.errorDetailMentions({ checkId: CheckId.DomainAge, fragment: 'whois refused the connection' });
    });

    it('still records every other check when one throws — an outage must not blackhole the scan', async () => {
        driver.given.throwingCheck({ checkId: CheckId.DomainAge, message: 'whois is down' });
        driver.given.checkReporting({ checkId: CheckId.SslCertificate, outcome: CheckOutcome.Fail, score: 100 });

        await driver.when.run();

        driver.assert.recordedCheckIds([CheckId.DomainAge, CheckId.SslCertificate]);
        driver.assert.outcomeFor({ checkId: CheckId.SslCertificate, outcome: CheckOutcome.Fail });
        driver.assert.scoreFor({ checkId: CheckId.SslCertificate, score: 100 });
    });
});

describe('runChecks — a check that overruns its timeout', () => {
    let driver: RunChecksDriver;

    beforeEach(() => {
        vi.useFakeTimers();
        driver = createRunChecksDriver();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('records the overrunning check as an error', async () => {
        driver.given.timeoutMs(1_000);
        driver.given.hangingCheck(CheckId.DomainAge);

        await driver.when.run();

        driver.assert.neverThrew();
        driver.assert.outcomeFor({ checkId: CheckId.DomainAge, outcome: CheckOutcome.Error });
        driver.assert.scoreFor({ checkId: CheckId.DomainAge, score: 0 });
    });

    it('actually aborts the underlying work — returning early would leave it running', async () => {
        driver.given.timeoutMs(1_000);
        driver.given.hangingCheck(CheckId.DomainAge);

        await driver.when.run();

        driver.assert.workWasAborted(CheckId.DomainAge);
        driver.assert.noTimersLeft();
    });

    it('lets the checks that answered in time report normally alongside the one that did not', async () => {
        driver.given.timeoutMs(1_000);
        driver.given.hangingCheck(CheckId.DomainAge);
        driver.given.checkReporting({ checkId: CheckId.SslCertificate, outcome: CheckOutcome.Pass, score: 0 });

        await driver.when.run();

        driver.assert.recordedCheckIds([CheckId.DomainAge, CheckId.SslCertificate]);
        driver.assert.outcomeFor({ checkId: CheckId.SslCertificate, outcome: CheckOutcome.Pass });
    });

    it('clears its timeout timer on the success path, so a fast scan leaves nothing holding the event loop open', async () => {
        driver.given.timeoutMs(30_000);
        driver.given.passingCheck(CheckId.DomainAge);

        await driver.when.run();

        driver.assert.noTimersLeft();
    });
});
