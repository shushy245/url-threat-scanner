import type { ErrorRequestHandler } from 'express';

import type { Logger } from '../../utils/logger';

const isClientError = (error: unknown): error is Error & { status: number } => {
    if (!(error instanceof Error) || !('status' in error)) return false;

    return typeof error.status === 'number' && error.status >= 400 && error.status < 500;
};

/**
 * The last link in the chain. Express 5 forwards rejected promises here automatically, which is why
 * no handler needs an asyncHandler wrapper — the one that someone eventually forgets on one route.
 *
 * The client is told nothing but "internal error": an unhandled failure's message is as likely to
 * contain a connection string as anything useful. The detail goes to the log, with the correlation
 * id that ties it to the request.
 */
export const createErrorHandler =
    ({ logger }: { logger: Logger }): ErrorRequestHandler =>
    (error, req, res, _next) => {
        logger.error(
            {
                correlationId: res.locals['correlationId'],
                err: error,
                method: req.method,
                path: req.path,
            },
            'unhandledRequestError: request failed',
        );

        if (res.headersSent) return;

        // body-parser rejects malformed JSON and oversized payloads by throwing with a 4xx status.
        // Those are the client's fault and must not be reported as 500 — a wrong status code is a
        // lie the client's monitoring will believe.
        if (isClientError(error)) {
            res.status(error.status).json({ error: 'malformed request body' });

            return;
        }

        res.status(500).json({ error: 'internal error' });
    };
