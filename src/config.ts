import { z } from 'zod';

/**
 * The single place environment is read and validated. Every process builds its dependencies from
 * this in its composition root (`main.*.ts`); no module below reaches for `process.env` itself.
 *
 * Validation happens at startup on purpose: a missing DATABASE_URL should kill the process
 * immediately with a message naming the variable, not surface as a confusing connection error on
 * the first request an hour later.
 */
/**
 * Split deliberately. A single schema requiring every variable forces every process to satisfy every
 * other process's needs — the migration job would have to be handed broker credentials it never
 * uses, which is both a least-privilege violation and a startup failure waiting to happen.
 *
 * Each composition root validates exactly what it reads.
 */
const baseSchema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    DATABASE_URL: z.string().min(1),
});

const configSchema = baseSchema.extend({
    PORT: z.coerce.number().int().positive().default(3000),

    RABBITMQ_URL: z.string().min(1),

    // Which check implementations the composition root wires in — see ADR-0005.
    CHECK_MODE: z.enum(['simulated', 'real']).default('simulated'),
    CHECK_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),

    WORKER_PREFETCH: z.coerce.number().int().positive().default(10),
    MAX_REDELIVERIES: z.coerce.number().int().positive().default(10),

    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(250),
    OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().default(100),

    // `clientId:sha256(apiKey)` pairs, comma separated. Raw keys are never stored or logged.
    API_KEYS: z.string().default(''),
});

type RawConfig = z.infer<typeof configSchema>;

export type Config = Omit<RawConfig, 'API_KEYS'> & {
    /** sha256(apiKey) → clientId. Lookup is by hash, so a raw key never exists at rest. */
    readonly apiKeysByHash: ReadonlyMap<string, string>;
};

const parseApiKeys = (raw: string): ReadonlyMap<string, string> =>
    new Map(
        raw
            .split(',')
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
            .map((entry) => {
                const separatorIndex = entry.indexOf(':');
                if (separatorIndex === -1) {
                    throw new Error(
                        `loadConfig: malformed API_KEYS entry — expected "clientId:sha256Hash", found "${entry}"`,
                    );
                }

                return [entry.slice(separatorIndex + 1), entry.slice(0, separatorIndex)] as const;
            }),
    );

export type DatabaseConfig = z.infer<typeof baseSchema>;

const describeIssues = (issues: readonly z.ZodIssue[]): string =>
    issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');

/** For the migration job, which needs the database and nothing else. */
export const loadDatabaseConfig = (env: NodeJS.ProcessEnv = process.env): DatabaseConfig => {
    const parsed = baseSchema.safeParse(env);

    if (!parsed.success) {
        throw new Error(`loadDatabaseConfig: invalid environment — ${describeIssues(parsed.error.issues)}`);
    }

    return parsed.data;
};

export const loadConfig = (env: NodeJS.ProcessEnv = process.env): Config => {
    const parsed = configSchema.safeParse(env);

    if (!parsed.success) {
        const problems = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');

        throw new Error(`loadConfig: invalid environment — ${problems}`);
    }

    const { API_KEYS, ...rest } = parsed.data;

    return { ...rest, apiKeysByHash: parseApiKeys(API_KEYS) };
};
