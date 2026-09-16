import { afterAll, beforeEach, describe, it } from 'vitest';

import { aPipelineDriver } from './pipeline.driver';

/**
 * THE BIG CIRCLE. Written first and left skipped while the inner circles are built — it is the
 * outermost scope this feature needs, and it stays red until submit, relay, consume and score all
 * exist and agree with each other.
 *
 * Unskip when src/checks/ lands. Everything below it in the suite is an inner circle of this test.
 */
const driver = aPipelineDriver();

describe('the scanning pipeline, end to end', () => {
    beforeEach(async () => driver.given.aCleanDatabase());
    afterAll(async () => driver.close());

    it.skip('carries a submitted url from pending through to a completed scan with check results', async () => {
        await driver.when.urlIsSubmitted('https://pipeline.example.com/a');
        await driver.when.theRelayDrains();
        await driver.when.theWorkerConsumes();

        await driver.assert.scanCompleted();
        await driver.assert.everyCheckRecordedExactlyOnce();
        await driver.assert.threatScoreWithinBounds();
    });

    it.skip('records one set of check results when the same event is delivered twice', async () => {
        await driver.when.urlIsSubmitted('https://redelivery.example.com/a');
        await driver.when.theRelayDrains();
        await driver.when.theWorkerConsumes();
        await driver.when.theWorkerConsumesTheSameEventAgain();

        await driver.assert.everyCheckRecordedExactlyOnce();
    });
});
