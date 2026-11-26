# shopify-expiring-token-helper

Locked refresh and legacy-token migration for Shopify apps built on the React Router app template (`@shopify/shopify-app-react-router`).

Shopify is retiring non-expiring offline access tokens for public apps. Expiring offline tokens last about an hour and come with a refresh token that rotates on every refresh. The template already refreshes them. This package fixes the gaps that cause dead tokens in production: two processes refreshing the same shop at once, existing installs that never get migrated, and background jobs that start with a token about to expire.

## The dates

From Shopify's [changelog of 27 October 2026](https://shopify.dev/changelog/posts/migrate-to-expiring-offline-access-tokens-before-january-2027) and the [migration guide](https://shopify.dev/docs/apps/build/authentication-authorization/migrate-to-expiring-offline-access-tokens):

| Date | What happens |
| --- | --- |
| 1 April 2026 | Public apps created on or after this date must use expiring offline tokens. |
| 1 January 2027 | Public apps still on non-expiring tokens are delisted from the App Store and blocked from new installs. Existing installs keep working. |
| 15 January 2027 | Merchants using those apps see a warning in the Shopify admin. |
| 1 April 2027 | Admin API requests (GraphQL and REST) made with a non-expiring offline token return HTTP 403. |

Custom apps and merchant-created apps are excluded from the January deadline. The Payments Apps API is outside this timeline.

## What the template already does

With `future: {expiringOfflineAccessTokens: true}` set in `shopifyApp()`, the template (`@shopify/shopify-app-react-router` 4.x on `@shopify/shopify-api` 15.x) already handles this:

- New installs and token exchanges ask Shopify for an expiring token (`expiring=1`).
- `PrismaSessionStorage` stores `refreshToken` and `refreshTokenExpires`. The current template's Prisma `Session` model has both columns. Apps scaffolded before those columns existed need a migration that adds `refreshToken String?` and `refreshTokenExpires DateTime?`.
- Webhooks, `unauthenticated.admin`, Flow, fulfillment service and app proxy requests refresh the offline token when it has less than 5 minutes left.
- A refresh that fails with 401 `invalid_request` makes webhook authentication continue without a session instead of crashing.
- `@shopify/shopify-api` has `api.auth.migrateToExpiringToken()` for the legacy-token exchange.

What it does not do:

