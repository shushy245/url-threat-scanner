import type { Logger } from '../utils/logger';
import { runChecks } from '../checks/run-checks';
import type { Clock } from '../utils/clock.utils';
import { scoreScan } from '../checks/scoring.utils';
import type { SecurityCheck } from '../checks/check.port';
import type { ConsumerHandlerResult } from '../messaging/consumer';
import { scanRequestedPayloadSchema } from '../events/scan-requested.event';
import type { ScanRepositoryPort } from '../repositories/scan.repository.port';

/**
 * What the worker does with one ScanRequested event, extracted from the composition root so it can
 * be driven directly by a test without a broker in the loop.
 *
 * Never throws for an expected condition — it returns 'unprocessable' for anything a retry could not
 * fix, so the consumer dead-letters it rather than looping.
 */
export const createProcessScan =
    ({
        repository,
        checks,
        logger,
        clock,
        checkTimeoutMs,
    }: {
        repository: ScanRepositoryPort;
        checks: readonly SecurityCheck[];
        logger: Logger;
        clock: Clock;
        checkTimeoutMs: number;
    }) =>
    async ({ payload, correlationId }: { payload: unknown; correlationId: string }): Promise<ConsumerHandlerResult> => {
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
            // pending, so it changes nothing and the message is simply acked.
            logger.info({ ...ctx, status: claim.status }, 'processScan: already handled, dropping redelivery');

            return 'handled';
        }

        logger.info({ ...ctx, domain: claim.domain }, 'processScan: claimed, running checks');

        const results = await runChecks({
            checks,
            clock,
            domain: claim.domain,
            normalizedUrl: claim.normalizedUrl,
            timeoutMs: checkTimeoutMs,
        });

        const { threatScore, verdict } = scoreScan(results);

        logger.info(
            { ...ctx, checkCount: results.length, threatScore, verdict },
            'processScan: checks complete, writing results',
        );

        await repository.completeScan({ checks: results, scanId, threatScore, verdict });

        return 'handled';
    };
