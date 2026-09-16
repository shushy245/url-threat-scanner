import { z } from 'zod';

/**
 * The producer/consumer contract, versioned and parsed on receive (ADR-0006).
 *
 * Deliberately NOT a shared TypeScript type: the API and the worker are separate deployables shipped
 * at different times, and a compile-time type is a promise nothing enforces across a version skew.
 * A parsed schema fails loudly, at the boundary, naming the field.
 *
 * The payload carries only what the consumer needs to start work. It does NOT carry scan state —
 * that is read from the database, so a redelivered event can never resurrect a stale view of it.
 */
export const SCAN_REQUESTED_EVENT_TYPE = 'ScanRequested';
export const SCAN_REQUESTED_EVENT_VERSION = 1;

export const scanRequestedPayloadSchema = z.object({
    scanId: z.string().min(1),
    clientId: z.string().min(1),
    normalizedUrl: z.string().min(1),
    domain: z.string().min(1),
});

export type ScanRequestedPayload = z.infer<typeof scanRequestedPayloadSchema>;
