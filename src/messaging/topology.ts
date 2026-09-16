/**
 * Every exchange, queue and routing key in one place. Names are data, not string literals scattered
 * across producer and consumer where they can drift apart silently.
 */
export const SCAN_EXCHANGE = 'scan.events';
export const SCAN_DEAD_LETTER_EXCHANGE = 'scan.dlx';

export const SCAN_REQUESTED_ROUTING_KEY = 'scan.requested';
export const SCAN_REQUESTED_QUEUE = 'scan.requested';

export const SCAN_DEAD_QUEUE = 'scan.dead';
export const SCAN_DEAD_ROUTING_KEY = '#';
