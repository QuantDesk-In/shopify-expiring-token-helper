/**
 * The shop's refresh token no longer works (expired, rotated by another
 * process, or the app was uninstalled). No retry fixes this. The merchant has
 * to open the app so the template can run token exchange again.
 */
export class ReauthRequiredError extends Error {
  readonly name = 'ReauthRequiredError';

  constructor(
    readonly shop: string,
    readonly responseBody?: unknown,
  ) {
    super(`Refresh token rejected for ${shop}; the merchant must reopen the app`);
  }
}

/** The shop has no offline session in storage. */
export class NoOfflineSessionError extends Error {
  readonly name = 'NoOfflineSessionError';

  constructor(readonly shop: string) {
    super(`No offline session stored for ${shop}`);
  }
}

/**
 * Any other token endpoint failure. status is 0 for a network error that
 * outlasted the retries. responseBody is Shopify's error JSON when present.
 */
export class TokenRequestError extends Error {
  readonly name = 'TokenRequestError';

  constructor(
    readonly shop: string,
    readonly kind: 'refresh' | 'migrate',
    readonly status: number,
    readonly responseBody?: unknown,
    options?: {cause?: unknown},
  ) {
    super(`Token ${kind} failed for ${shop} with status ${status}`, options);
  }
}

const NON_EXPIRING_REJECTED = 'Non-expiring access tokens are no longer accepted';

/**
 * True when an Admin API 403 is Shopify refusing a non-expiring token, as it
 * will from 1 April 2027. A missing access scope also returns 403, so the
 * status alone does not tell you which one you hit.
 */
export function isNonExpiringTokenRejection(status: number, body: unknown): boolean {
  if (status !== 403) return false;
  const text = typeof body === 'string' ? body : JSON.stringify(body ?? '');
  return text.includes(NON_EXPIRING_REJECTED);
}
