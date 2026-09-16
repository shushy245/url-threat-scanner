/**
 * What the middleware chain establishes before a handler runs.
 *
 * Carried on `res.locals` rather than bolted onto the Request type globally: a global augmentation
 * would claim every request has a clientId, including the ones that failed authentication.
 */
export type ApiLocals = {
    correlationId: string;
    clientId: string;
};

export type ValidatedLocals<TBody> = ApiLocals & { body: TBody };
