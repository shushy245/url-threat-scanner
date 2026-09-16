import { loadConfig } from './config';
import { createDatabase } from './db/client';
import { createRelay } from './outbox/relay';
import { createLogger } from './utils/logger';
import { connectAmqp, declareTopology } from './messaging/amqp';
import { createOutboxRepository } from './outbox/outbox.repository';
import {
    SCAN_DEAD_LETTER_EXCHANGE,
    SCAN_DEAD_ROUTING_KEY,
    SCAN_EXCHANGE,
    SCAN_REQUESTED_QUEUE,
    SCAN_REQUESTED_ROUTING_KEY,
} from './messaging/topology';

/**
 * Composition root for the relay process — the only thing that moves events from Postgres to
 * RabbitMQ (ADR-0001).
 *
 * Connection loss exits the process rather than reconnecting by hand. The supervisor (Docker's
 * restart policy, or a scheduler in production) already solves restart correctly, and a hand-rolled
 * reconnect loop is a second, worse implementation of it that has to be debugged separately.
 */
const main = async (): Promise<void> => {
    const config = loadConfig();
    const logger = createLogger({ level: config.LOG_LEVEL, service: 'relay' });
    const { db, pool } = createDatabase({ connectionString: config.DATABASE_URL });
    const connection = await connectAmqp({ url: config.RABBITMQ_URL });

    await declareTopology({
        channel: connection.channel,
        declaration: {
            // Dead-letter config is required by the type — this cannot compile without it.
            deadLetter: {
                exchange: SCAN_DEAD_LETTER_EXCHANGE,
                routingKey: SCAN_DEAD_ROUTING_KEY,
            },
            exchange: SCAN_EXCHANGE,
            queue: SCAN_REQUESTED_QUEUE,
            routingKey: SCAN_REQUESTED_ROUTING_KEY,
        },
    });

    const relay = createRelay({
        batchSize: config.OUTBOX_BATCH_SIZE,
        channel: connection.channel,
        logger,
        outbox: createOutboxRepository({ db }),
        pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
        publishTimeoutMs: config.CHECK_TIMEOUT_MS,
    });

    connection.onClose((reason) => {
        logger.error({ reason }, 'relay: broker connection lost, exiting for restart');
        relay.stop();
        process.exit(1);
    });

    const shutdown = (signal: string): void => {
        logger.info({ signal }, 'relay: shutting down');
        relay.stop();
        void connection
            .close()
            .then(async () => pool.end())
            .then(() => {
                process.exit(0);
            });
    };

    process.on('SIGTERM', () => {
        shutdown('SIGTERM');
    });
    process.on('SIGINT', () => {
        shutdown('SIGINT');
    });

    await relay.start();
};

main().catch((error: unknown) => {
    process.stderr.write(`relay: fatal — ${String(error)}\n`);
    process.exit(1);
});
