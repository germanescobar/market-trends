/**
 * Provider errors shared between the server's providers and services.
 *
 * Why these live in the shared package: the `BackfillService` needs to
 * distinguish a transient rate-limit response (HTTP 429) from a permanent
 * error (bad symbol, no data, etc.) so it can apply a longer backoff.
 * Each provider throws a plain `Error` with a status code in the message
 * — we don't want the services parsing message strings.
 *
 * Providers should throw the most specific subclass that fits:
 * - `RateLimitError` for HTTP 429 (or any "try again later" signal).
 * - `ProviderError` for any other failure mode.
 */

export class ProviderError extends Error {
  /** Provider name (e.g. "yahoo"). Subclasses may set this. */
  readonly provider: string;
  /** Ticker that triggered the error, when known. */
  readonly ticker?: string;

  constructor(message: string, options: { provider: string; ticker?: string } = { provider: "unknown" }) {
    super(message);
    this.name = "ProviderError";
    this.provider = options.provider;
    this.ticker = options.ticker;
  }
}

/** Thrown when the provider signals rate limiting (HTTP 429, or a
 *  provider-specific equivalent). Services catch this to apply a
 *  cooldown so we stop hammering a throttled endpoint. */
export class RateLimitError extends ProviderError {
  constructor(message: string, options: { provider: string; ticker?: string }) {
    super(message, options);
    this.name = "RateLimitError";
  }

  /** Returns true if the given error is a `RateLimitError`. Safe to
   *  call on non-Error values; returns false in that case. */
  static is(value: unknown): value is RateLimitError {
    return value instanceof RateLimitError;
  }
}
