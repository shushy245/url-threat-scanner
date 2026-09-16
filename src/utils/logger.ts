import { pino } from 'pino';
import type { Logger as PinoLogger } from 'pino';

export type Logger = PinoLogger;

/**
 * Built once per process and closed over — never rebuilt per request.
 *
 * `redact` is a safety net, not the primary defence: URLs are redacted explicitly via redactUrl
 * before they are ever logged. This catches the field someone forgets.
 */
export const createLogger = ({ level, service }: { level: string; service: string }): Logger =>
    pino({
        base: { service },
        level,
        redact: {
            censor: '[REDACTED]',
            paths: ['req.headers.authorization', 'req.headers["x-api-key"]', 'apiKey', 'password'],
        },
    });
