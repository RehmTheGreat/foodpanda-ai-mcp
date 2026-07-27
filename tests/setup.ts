import { beforeAll, afterAll } from 'vitest';

/**
 * The suite must be hermetic: it runs in CI with no network and must never
 * depend on foodpanda being up (or on this IP not being rate-limited).
 *
 * Any test that reaches the real network is a bug, so global fetch is replaced
 * with one that throws. Tests inject their own fetch stub into HttpClient.
 */
const realFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (async (input: any) => {
    throw new Error(
      `Test attempted a real network request to ${String(input)}. ` +
        'Tests must use recorded fixtures via the fetchImpl injection seam.',
    );
  }) as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = realFetch;
});
