import { z } from 'zod';
import { createHash } from 'node:crypto';

import type { SubmitScanResult } from '../../repositories/scan.repository.port';

export const submitScanBodySchema = z.object({
    // 2048 is the conventional practical URL ceiling; rejecting longer input at the boundary keeps
    // an unbounded string out of the database and the logs.
    url: z.string().min(1).max(2048),
});

export type SubmitScanBody = z.infer<typeof submitScanBodySchema>;

export type ScanSubmissionResponse = {
    readonly id: string;
    readonly createdAt: string;
    readonly updatedAt: string;
};

/**
 * What an Idempotency-Key is a key FOR. Hashing the normalized URL rather than the raw one means a
 * retry that differs only in fragment or host casing is correctly recognised as the same request.
 */
export const buildRequestHash = ({ normalizedUrl }: { normalizedUrl: string }): string =>
    createHash('sha256').update(normalizedUrl).digest('hex');

/**
 * 201 for new work, 200 for a replay of a key we have already honoured, 409 for the same key with a
 * different body. A data table rather than a branch chain, and exhaustive over the result union.
 */
export const submitStatusCodeMap: Record<SubmitScanResult['kind'], number> = {
    conflict: 409,
    created: 201,
    replayed: 200,
};
