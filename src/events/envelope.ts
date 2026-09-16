import { z } from 'zod';

/**
 * The wire envelope every published event shares. Parsed on receive, never assumed.
 *
 * eventVersion travels with the message so a consumer meeting a version it does not understand can
 * say so precisely, at the boundary, instead of failing later on a missing field.
 */
export const eventEnvelopeSchema = z.object({
    eventId: z.string().min(1),
    eventType: z.string().min(1),
    eventVersion: z.number().int().positive(),
    aggregateId: z.string().min(1),
    aggregateType: z.string().min(1),
    payload: z.unknown(),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
