import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { CheckId, CheckOutcome } from '../domain/scan/model';
import { simulatedDelayRange } from './create-simulated-checks';
import type { SimulatedChecksDriver } from './create-simulated-checks.driver';
import { createSimulatedChecksDriver } from './create-simulated-checks.driver';

describe('createSimulatedChecks', () => {
    let driver: SimulatedChecksDriver;

    beforeEach(() => {
        vi.useFakeTimers();
        driver = createSimulatedChecksDriver();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('registers exactly the two checks this phase ships — the redirect chain is a documented non-goal', () => {
        driver.when.created();

        driver.assert.checkIdsAre([CheckId.DomainAge, CheckId.SslCertificate]);
    });

    it('sleeps the minimum of the simulated range on the lowest possible roll', async () => {
        driver.given.rolls([0]);
        driver.when.started(CheckId.DomainAge);

        await driver.when.timePasses(simulatedDelayRange.minMs - 1);
        driver.assert.stillRunning();
    });

    it('sleeps no longer than the maximum of the simulated range on the highest roll', async () => {
        driver.given.rolls([0.999_999]);
        await driver.when.ranToCompletion(CheckId.DomainAge);

        driver.assert.outcomeIs(CheckOutcome.Fail);
    });

    it('passes on a low roll, and reports the finding as harmless', async () => {
        driver.given.rolls([0.5, 0.1]);
        await driver.when.ranToCompletion(CheckId.DomainAge);

        driver.assert.outcomeIs(CheckOutcome.Pass);
        driver.assert.scoreIs(0);
    });

    it('warns on a middling roll, and reports the finding as partial evidence', async () => {
        driver.given.rolls([0.5, 0.7]);
        await driver.when.ranToCompletion(CheckId.SslCertificate);

        driver.assert.outcomeIs(CheckOutcome.Warn);
        driver.assert.scoreIs(50);
    });

    it('fails on a high roll, and reports the finding at full severity', async () => {
        driver.given.rolls([0.5, 0.95]);
        await driver.when.ranToCompletion(CheckId.SslCertificate);

        driver.assert.outcomeIs(CheckOutcome.Fail);
        driver.assert.scoreIs(100);
    });

    it('reads the injected clock for the checked-at detail rather than the ambient one', async () => {
        driver.given.clockReading(1_764_000_000_000);
        await driver.when.ranToCompletion(CheckId.DomainAge);

        driver.assert.detailsRecordClockReading(1_764_000_000_000);
    });

    it('produces the same result twice from the same seed — the randomness is a dependency, not ambient', async () => {
        driver.given.seed(42);
        await driver.when.ranToCompletion(CheckId.DomainAge);

        driver.given.seed(42);
        await driver.when.ranAgainToCompletion(CheckId.DomainAge);

        driver.assert.bothRunsAgree();
    });

    it('stops sleeping the moment the signal aborts, leaving no timer behind to hold the event loop open', async () => {
        driver.given.rolls([1]);
        driver.when.started(CheckId.DomainAge);

        await driver.when.timePasses(100);
        await driver.when.aborted();

        driver.assert.rejected();
        driver.assert.noTimersLeft();
    });
});
