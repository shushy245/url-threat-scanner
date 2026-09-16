import type { RequestHandler } from 'express';

import type { ApiLocals } from '../api-context';
import type { Logger } from '../../utils/logger';
import { toScanResponse } from './scan.response';
import type { ScanResponse } from './scan.response';
import type { ScanRepositoryPort } from '../../repositories/scan.repository.port';

type GetScanHandler = RequestHandler<
    { id: string },
    ScanResponse | { error: string },
    unknown,
    Record<string, string>,
    ApiLocals
>;

export const createGetScanHandler =
    ({ repository, logger }: { repository: ScanRepositoryPort; logger: Logger }): GetScanHandler =>
    async (req, res) => {
        const scan = await repository.findById(req.params.id);

        // A missing resource is 404, never 500 and never an empty 200 — the status code is part of
        // the contract, and a wrong one is a lie the client's monitoring will believe.
        if (scan === undefined) {
            res.status(404).json({ error: `no scan with id ${req.params.id}` });

            return;
        }

        if (scan.clientId !== res.locals.clientId) {
            logger.warn(
                { clientId: res.locals.clientId, correlationId: res.locals.correlationId, scanId: scan.id },
                'getScan: client requested a scan belonging to another client',
            );
            // Deliberately 404, not 403: confirming the id exists would leak another client's data.
            res.status(404).json({ error: `no scan with id ${req.params.id}` });

            return;
        }

        res.status(200).json(toScanResponse(scan));
    };
