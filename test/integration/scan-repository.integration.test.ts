import { afterAll, beforeEach, describe, it } from 'vitest';

import { aSubmitScanInput } from '../builders/scan.builder';
import { createTestDatabase } from '../support/test-database';
import { aScanRepositoryDriver } from './scan-repository.driver';

const context: {
    database?: Awaited<ReturnType<typeof createTestDatabase>>;
    driver?: ReturnType<typeof aScanRepositoryDriver>;
} = {};

const driver = (): ReturnType<typeof aScanRepositoryDriver> => {
    if (context.driver === undefined) throw new Error('driver not initialised');

    return context.driver;
};

// One pool for the file: closing it inside a describe would tear it down before the next suite ran.
afterAll(async () => {
    await context.database?.close();
});

describe('ScanRepository — submission', () => {
    beforeEach(async () => {
        context.database ??= await createTestDatabase();
        await context.database.truncate();
        context.driver = aScanRepositoryDriver({ db: context.database.db });
    });

    it('writes the scan and its outbox event in a single transaction', async () => {
        await driver().when.submitted(aSubmitScanInput().build());

        driver().assert.resultWas('created');
        await driver().assert.scanRowCountIs(1);
        await driver().assert.outboxRowCountIs(1);
        await driver().assert.scanAndOutboxShareATransaction();
    });

    it('replays the original scan when the same idempotency key is reused with the same body', async () => {
        const first = aSubmitScanInput().withIdempotencyKey('key-1').withRequestHash('hash-1');

        await driver().when.submitted(first.build());
        await driver().when.submitted(first.withId('scan_second_attempt').build());

        driver().assert.resultWas('replayed');
        driver().assert.returnedTheSameScanIdBothTimes();
        await driver().assert.scanRowCountIs(1);
        await driver().assert.outboxRowCountIs(1);
    });

    it('reports a conflict when the same idempotency key arrives with a different body', async () => {
        const base = aSubmitScanInput().withIdempotencyKey('key-2');

        await driver().when.submitted(base.withRequestHash('hash-a').build());
        await driver().when.submitted(base.withRequestHash('hash-b').withId('scan_different_body').build());

        driver().assert.resultWas('conflict');
        await driver().assert.scanRowCountIs(1);
    });

    // The case a read-then-write cannot pass: both submissions see "no existing scan" before either
    // commits, so only the unique index can arbitrate.
    it('creates exactly one scan when two identical submissions race', async () => {
        const base = aSubmitScanInput().withIdempotencyKey('key-race').withRequestHash('hash-race');

        await driver().when.submittedConcurrently([
            base.withId('scan_racer_a').build(),
            base.withId('scan_racer_b').build(),
        ]);

        driver().assert.everyResultKind(['created', 'replayed']);
        driver().assert.returnedTheSameScanIdBothTimes();
        await driver().assert.scanRowCountIs(1);
        await driver().assert.outboxRowCountIs(1);
    });
});

describe('ScanRepository — claiming work', () => {
    beforeEach(async () => {
        context.database ??= await createTestDatabase();
        await context.database.truncate();
        context.driver = aScanRepositoryDriver({ db: context.database.db });
    });

    it('claims a pending scan', async () => {
        const input = aSubmitScanInput().withId('scan_claimable').build();
        await driver().when.submitted(input);

        await driver().when.claimed(input.id);

        driver().assert.claimSucceeded();
    });

    // The idempotency guarantee, at the unit level: a redelivered event finds the scan no longer
    // pending and changes nothing.
    it('reports already-handled on a second claim rather than doing the work twice', async () => {
        const input = aSubmitScanInput().withId('scan_twice').build();
        await driver().when.submitted(input);

        await driver().when.claimed(input.id);
        await driver().when.claimed(input.id);

        driver().assert.claimReportedAlreadyHandled();
    });

    // The ambiguity the ClaimResult union exists to remove: zero rows changed is NOT the same as
    // already handled, and treating it as such would silently discard real work.
    it('distinguishes a missing scan from an already-handled one', async () => {
        await driver().when.claimed('scan_never_existed');

        driver().assert.claimReportedMissing();
    });
});
