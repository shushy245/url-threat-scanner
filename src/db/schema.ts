import { relations, sql } from 'drizzle-orm';
import { index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

import { CheckId, CheckOutcome, ScanStatus, Verdict } from '../domain/scan/model';

export const scanStatusEnum = pgEnum('scan_status', ['pending', 'in_progress', 'completed', 'failed']);

export const checkOutcomeEnum = pgEnum('check_outcome', ['pass', 'warn', 'fail', 'error']);

export const verdictEnum = pgEnum('verdict', ['clean', 'suspicious', 'malicious', 'unknown']);

export const checkIdEnum = pgEnum('check_id', ['domain_age', 'ssl_certificate', 'redirect_chain']);

export const scanTable = pgTable(
    'scan',
    {
        id: text('id').primaryKey(),
        clientId: text('client_id').notNull(),

        url: text('url').notNull(),
        normalizedUrl: text('normalized_url').notNull(),
        domain: text('domain').notNull(),

        status: scanStatusEnum('status').$type<ScanStatus>().notNull().default(ScanStatus.Pending),
        threatScore: integer('threat_score'),
        verdict: verdictEnum('verdict').$type<Verdict>(),
        error: text('error'),

        // Idempotency-Key support (ADR-0003). requestHash detects the dangerous case: the same key
        // replayed with a DIFFERENT body, which must 409 rather than silently return the first scan.
        idempotencyKey: text('idempotency_key'),
        requestHash: text('request_hash'),

        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
        startedAt: timestamp('started_at', { withTimezone: true }),
        completedAt: timestamp('completed_at', { withTimezone: true }),
    },
    (table) => [
        // Partial unique: rows without a key must not collide with each other. Postgres treats NULLs
        // as distinct anyway, but saying so explicitly documents the intent.
        uniqueIndex('scan_client_idempotency_key_uq')
            .on(table.clientId, table.idempotencyKey)
            .where(sql`${table.idempotencyKey} is not null`),
        // Drives the list endpoint's filters; id is time-sortable so it doubles as the keyset cursor.
        index('scan_status_id_idx').on(table.status, table.id),
        index('scan_domain_idx').on(table.domain),
    ],
);

export const scanCheckTable = pgTable(
    'scan_check',
    {
        id: text('id').primaryKey(),
        scanId: text('scan_id')
            .notNull()
            .references(() => scanTable.id, { onDelete: 'cascade' }),

        checkId: checkIdEnum('check_id').$type<CheckId>().notNull(),
        outcome: checkOutcomeEnum('outcome').$type<CheckOutcome>().notNull(),
        score: integer('score').notNull(),
        details: jsonb('details').$type<Record<string, unknown>>().notNull().default({}),
        durationMs: integer('duration_ms').notNull(),

        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => [
        // Defence in depth for consumer idempotency (ADR-0001): even if a redelivery slipped past the
        // compare-and-swap claim, the database still refuses a second result row for the same check.
        uniqueIndex('scan_check_scan_check_uq').on(table.scanId, table.checkId),
        index('scan_check_scan_idx').on(table.scanId),
    ],
);

export const outboxEventTable = pgTable(
    'outbox_event',
    {
        id: text('id').primaryKey(),
        aggregateType: text('aggregate_type').notNull(),
        aggregateId: text('aggregate_id').notNull(),
        eventType: text('event_type').notNull(),
        eventVersion: integer('event_version').notNull(),
        payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),

        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        publishedAt: timestamp('published_at', { withTimezone: true }),
    },
    (table) => [
        // Partial index: the relay only ever reads the unpublished tail, so the index stays small
        // no matter how large the published history grows.
        index('outbox_unpublished_idx')
            .on(table.id)
            .where(sql`${table.publishedAt} is null`),
    ],
);

export const dlqEventTable = pgTable('dlq_event', {
    id: text('id').primaryKey(),
    queue: text('queue').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    lastError: text('last_error').notNull(),
    redeliveryCount: integer('redelivery_count').notNull(),

    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    // Manual, deliberate replay only — automatic replay just refills the DLQ.
    replayedAt: timestamp('replayed_at', { withTimezone: true }),
});

export const scanRelations = relations(scanTable, ({ many }) => ({
    checks: many(scanCheckTable),
}));

export const scanCheckRelations = relations(scanCheckTable, ({ one }) => ({
    scan: one(scanTable, { fields: [scanCheckTable.scanId], references: [scanTable.id] }),
}));
