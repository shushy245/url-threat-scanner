import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import { createDatabase } from './client';
import { loadDatabaseConfig } from '../config';

/**
 * Forward-only migrations, run as a one-shot before any service starts (see docker-compose.yml).
 * Gating the app services on this completing is what stops `docker compose up` racing the schema.
 */
const run = async (): Promise<void> => {
    const config = loadDatabaseConfig();
    const { db, pool } = createDatabase({ connectionString: config.DATABASE_URL });

    try {
        await migrate(db, { migrationsFolder: path.join(__dirname, 'migrations') });
        process.stdout.write('migrate: schema up to date\n');
    } finally {
        await pool.end();
    }
};

run().catch((error: unknown) => {
    process.stderr.write(`migrate: failed — ${String(error)}\n`);
    process.exit(1);
});
