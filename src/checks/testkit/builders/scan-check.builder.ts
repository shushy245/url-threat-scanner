import type { ScanCheckModel } from '../../../domain/scan/model';
import { CheckId, CheckOutcome } from '../../../domain/scan/model';

class ScanCheckBuilder {
    private state: ScanCheckModel = {
        checkId: CheckId.DomainAge,
        details: {},
        durationMs: 1,
        outcome: CheckOutcome.Pass,
        score: 0,
    };

    // Every with* reassigns to a FRESH object rather than mutating in place: build() hands `state`
    // out by reference, so an in-place write would silently rewrite an object already built — a
    // flaky test nowhere near the builder.
    withCheckId(checkId: CheckId): this {
        this.state = { ...this.state, checkId };

        return this;
    }

    withOutcome(outcome: CheckOutcome): this {
        this.state = { ...this.state, outcome };

        return this;
    }

    withScore(score: number): this {
        this.state = { ...this.state, score };

        return this;
    }

    withDurationMs(durationMs: number): this {
        this.state = { ...this.state, durationMs };

        return this;
    }

    withDetails(details: Record<string, unknown>): this {
        this.state = { ...this.state, details };

        return this;
    }

    /** An errored check carries no signal — score 0 is an absence, not a pass. */
    asErrored(): this {
        this.state = { ...this.state, outcome: CheckOutcome.Error, score: 0 };

        return this;
    }

    build(): ScanCheckModel {
        return this.state;
    }
}

export const aScanCheck = (): ScanCheckBuilder => new ScanCheckBuilder();
