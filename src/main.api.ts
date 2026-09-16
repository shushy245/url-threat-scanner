import { sql } from 'drizzle-orm';

import { loadConfig } from './config';
import { createApp } from './api/create-app';
import { createDatabase } from './db/client';
import { createLogger } from './utils/logger';
import { createScanRepository } from './repositories/scan.repository';

/**
 * Composition root for the API process. The only place config is read and dependencies constructed.
 */
const main = (): void => {
    const config = loadConfig();
    const logger = createLogger({ level: config.LOG_LEVEL, service: 'api' });
    const { db, pool } = createDatabase({ connectionString: config.DATABASE_URL });

    const app = createApp({
        apiKeysByHash: config.apiKeysByHash,
        logger,
        probeReadiness: async () => {
            try {
                await db.execute(sql`select 1`);

                return true;
            } catch (error) {
                logger.error({ err: error }, 'probeReadiness: database unreachable');

                return false;
            }
        },
        repository: createScanRepository({ db }),
    });

    const server = app.listen(config.PORT, () => {
        logger.info({ checkMode: config.CHECK_MODE, port: config.PORT }, 'api: listening');
    });

    const shutdown = (signal: string): void => {
        logger.info({ signal }, 'api: shutting down');
        server.close(() => {
            void pool.end().then(() => {
                process.exit(0);
            });
        });
    };

    process.on('SIGTERM', () => {
        shutdown('SIGTERM');
    });
    process.on('SIGINT', () => {
        shutdown('SIGINT');
    });
};

main();
