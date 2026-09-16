import type { ZodType } from 'zod';
import type { RequestHandler } from 'express';

/**
 * Validation happens here, never in a handler. The handler receives an already-parsed, typed body on
 * res.locals and never touches raw req.body — so invalid input cannot reach business logic at all,
 * rather than being rejected by a check someone remembered to write.
 */
export const validateBody =
    <TBody>(schema: ZodType<TBody>): RequestHandler =>
    (req, res, next) => {
        const parsed = schema.safeParse(req.body);

        if (!parsed.success) {
            const problems = parsed.error.issues
                .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
                .join('; ');

            res.status(400).json({ error: problems });

            return;
        }

        res.locals['body'] = parsed.data;
        next();
    };
