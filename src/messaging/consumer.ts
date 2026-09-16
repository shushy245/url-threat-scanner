import type { ConfirmChannel, ConsumeMessage } from 'amqplib';

import type { Logger } from '../utils/logger';
import { SCAN_REQUESTED_QUEUE } from './topology';
import { eventEnvelopeSchema } from '../events/envelope';

/**
 * How many times the broker has already dead-lettered this message. Read defensively: the header is
 * attacker-adjacent data from our own infrastructure's perspective and must not be trusted to have
 * any particular shape.
 */
const readRedeliveryCount = (message: ConsumeMessage): number => {
    const headers: Record<string, unknown> = message.properties.headers ?? {};
    const deaths: unknown = headers['x-death'];

    if (!Array.isArray(deaths)) return 0;

    const mostRecent: unknown = deaths[0];
    if (typeof mostRecent !== 'object') return 0;

    const fields: Record<string, unknown> = Object.fromEntries(Object.entries(mostRecent ?? {}));
    const count: unknown = fields['count'];

    return typeof count === 'number' ? count : 0;
};

export type ConsumerHandlerResult = 'handled' | 'unprocessable';

export const startScanConsumer = async ({
    channel,
    logger,
    prefetch,
    handle,
}: {
    channel: ConfirmChannel;
    logger: Logger;
    prefetch: number;
    handle: (args: { payload: unknown; correlationId: string }) => Promise<ConsumerHandlerResult>;
}): Promise<void> => {
    // Bounds how many scans one worker runs at once. Without it a single worker would pull the whole
    // queue into memory and run every check concurrently.
    await channel.prefetch(prefetch);

    const onMessage = async (message: ConsumeMessage): Promise<void> => {
        const redeliveryCount = readRedeliveryCount(message);
        const headers: Record<string, unknown> = message.properties.headers ?? {};
        const correlationId = String(headers['x-event-id'] ?? 'unknown');

        const envelope = eventEnvelopeSchema.safeParse(JSON.parse(message.content.toString('utf8')));

        if (!envelope.success) {
            logger.error({ correlationId, redeliveryCount }, 'scanConsumer: unparseable envelope, dead-lettering');
            channel.nack(message, false, false);

            return;
        }

        logger.info(
            {
                aggregateId: envelope.data.aggregateId,
                correlationId,
                eventType: envelope.data.eventType,
                eventVersion: envelope.data.eventVersion,
                redeliveryCount,
            },
            'scanConsumer: received',
        );

        try {
            const result = await handle({ correlationId, payload: envelope.data.payload });

            // 'unprocessable' means the message will never succeed however often it is retried —
            // requeueing it would loop forever, so it dead-letters immediately.
            if (result === 'unprocessable') {
                channel.nack(message, false, false);

                return;
            }

            channel.ack(message);
        } catch (error) {
            logger.error(
                { aggregateId: envelope.data.aggregateId, correlationId, err: error, redeliveryCount },
                'scanConsumer: handler failed, dead-lettering for manual replay',
            );
            channel.nack(message, false, false);
        }
    };

    await channel.consume(
        SCAN_REQUESTED_QUEUE,
        (message) => {
            const received = message ?? undefined;
            if (received === undefined) return;

            void onMessage(received);
        },
        { noAck: false },
    );

    logger.info({ prefetch, queue: SCAN_REQUESTED_QUEUE }, 'scanConsumer: consuming');
};
