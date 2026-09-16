import type { ConfirmChannel } from 'amqplib';

import { delay } from '../utils/delay.utils';
import type { Logger } from '../utils/logger';
import { publishConfirmed } from '../messaging/amqp';
import type { OutboxRepositoryPort } from './outbox.repository';
import { SCAN_REQUESTED_EVENT_TYPE } from '../events/scan-requested.event';
import { SCAN_EXCHANGE, SCAN_REQUESTED_ROUTING_KEY } from '../messaging/topology';

/**
 * Routing key per event type, as data. An unknown event type is a loud failure rather than a silent
 * drop — an event nobody routes is an event nobody processes, and that should never be quiet.
 */
const routingKeyByEventType: Record<string, string> = {
    [SCAN_REQUESTED_EVENT_TYPE]: SCAN_REQUESTED_ROUTING_KEY,
};

export type Relay = {
    readonly start: () => Promise<void>;
    readonly stop: () => void;
};

export const createRelay = ({
    outbox,
    channel,
    logger,
    pollIntervalMs,
    batchSize,
    publishTimeoutMs,
}: {
    outbox: OutboxRepositoryPort;
    channel: ConfirmChannel;
    logger: Logger;
    pollIntervalMs: number;
    batchSize: number;
    publishTimeoutMs: number;
}): Relay => {
    const state = { stopped: false };

    const runOnce = async (): Promise<number> =>
        outbox.drainAndPublish({
            batchSize,
            publish: async (event) => {
                const routingKey = routingKeyByEventType[event.eventType];

                if (routingKey === undefined) {
                    throw new Error(
                        `relay: no routing key configured for event type — eventId=${event.id}, eventType=${event.eventType}`,
                    );
                }

                logger.info(
                    {
                        aggregateId: event.aggregateId,
                        eventId: event.id,
                        eventType: event.eventType,
                        routingKey,
                    },
                    'relay: publishing outbox event',
                );

                await publishConfirmed({
                    body: {
                        aggregateId: event.aggregateId,
                        aggregateType: event.aggregateType,
                        eventId: event.id,
                        eventType: event.eventType,
                        eventVersion: event.eventVersion,
                        payload: event.payload,
                    },
                    channel,
                    exchange: SCAN_EXCHANGE,
                    headers: { 'x-event-id': event.id, 'x-event-type': event.eventType },
                    routingKey,
                    timeoutMs: publishTimeoutMs,
                });
            },
        });

    // One pass, extracted so the loop below stays two levels deep rather than three — each level of
    // nesting is one more thing the reader has to hold in their head.
    const tick = async (): Promise<void> => {
        try {
            const published = await runOnce();

            // A full batch means there is probably more waiting — drain hard before sleeping.
            if (published < batchSize) await delay(pollIntervalMs);
        } catch (error) {
            // The transaction rolled back, so nothing was marked published and the batch will be
            // retried. Sleeping avoids hammering a broker or database that is already unwell.
            logger.error({ err: error }, 'relay: drain failed, batch left unpublished for retry');
            await delay(pollIntervalMs);
        }
    };

    const start = async (): Promise<void> => {
        logger.info({ batchSize, pollIntervalMs }, 'relay: started');

        while (!state.stopped) await tick();

        logger.info('relay: stopped');
    };

    return {
        start,
        stop: () => {
            state.stopped = true;
        },
    };
};
