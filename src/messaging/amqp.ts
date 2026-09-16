import amqp from 'amqplib';
import type { ChannelModel, ConfirmChannel } from 'amqplib';

/**
 * The single wrapper around amqplib. Two things it exists to enforce:
 *
 * 1. Dead-letter configuration is REQUIRED by the options type, so a queue declared without it is a
 *    compile error rather than something a reviewer has to notice. A queue with no DLQ silently
 *    drops poison messages, which is the exact failure the type is here to prevent.
 * 2. Publishing goes through a confirm channel and awaits the broker's acknowledgement. amqplib's
 *    `publish` returning true means "the local buffer accepted it" — flow control, NOT delivery.
 *    Treating that boolean as success is how events get lost while every log line says fine.
 */

export type DeadLetterConfig = {
    readonly exchange: string;
    readonly routingKey: string;
};

export type QueueDeclaration = {
    readonly queue: string;
    readonly exchange: string;
    readonly routingKey: string;
    /** Required, deliberately. There is no overload of this type without it. */
    readonly deadLetter: DeadLetterConfig;
};

export type AmqpConnection = {
    readonly channel: ConfirmChannel;
    readonly close: () => Promise<void>;
    readonly onClose: (handler: (reason: unknown) => void) => void;
};

export const connectAmqp = async ({ url }: { url: string }): Promise<AmqpConnection> => {
    const connection: ChannelModel = await amqp.connect(url);
    const channel = await connection.createConfirmChannel();

    return {
        channel,
        close: async () => {
            await channel.close();
            await connection.close();
        },
        onClose: (handler) => {
            connection.on('close', handler);
            connection.on('error', handler);
        },
    };
};

export const declareTopology = async ({
    channel,
    declaration,
}: {
    channel: ConfirmChannel;
    declaration: QueueDeclaration;
}): Promise<void> => {
    await channel.assertExchange(declaration.exchange, 'topic', { durable: true });
    await channel.assertExchange(declaration.deadLetter.exchange, 'topic', { durable: true });

    await channel.assertQueue(declaration.queue, {
        arguments: {
            'x-dead-letter-exchange': declaration.deadLetter.exchange,
            'x-dead-letter-routing-key': declaration.deadLetter.routingKey,
        },
        durable: true,
    });

    await channel.bindQueue(declaration.queue, declaration.exchange, declaration.routingKey);
};

/**
 * Publishes and waits for the broker to confirm. Rejects if the broker nacks, if the channel dies,
 * or if the confirm does not arrive within the timeout — a hung broker must not hold the caller (and
 * in the relay's case, its database transaction) open indefinitely.
 */
export const publishConfirmed = async ({
    channel,
    exchange,
    routingKey,
    body,
    headers,
    timeoutMs,
}: {
    channel: ConfirmChannel;
    exchange: string;
    routingKey: string;
    body: unknown;
    headers: Record<string, string | number>;
    timeoutMs: number;
}): Promise<void> => {
    const confirmed = new Promise<void>((resolve, reject) => {
        channel.publish(
            exchange,
            routingKey,
            Buffer.from(JSON.stringify(body)),
            { contentType: 'application/json', headers, persistent: true },
            (error) => {
                // amqplib signals success with null; this wrapper is where that becomes undefined.
                const failure: unknown = error ?? undefined;

                if (failure === undefined) {
                    resolve();

                    return;
                }

                reject(failure instanceof Error ? failure : new Error(String(failure)));
            },
        );
    });

    const timedOut = new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(() => {
            reject(
                new Error(
                    `publishConfirmed: broker did not confirm within ${timeoutMs}ms — exchange=${exchange}, routingKey=${routingKey}`,
                ),
            );
        }, timeoutMs);

        // Never let the timer keep the process alive on its own.
        timer.unref();
    });

    await Promise.race([confirmed, timedOut]);
};
