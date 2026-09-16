import express from 'express';
import type { Express } from 'express';

import type { Logger } from '../utils/logger';
import { createScansRouter } from './routes/scans.router';
import { requestContext } from './middleware/request-context.middleware';
import { createErrorHandler } from './middleware/error-handler.middleware';
import type { ScanRepositoryPort } from '../repositories/scan.repository.port';

/**
 * Assembles the app from already-constructed dependencies. It reads no config and builds nothing
 * itself, which is what lets a test swap the repository for a fake and exercise the identical wiring.
 */
export const createApp = ({
    repository,
    logger,
    apiKeysByHash,
    probeReadiness,
}: {
    repository: ScanRepositoryPort;
    logger: Logger;
    apiKeysByHash: ReadonlyMap<string, string>;
    probeReadiness: () => Promise<boolean>;
}): Express => {
    const app = express();

    // Bounded body size: an unbounded one is a trivial memory-exhaustion vector, and no legitimate
    // submission is anywhere near this.
    app.use(express.json({ limit: '16kb' }));
    app.use(requestContext);

    // Liveness: is the process up. Deliberately does NOT touch the database — if it did, a brief
    // database blip would make the orchestrator kill otherwise-healthy processes.
    app.get('/health', (_req, res) => {
        res.status(200).json({ status: 'ok' });
    });

    // Readiness: should this instance receive traffic. This one does touch the database.
    app.get('/ready', async (_req, res) => {
        const ready = await probeReadiness();

        res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not ready' });
    });

    app.use('/v1/scans', createScansRouter({ apiKeysByHash, logger, repository }));

    app.use((_req, res) => {
        res.status(404).json({ error: 'not found' });
    });

    app.use(createErrorHandler({ logger }));

    return app;
};
