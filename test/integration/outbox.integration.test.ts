import { afterAll, beforeEach, describe, it } from 'vitest';

import { anOutboxDriver } from './outbox.driver';
import { createTestDatabase } from '../support/test-database';

const context: {
    database?: Awaited<ReturnType<typeof createTestDatabase>>;
    driver?: ReturnType<typeof anOutboxDriver>;
} = {};

const driver = (): ReturnType<typeof anOutboxDriver> => {
    if (context.driver === undefined) throw new Error('driver not initialised');

    return context.driver;
};

afterAll(async () => {
    await context.database?.close();
});

describe('outbox relay drain', () => {
    beforeEach(async () => {
        context.database ??= await createTestDatabase();
        await context.database.truncate();
        context.driver = anOutboxDriver({ db: context.database.db });
    });

    it('publishes unpublished events and marks them published', async () => {
        await driver().given.unpublishedEvents(['obx_1', 'obx_2']);

        await driver().when.drainedSuccessfully();

        driver().assert.drainedCountWas(2);
        await driver().assert.rowsMarkedPublished(2);
    });

    // The pre-mortem's first bug: marking published before the broker confirms would lose the event
    // forever. The whole drain is one transaction, so a failed publish must roll the mark back.
    it('leaves events unpublished when the broker fails, so the next drain retries them', async () => {
        await driver().given.unpublishedEvents(['obx_1', 'obx_2']);

        await driver().when.drainedWithAFailingBroker();

        driver().assert.drainFailed();
        await driver().assert.rowsMarkedPublished(0);
    });

    it('publishes in id order, which is creation order', async () => {
        await driver().given.unpublishedEvents(['obx_3', 'obx_1', 'obx_2']);

        await driver().when.drainedSuccessfully();

        driver().assert.publishedIdsInOrder(['obx_1', 'obx_2', 'obx_3']);
    });

    it('reports nothing drained when the outbox is empty', async () => {
        await driver().when.drainedSuccessfully();

        driver().assert.drainedCountWas(0);
        await driver().assert.rowsMarkedPublished(0);
    });
});
