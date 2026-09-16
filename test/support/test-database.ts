import path from 'node:path';
import { migrate } from 'drizzle-orm/node-postgres/migrator';

import type { Database } from '../../src/db/client';
import { createDatabase } from '../../src/db/client';

export const TEST_DATABASE_URL =
    process.env['TEST_DATABASE_URL'] ?? 'postgres://scanner:scanner@localhost:5433/scanner_test';

/**
 * The one place a real store runs. Integration tests share a single migrated database and truncate
 * between cases rather than recreating it — recreation is slow enough to discourage writing tests,
 * and a suite people avoid writing is worse than a shared schema.
 */
export const createTestDatabase = async (): Promise<{
    db: Database;
    truncate: () => Promise<void>;
    close: () => Promise<void>;
}> => {
    const { db, pool } = createDatabase({ connectionString: TEST_DATABASE_URL });

    await migrate(db, {
        migrationsFolder: path.join(__dirname, '..', '..', 'src', 'db', 'migrations'),
    });

    return {
        close: async () => pool.end(),
        db,
        truncate: async () => {
            await pool.query('truncate table scan_check, outbox_event, dlq_event, scan restart identity cascade');
        },
    };
};
