/**
 * Wraps the one node-postgres detail we depend on, so the magic string lives in exactly one place.
 * 23505 is Postgres's unique_violation SQLSTATE.
 */
const UNIQUE_VIOLATION = '23505';

export const isUniqueViolation = ({ error, constraint }: { error: unknown; constraint: string }): boolean => {
    if (!(error instanceof Error)) return false;
    if (!('code' in error) || !('constraint' in error)) return false;

    return error.code === UNIQUE_VIOLATION && error.constraint === constraint;
};
