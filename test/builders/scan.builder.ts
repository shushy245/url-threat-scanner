import { generateUniqueId } from '../../src/utils/id.utils';
import type { SubmitScanInput } from '../../src/repositories/scan.repository.port';

/**
 * Builder for submit inputs. `with*` reassigns to a fresh object rather than mutating in place —
 * build() hands `state` to the consumer, which aliases it, so an in-place mutation would silently
 * corrupt a previously-built object and surface as a flaky test nowhere near this file.
 */
class SubmitScanInputBuilder {
    private readonly state: SubmitScanInput;

    public constructor(state: SubmitScanInput) {
        this.state = state;
    }

    public withClientId(clientId: string): SubmitScanInputBuilder {
        return new SubmitScanInputBuilder({ ...this.state, clientId });
    }

    public withIdempotencyKey(idempotencyKey: string): SubmitScanInputBuilder {
        return new SubmitScanInputBuilder({ ...this.state, idempotencyKey });
    }

    public withRequestHash(requestHash: string): SubmitScanInputBuilder {
        return new SubmitScanInputBuilder({ ...this.state, requestHash });
    }

    public withUrl(url: string): SubmitScanInputBuilder {
        return new SubmitScanInputBuilder({
            ...this.state,
            normalizedUrl: url,
            url,
        });
    }

    public withId(id: string): SubmitScanInputBuilder {
        return new SubmitScanInputBuilder({ ...this.state, id });
    }

    public build(): SubmitScanInput {
        return this.state;
    }
}

export const aSubmitScanInput = (): SubmitScanInputBuilder =>
    new SubmitScanInputBuilder({
        clientId: 'test-client',
        domain: 'example.com',
        id: generateUniqueId('scan'),
        idempotencyKey: undefined,
        normalizedUrl: 'https://example.com/a',
        requestHash: 'hash-default',
        url: 'https://example.com/a',
    });
