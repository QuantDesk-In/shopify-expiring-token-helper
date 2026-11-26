// Calls Shopify's token endpoint for the two grants this package needs:
// refresh_token, and token exchange of a non-expiring offline token.
// https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange
// https://shopify.dev/docs/apps/build/authentication-authorization/migrate-to-expiring-offline-access-tokens

import {ReauthRequiredError, TokenRequestError} from './errors.js';

const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const OFFLINE_TOKEN_TYPE = 'urn:shopify:params:oauth:token-type:offline-access-token';

// Shopify sends the token request to the shop's own domain, so the shop value
// ends up in a URL. Only accept a plain myshopify.com host.
const SHOP_PATTERN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;

export interface TokenResponse {
  access_token: string;
  expires_in: number;
  refresh_token: string;
  refresh_token_expires_in?: number;
  scope?: string;
}

export interface TokenClientOptions {
  clientId: string;
  clientSecret: string;
  fetch: typeof fetch;
  /** Extra attempts after a network error, 429 or 5xx. */
  retries: number;
  retryDelayMs: number;
}

export function assertShop(shop: string): void {
  if (!SHOP_PATTERN.test(shop)) {
    throw new Error(`Invalid shop domain: ${shop}`);
  }
}

export function createTokenClient(options: TokenClientOptions) {
  async function post(
    shop: string,
    params: Record<string, string>,
    kind: 'refresh' | 'migrate',
  ): Promise<TokenResponse> {
    assertShop(shop);
    const body = new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      ...params,
    });

    // Shopify documents both grants as safe to retry with the same input after
    // a network error, timeout, 429 or 5xx. A 4xx is final.
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await options.fetch(`https://${shop}/admin/oauth/access_token`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
          },
          body,
        });
      } catch (cause) {
        if (attempt < options.retries) {
          await sleep(options.retryDelayMs * (attempt + 1));
          continue;
        }
        throw new TokenRequestError(shop, kind, 0, undefined, {cause});
      }

      const json = await response.json().catch(() => undefined);

      if (response.ok) return parseTokenResponse(shop, kind, json);

      const transient = response.status === 429 || response.status >= 500;
      if (transient && attempt < options.retries) {
        await sleep(options.retryDelayMs * (attempt + 1));
        continue;
      }

      // 401 invalid_request on refresh: the refresh token is expired, already
      // rotated or revoked. Only the merchant opening the app fixes this.
      if (kind === 'refresh' && response.status === 401) {
        throw new ReauthRequiredError(shop, json);
      }
      throw new TokenRequestError(shop, kind, response.status, json);
    }
  }

  return {
    refresh(shop: string, refreshToken: string) {
      return post(shop, {grant_type: 'refresh_token', refresh_token: refreshToken}, 'refresh');
    },

    migrate(shop: string, nonExpiringToken: string) {
      return post(
        shop,
        {
          grant_type: TOKEN_EXCHANGE_GRANT,
          subject_token: nonExpiringToken,
          subject_token_type: OFFLINE_TOKEN_TYPE,
          requested_token_type: OFFLINE_TOKEN_TYPE,
          expiring: '1',
        },
        'migrate',
      );
    },
  };
}

function parseTokenResponse(shop: string, kind: 'refresh' | 'migrate', json: unknown): TokenResponse {
  const body = json as Partial<TokenResponse> | undefined;
  if (
    typeof body?.access_token !== 'string' ||
    typeof body.refresh_token !== 'string' ||
    typeof body.expires_in !== 'number'
  ) {
    // A 200 without a refresh token means we did not get an expiring token.
    // Storing it would silently put the shop back on a token with no refresh path.
    throw new TokenRequestError(shop, kind, 200, json);
  }
  return body as TokenResponse;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
