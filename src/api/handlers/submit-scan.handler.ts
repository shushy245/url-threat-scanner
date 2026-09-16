import type { RequestHandler } from 'express';

import type { Logger } from '../../utils/logger';
import type { ValidatedLocals } from '../api-context';
import { generateUniqueId } from '../../utils/id.utils';
import type { ScanRepositoryPort } from '../../repositories/scan.repository.port';
import { buildRequestHash, submitStatusCodeMap } from './submit-scan.handler.utils';
import { isValidTarget, redactUrl, validateSubmittedUrl } from '../../utils/url.utils';
import type { ScanSubmissionResponse, SubmitScanBody } from './submit-scan.handler.utils';

const IDEMPOTENCY_HEADER = 'idempotency-key';

type SubmitScanHandler = RequestHandler<
    Record<string, string>,
    ScanSubmissionResponse | { error: string },
    unknown,
    Record<string, string>,
    ValidatedLocals<SubmitScanBody>
>;

/**
 * The thin shell: guard, delegate, respond. Everything it decides is a lookup or a selector, and the
 * one write it performs is atomic with the event that triggers the pipeline.
 */
export const createSubmitScanHandler =
    ({ repository, logger }: { repository: ScanRepositoryPort; logger: Logger }): SubmitScanHandler =>
    async (req, res) => {
        const { body, clientId, correlationId } = res.locals;
        const ctx = { clientId, correlationId };

        const validation = validateSubmittedUrl(body.url);

        if (!isValidTarget(validation)) {
            logger.warn({ ...ctx, reason: validation.reason, url: redactUrl(body.url) }, 'submitScan: rejected target');
            res.status(400).json({ error: validation.reason });

            return;
        }

        const idempotencyKey = req.header(IDEMPOTENCY_HEADER);
        const scanId = generateUniqueId('scan');
        const scanCtx = { ...ctx, domain: validation.domain, scanId };

        logger.info(
            { ...scanCtx, hasIdempotencyKey: idempotencyKey !== undefined, url: redactUrl(body.url) },
            'submitScan: started',
        );

        const result = await repository.submit({
            clientId,
            domain: validation.domain,
            id: scanId,
            idempotencyKey,
            normalizedUrl: validation.normalizedUrl,
            requestHash: buildRequestHash({ normalizedUrl: validation.normalizedUrl }),
            url: body.url,
        });

        if (result.kind === 'conflict') {
            logger.warn({ ...scanCtx }, 'submitScan: idempotency key reused with a different body');
            res.status(submitStatusCodeMap.conflict).json({
                error: 'this Idempotency-Key was already used with a different request body',
            });

            return;
        }

        logger.info(
            { ...scanCtx, persistedScanId: result.scan.id },
            result.kind === 'created'
                ? 'submitScan: scan persisted and ScanRequested enqueued in one transaction'
                : 'submitScan: idempotent replay, returning the original scan',
        );

        res.status(submitStatusCodeMap[result.kind]).json({
            createdAt: result.scan.createdAt.toISOString(),
            id: result.scan.id,
            updatedAt: result.scan.updatedAt.toISOString(),
        });
    };
