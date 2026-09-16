import { createHash } from 'node:crypto';
import type { RequestHandler } from 'express';

const API_KEY_HEADER = 'x-api-key';

const sha256Hex = (value: string): string => createHash('sha256').update(value).digest('hex');

/**
 * API-key auth (ADR-0004). Keys are stored hashed and looked up hashed, so neither the config nor a
 * leaked log ever yields a usable key. The resolved clientId is what every downstream log line and
 * scan row is attributed to.
 *
 * The lookup is a plain map get rather than a constant-time comparison loop, and that is deliberate:
 * timing-safe comparison matters when comparing a secret to a secret. Here we compare SHA-256
 * digests, and an attacker cannot steer a digest toward a stored value without already knowing the
 * preimage — which is the key itself. A map get is O(1) and leaks nothing they could use.
 */
export const authenticate =
    ({ apiKeysByHash }: { apiKeysByHash: ReadonlyMap<string, string> }): RequestHandler =>
    (req, res, next) => {
        const presented = req.header(API_KEY_HEADER);

        if (presented === undefined || presented.length === 0) {
            res.status(401).json({ error: 'missing x-api-key header' });

            return;
        }

        const clientId = apiKeysByHash.get(sha256Hex(presented));

        if (clientId === undefined) {
            res.status(401).json({ error: 'invalid api key' });

            return;
        }

        res.locals['clientId'] = clientId;
        next();
    };
