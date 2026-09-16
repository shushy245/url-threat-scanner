import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';

import * as schema from './schema';

export type Database = NodePgDatabase<typeof schema>;

/**
 * Built once per process in the composition root and closed over — never rebuilt per request.
 * Returns the pool alongside the client so shutdown can drain it.
 */
export const createDatabase = ({ connectionString }: { connectionString: string }): { db: Database; pool: Pool } => {
    const pool = new Pool({ connectionString });

    return { db: drizzle(pool, { schema }), pool };
};
