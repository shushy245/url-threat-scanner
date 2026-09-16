import { Router } from 'express';

import type { Logger } from '../../utils/logger';
import { createGetScanHandler } from '../handlers/get-scan.handler';
import { authenticate } from '../middleware/authenticate.middleware';
import { validateBody } from '../middleware/validate-body.middleware';
import { createSubmitScanHandler } from '../handlers/submit-scan.handler';
import { submitScanBodySchema } from '../handlers/submit-scan.handler.utils';
import type { ScanRepositoryPort } from '../../repositories/scan.repository.port';

export const createScansRouter = ({
    repository,
    logger,
    apiKeysByHash,
}: {
    repository: ScanRepositoryPort;
    logger: Logger;
    apiKeysByHash: ReadonlyMap<string, string>;
}): Router => {
    const router = Router();

    router.use(authenticate({ apiKeysByHash }));

    router.post('/', validateBody(submitScanBodySchema), createSubmitScanHandler({ logger, repository }));
    router.get('/:id', createGetScanHandler({ logger, repository }));

    return router;
};
