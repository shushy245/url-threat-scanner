import type { RequestHandler } from 'express';

import { generateUniqueId } from '../../utils/id.utils';

const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Establishes the correlation id once, at the edge, so every log line for this request — and every
 * log line the worker later writes for the resulting scan — can be tied together.
 *
 * An inbound id is honoured so a trace that started in the sensor survives the hop.
 */
export const requestContext: RequestHandler = (req, res, next) => {
    const inbound = req.header(CORRELATION_HEADER);

    res.locals['correlationId'] = inbound !== undefined && inbound.length > 0 ? inbound : generateUniqueId('req');

    res.setHeader(CORRELATION_HEADER, String(res.locals['correlationId']));
    next();
};