- **No lock.** Two requests for the same shop that arrive inside the 5 minute window both refresh. Shopify keeps only the newest refresh token for an app on a store, so one process ends up storing a pair that is already retired. The [token exchange docs](https://shopify.dev/docs/apps/build/authentication-authorization/implement-token-exchange) say to refresh one store at a time.
- **No migration of existing installs.** A session saved with a non-expiring token has no `expires` value, so `session.isActive()` stays true and the template never exchanges it. Turning the flag on only changes new tokens. Nothing in the template calls `migrateToExpiringToken`.
- **Embedded admin requests re-exchange instead of refreshing.** When the merchant has the app open and the token is within 5 minutes of expiry, `authenticate.admin` runs a fresh token exchange with the ID token. That also retires every other refresh token for the store, including one a background worker may be using at that moment.
- **No minimum validity for long jobs.** The 5 minute margin is fixed.

This package keeps the template's storage and adds a lock, a migration path, and a validity option on top.

## Install

```sh
npm install shopify-expiring-token-helper
```

Peer dependencies: `@shopify/shopify-api` 15.x and `@shopify/shopify-app-session-storage` 7.x. Both come with the React Router template. Node 20 or later.

## Usage

### Wire it into shopify.server.ts

Wrap the storage you already use and pass the wrapper to `shopifyApp()`. Keep the future flag on.

```ts
// app/shopify.server.ts
import {shopifyApp, AppDistribution, ApiVersion} from '@shopify/shopify-app-react-router/server';
import {PrismaSessionStorage} from '@shopify/shopify-app-session-storage-prisma';
import {createExpiringTokenHelper} from 'shopify-expiring-token-helper';
import prisma from './db.server';
import {postgresShopLock} from './shop-lock.server';

export const tokens = createExpiringTokenHelper({
  sessionStorage: new PrismaSessionStorage(prisma),
  clientId: process.env.SHOPIFY_API_KEY!,
  clientSecret: process.env.SHOPIFY_API_SECRET!,
  lock: postgresShopLock, // see "Running more than one process"
  onReauthRequired: (shop) => alertOps(`Refresh token dead for ${shop}`),
});

const shopify = shopifyApp({
  apiKey: process.env.SHOPIFY_API_KEY,
  apiSecretKey: process.env.SHOPIFY_API_SECRET || '',
  apiVersion: ApiVersion.October26,
  scopes: process.env.SCOPES?.split(','),
  appUrl: process.env.SHOPIFY_APP_URL || '',
  authPathPrefix: '/auth',
  sessionStorage: tokens.sessionStorage,
  distribution: AppDistribution.AppStore,
  future: {expiringOfflineAccessTokens: true},
});

export default shopify;
export const authenticate = shopify.authenticate;
export const unauthenticated = shopify.unauthenticated;
```

The wrapped `loadSession` refreshes an offline session under the shop lock when it has less than 10 minutes left. That is earlier than the template's 5 minute check, so by the time the template looks at the session it is fresh and the template does not start its own unlocked refresh or re-exchange. If the refresh fails, `loadSession` returns the stored session and the template falls back to what it does today.

### In a loader or action

Nothing changes. `authenticate.admin` loads the session through the wrapper.

```ts
// app/routes/app._index.tsx
import type {LoaderFunctionArgs} from 'react-router';
import {authenticate} from '../shopify.server';

export async function loader({request}: LoaderFunctionArgs) {
  const {admin} = await authenticate.admin(request);
  const res = await admin.graphql(`{ shop { name } }`);
  return (await res.json()).data.shop;
}
```

### In a background job

Pass the shop domain in the job payload, never the access token. Load the session when the job runs. If the job can run for a while, ask for a token that stays valid long enough.

```ts
import {ReauthRequiredError} from 'shopify-expiring-token-helper';
import {tokens, unauthenticated} from '~/shopify.server';

export async function syncProducts(shop: string) {
  try {
    // Refreshes now if less than 30 minutes are left.
    await tokens.getOfflineSession(shop, {minValidityMs: 30 * 60 * 1000});
  } catch (error) {
    if (error instanceof ReauthRequiredError) return markShopNeedsReauth(shop);
    throw error;
  }
  const {admin} = await unauthenticated.admin(shop);
  // ... GraphQL calls
}
```

`getOfflineSession` throws `ReauthRequiredError` when Shopify answers the refresh with 401. No retry fixes that. The merchant has to open the app, which runs token exchange again. It retries network errors, 429 and 5xx twice with the same refresh token, which Shopify documents as safe.

### Migrating existing installs

`migrateShop` exchanges the stored non-expiring token for an expiring pair and saves it. It runs under the same shop lock.

```ts
const result = await tokens.migrateShop('example.myshopify.com');
// {status: 'migrated', session} | {status: 'already-expiring', session} | {status: 'no-session'}
```

Things to know before you run it:

- Shopify invalidates the old token for Admin API calls as soon as the exchange succeeds. Any other system holding a copy of that token stops working for that shop.
- If the exchange succeeds but saving fails, the old token is still in storage. Run `migrateShop` again. Shopify returns the same pair when the exchange is repeated with the original token within 7 days.
- A 400 with `invalid_subject_token` throws `TokenRequestError` and leaves storage alone. Common causes: the app was uninstalled, or the stored token is not a non-expiring offline token.

## Rolling out shop by shop

Migrating every shop in one script is possible but leaves you with no way back if something you missed holds a copy of the token. A gradual rollout looks like this:

1. Ship the wrapper and the future flag first. New installs and merchants who open the app get expiring tokens. Watch for a few days.
2. Find every place that holds a token outside the session table: other services, cached clients, queue payloads, analytics exports. Make them read from the session table or ask the main app for a token.
3. Migrate a small batch of shops you know well, then larger batches. Run one shop at a time. Log the result of each call.
4. Shops that fail keep their non-expiring token, which keeps working until 1 April 2027. That is your fallback. Retry them, and contact the merchant if the token is already invalid.
5. Alert on two things: refresh 401s (`onReauthRequired`) and Admin API 403s where `isNonExpiringTokenRejection(status, body)` is true. A 403 can also mean a missing scope, so the helper checks Shopify's error message.
6. Confirm nothing is left. In the Dev Dashboard, open Logs, filter by GraphQL request (and REST request if you use it) and set Token type to "Offline, non-expiring".

```ts
for (const shop of batch) {
  try {
    const r = await tokens.migrateShop(shop);
    log.info({shop, status: r.status});
  } catch (error) {
    log.error({shop, error}); // the shop keeps its legacy token
  }
}
```

There is no per-shop rollback after a successful exchange. Rolling back your code is fine as long as you keep the future flag on and keep refreshing. If you turn the flag off, the template stops refreshing and its token exchange stops sending `expiring=1`, so migrated shops lose access within the hour unless the merchant opens the app.

## Dormant shops

A refresh token expires 90 days after it is issued. It also stops working 30 days after you first use it to refresh, or as soon as you use its replacement. A shop that nobody touches for 90 days needs the merchant to reopen the app. Run a weekly job that calls `getOfflineSession(shop)` for every installed shop. Any shop whose access token has expired will refresh and get a new 90 day refresh token.

## Running more than one process

The default lock lives in memory and only covers one Node process. If you run more than one web instance, or a separate worker that calls Shopify, the processes must share a lock. The test suite shows the difference: two helpers with their own in-memory locks refresh twice, two helpers sharing one lock refresh once.

With Postgres and Prisma, a transaction-scoped advisory lock works:

```ts
// app/shop-lock.server.ts
import type {ShopLock} from 'shopify-expiring-token-helper';
import prisma from './db.server';

export const postgresShopLock: ShopLock = {
  withLock: (shop, fn) =>
    prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${shop}))`;
        return fn();
      },
      {timeout: 30_000},
    ),
};
```

The lock is held by the transaction's connection, while `fn` reads and writes through the normal client, so the connection pool needs at least two connections. With Redis, any lock that has a timeout and releases on error will do. The helper always reloads the session after taking the lock, so a process that waited picks up the pair the other process just saved instead of refreshing again.

## API

- `createExpiringTokenHelper(options)` returns `{sessionStorage, getOfflineSession, migrateShop}`.
  - `sessionStorage`, `clientId`, `clientSecret`: required.
  - `lock`: a `ShopLock`. Defaults to `createInMemoryShopLock()`.
  - `refreshMarginMs`: default 10 minutes.
  - `onReauthRequired(shop, error)`: called when a refresh gets a 401.
  - `onRefreshError(shop, error)`: called when the wrapped `loadSession` could not refresh and returned the stored session.
  - `retries` (default 2), `retryDelayMs` (default 250), `fetch`.
- `getOfflineSession(shop, {minValidityMs?})`: capped at 45 minutes, since tokens last about an hour.
- `migrateShop(shop)`
- `isNonExpiringTokenRejection(status, body)`
- Errors: `ReauthRequiredError`, `NoOfflineSessionError`, `TokenRequestError` (has `status` and `responseBody`).

## Limits

- Offline sessions only. Online sessions pass through untouched.
- The lock covers refreshes that go through this package. A token exchange the template starts on its own (a new install, or an admin request after a failed refresh) does not take the lock. With the wrapper in place these are rare, but they can still race a worker refresh.
- `migrateShop` and `getOfflineSession` assume the template's session ID format, `offline_{shop}`.
- Shop values must be `*.myshopify.com`. The token request goes to that host, so anything else is refused.
- Shopify's [application-only access tokens](https://shopify.dev/docs/apps/build/authentication-authorization/application-only-access-tokens) (client credentials signed with a private key) are another way for backends to get tokens. This package does not cover them.
- The tests use a mocked token endpoint. Try a migration on a development store before you run it on real shops.

## Development

```sh
npm install
npm test
npm run typecheck
```

## Help with the migration

Maintained by [Quantdesk](https://shopify.quantdesk.in). We move app teams to expiring tokens at a fixed price, tested on a development store first.

## License

MIT. See [LICENSE](./LICENSE).
