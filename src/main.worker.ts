import { loadConfig } from './config';
import { createDatabase } from './db/client';
import { createLogger } from './utils/logger';
import { runChecks } from './checks/run-checks';
import { systemClock } from './utils/clock.utils';
import { scoreScan } from './checks/scoring.utils';
import { systemRandom } from './utils/random.utils';
import { startScanConsumer } from './messaging/consumer';
import { connectAmqp, declareTopology } from './messaging/amqp';
import { createScanRepository } from './repositories/scan.repository';
import { createSimulatedChecks } from './checks/create-simulated-checks';
import { scanRequestedPayloadSchema } from './events/scan-requested.event';
import {
    SCAN_DEAD_LETTER_EXCHANGE,
    SCAN_DEAD_ROUTING_KEY,
    SCAN_EXCHANGE,
    SCAN_REQUESTED_QUEUE,
    SCAN_REQUESTED_ROUTING_KEY,
} from './messaging/topology';

/**
 * Composition root for the worker process. Claims a scan, runs its checks, scores it, and writes the
 * whole result in one transaction.
 */
const main = async (): Promise<void> => {
    const config = loadConfig();
    const logger = createLogger({ level: config.LOG_LEVEL, service: 'worker' });

    if (config.CHECK_MODE === 'real') {
        // Fail at startup rather than silently falling back to simulated results. A scanner quietly
        // reporting made-up verdicts is the worst outcome available to this service.
        throw new Error(
            'main.worker: CHECK_MODE=real is not implemented — real RDAP and TLS adapters are the deferred phase in ADR-0005. Set CHECK_MODE=simulated.',
        );
    }

    const { db, pool } = createDatabase({ connectionString: config.DATABASE_URL });
    const repository = createScanRepository({ db });
    const checks = createSimulatedChecks({ clock: systemClock, random: systemRandom });
    const connection = await connectAmqp({ url: config.RABBITMQ_URL });

    await declareTopology({
        channel: connection.channel,
        declaration: {
            deadLetter: {
                exchange: SCAN_DEAD_LETTER_EXCHANGE,
                routingKey: SCAN_DEAD_ROUTING_KEY,
            },
            exchange: SCAN_EXCHANGE,
            queue: SCAN_REQUESTED_QUEUE,
            routingKey: SCAN_REQUESTED_ROUTING_KEY,
        },
    });

    await startScanConsumer({
        channel: connection.channel,
        handle: async ({ payload, correlationId }) => {
            const parsed = scanRequestedPayloadSchema.safeParse(payload);

            if (!parsed.success) {
                logger.error(
                    { correlationId, issues: parsed.error.issues },
                    'processScan: payload does not match ScanRequested v1, dead-lettering',
                );

                return 'unprocessable';
            }

            const { scanId, clientId } = parsed.data;
            const ctx = { clientId, correlationId, scanId };

            const claim = await repository.claimForProcessing(scanId);

            if (claim.kind === 'missing') {
                logger.error(ctx, 'processScan: no such scan, dead-lettering');

                return 'unprocessable';
            }

            if (claim.kind === 'already-handled') {
                // The idempotency guarantee doing its job: a redelivery finds the scan no longer
                // pending, so it changes nothing and the message is acked.
                logger.info({ ...ctx, status: claim.status }, 'processScan: already handled, dropping redelivery');

                return 'handled';
            }

            logger.info({ ...ctx, domain: claim.domain }, 'processScan: claimed, running checks');

            const results = await runChecks({
                checks,
                clock: systemClock,
                domain: claim.domain,
                normalizedUrl: claim.normalizedUrl,
                timeoutMs: config.CHECK_TIMEOUT_MS,
            });

            const { threatScore, verdict } = scoreScan(results);

            logger.info(
                { ...ctx, checkCount: results.length, threatScore, verdict },
                'processScan: checks complete, writing results',
            );

            await repository.completeScan({ checks: results, scanId, threatScore, verdict });

            return 'handled';
        },
        logger,
        prefetch: config.WORKER_PREFETCH,
    });

    connection.onClose((reason) => {
        logger.error({ reason }, 'worker: broker connection lost, exiting for restart');
        process.exit(1);
    });

    const shutdown = (signal: string): void => {
        logger.info({ signal }, 'worker: shutting down');
        // Closing the channel requeues anything in flight rather than losing it with the process.
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
};

main().catch((error: unknown) => {
    process.stderr.write(`worker: fatal — ${String(error)}\n`);
    process.exit(1);
});
