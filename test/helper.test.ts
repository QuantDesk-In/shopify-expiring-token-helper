import {Session} from '@shopify/shopify-api';
import {MemorySessionStorage} from '@shopify/shopify-app-session-storage-memory';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
  createExpiringTokenHelper,
  createInMemoryShopLock,
  isNonExpiringTokenRejection,
  NoOfflineSessionError,
  ReauthRequiredError,
  TokenRequestError,
} from '../src/index.js';

const SHOP = 'test-shop.myshopify.com';
const ID = `offline_${SHOP}`;
const MIN = 60 * 1000;

function expiringSession(expiresInMs: number, refreshToken = 'shprt_old') {
  return new Session({
    id: ID,
    shop: SHOP,
    state: '',
    isOnline: false,
    scope: 'read_products',
    accessToken: 'shpua_old',
    expires: new Date(Date.now() + expiresInMs),
    refreshToken,
    refreshTokenExpires: new Date(Date.now() + 90 * 24 * 60 * MIN),
  });
}

function legacySession() {
  return new Session({
    id: ID,
    shop: SHOP,
    state: '',
    isOnline: false,
    scope: 'read_products',
    accessToken: 'shpat_legacy',
  });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json'},
  });
}

function tokenPair(n: number) {
  return {
    access_token: `shpua_new_${n}`,
    expires_in: 3599,
    refresh_token: `shprt_new_${n}`,
    refresh_token_expires_in: 7776000,
    scope: 'read_products',
  };
}

// A stand-in for Shopify's token endpoint. Each handler call gets the parsed
// form body; the mock records every request so tests can count them.
function mockTokenEndpoint(handler: (body: URLSearchParams) => Response | Promise<Response>) {
  const calls: {url: string; body: URLSearchParams}[] = [];
  const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const body = new URLSearchParams(String(init?.body));
    calls.push({url: String(url), body});
    // Let other callers run before the response arrives, like a real network.
    await new Promise((r) => setTimeout(r, 5));
    return handler(body);
  });
  return {fetch: fetch as unknown as typeof globalThis.fetch, calls};
}

let storage: MemorySessionStorage;

beforeEach(() => {
  storage = new MemorySessionStorage();
});

function helper(fetch: typeof globalThis.fetch, extra: Partial<Parameters<typeof createExpiringTokenHelper>[0]> = {}) {
  return createExpiringTokenHelper({
    sessionStorage: storage,
    clientId: 'client-id',
    clientSecret: 'client-secret',
    fetch,
    retryDelayMs: 0,
    ...extra,
  });
}

describe('refresh near expiry', () => {
  it('refreshes inside the margin and stores the rotated pair', async () => {
    await storage.storeSession(expiringSession(3 * MIN));
    const endpoint = mockTokenEndpoint(() => json(200, tokenPair(1)));

    const session = await helper(endpoint.fetch).getOfflineSession(SHOP);

    expect(endpoint.calls).toHaveLength(1);
    const call = endpoint.calls[0]!;
    expect(call.url).toBe(`https://${SHOP}/admin/oauth/access_token`);
    expect(Object.fromEntries(call.body)).toEqual({
      client_id: 'client-id',
      client_secret: 'client-secret',
      grant_type: 'refresh_token',
      refresh_token: 'shprt_old',
    });

    expect(session.accessToken).toBe('shpua_new_1');
    const stored = await storage.loadSession(ID);
    expect(stored?.accessToken).toBe('shpua_new_1');
    expect(stored?.refreshToken).toBe('shprt_new_1');
    expect(stored?.expires!.getTime()).toBeGreaterThan(Date.now() + 59 * MIN);
    expect(stored?.refreshTokenExpires!.getTime()).toBeGreaterThan(Date.now() + 89 * 24 * 60 * MIN);
  });

  it('does not refresh a token with time left', async () => {
    await storage.storeSession(expiringSession(40 * MIN));
    const endpoint = mockTokenEndpoint(() => json(200, tokenPair(1)));

    const session = await helper(endpoint.fetch).getOfflineSession(SHOP);

    expect(endpoint.calls).toHaveLength(0);
    expect(session.accessToken).toBe('shpua_old');
  });

  it('refreshes early when a job asks for more validity', async () => {
    await storage.storeSession(expiringSession(20 * MIN));
    const endpoint = mockTokenEndpoint(() => json(200, tokenPair(1)));

    const session = await helper(endpoint.fetch).getOfflineSession(SHOP, {minValidityMs: 30 * MIN});

    expect(endpoint.calls).toHaveLength(1);
    expect(session.accessToken).toBe('shpua_new_1');
  });

  it('rejects a validity request longer than a token lives', async () => {
    await storage.storeSession(expiringSession(20 * MIN));
    const endpoint = mockTokenEndpoint(() => json(200, tokenPair(1)));

    await expect(
      helper(endpoint.fetch).getOfflineSession(SHOP, {minValidityMs: 60 * MIN}),
    ).rejects.toThrow(RangeError);
  });

  it('wrapped storage refreshes before the template sees the session', async () => {
    await storage.storeSession(expiringSession(8 * MIN));
    const endpoint = mockTokenEndpoint(() => json(200, tokenPair(1)));

    const loaded = await helper(endpoint.fetch).sessionStorage.loadSession(ID);

    expect(endpoint.calls).toHaveLength(1);
    // The template refreshes or re-exchanges when isActive(undefined, 5 min) is false.
    expect(loaded?.isActive(undefined, 5 * MIN)).toBe(true);
  });

  it('retries a 503 with the same refresh token', async () => {
    await storage.storeSession(expiringSession(1 * MIN));
    let n = 0;
    const endpoint = mockTokenEndpoint(() =>
      ++n === 1 ? json(503, {errors: 'unavailable'}) : json(200, tokenPair(1)),
    );

    const session = await helper(endpoint.fetch).getOfflineSession(SHOP);

    expect(endpoint.calls.map((c) => c.body.get('refresh_token'))).toEqual(['shprt_old', 'shprt_old']);
    expect(session.refreshToken).toBe('shprt_new_1');
  });

  it('refuses a 200 that carries no refresh token', async () => {
    await storage.storeSession(expiringSession(1 * MIN));
    const endpoint = mockTokenEndpoint(() => json(200, {access_token: 'shpat_x', scope: 'read_products'}));

    await expect(helper(endpoint.fetch).getOfflineSession(SHOP)).rejects.toBeInstanceOf(TokenRequestError);
    expect((await storage.loadSession(ID))?.refreshToken).toBe('shprt_old');
  });
});

describe('concurrent refresh', () => {
  it('spends the refresh token once for many concurrent callers in one process', async () => {
    await storage.storeSession(expiringSession(1 * MIN));
    let n = 0;
    const endpoint = mockTokenEndpoint(() => json(200, tokenPair(++n)));
    const h = helper(endpoint.fetch);

    const results = await Promise.all([
      ...Array.from({length: 8}, () => h.getOfflineSession(SHOP)),
      // The template's webhook and admin paths go through loadSession.
      h.sessionStorage.loadSession(ID),
      h.sessionStorage.loadSession(ID),
    ]);

    expect(endpoint.calls).toHaveLength(1);
    expect(new Set(results.map((s) => s?.accessToken))).toEqual(new Set(['shpua_new_1']));
  });

  it('dedupes across two processes when they share a lock', async () => {
    await storage.storeSession(expiringSession(1 * MIN));
    let n = 0;
    const endpoint = mockTokenEndpoint(() => json(200, tokenPair(++n)));
    const sharedLock = createInMemoryShopLock();
    const web = helper(endpoint.fetch, {lock: sharedLock});
    const worker = helper(endpoint.fetch, {lock: sharedLock});

    await Promise.all([web.getOfflineSession(SHOP), worker.getOfflineSession(SHOP)]);

    expect(endpoint.calls).toHaveLength(1);
  });

  it('refreshes twice when two processes each use a local lock', async () => {
    // This is the failure the shared lock prevents. Shopify only keeps the
    // newest refresh token, so one of these two pairs is already dead.
    await storage.storeSession(expiringSession(1 * MIN));
    let n = 0;
    const endpoint = mockTokenEndpoint(() => json(200, tokenPair(++n)));
    const web = helper(endpoint.fetch);
    const worker = helper(endpoint.fetch);

    await Promise.all([web.getOfflineSession(SHOP), worker.getOfflineSession(SHOP)]);

    expect(endpoint.calls).toHaveLength(2);
  });

  it('releases the lock after a failure so the next caller can try', async () => {
    await storage.storeSession(expiringSession(1 * MIN));
    let n = 0;
    const endpoint = mockTokenEndpoint(() =>
      ++n === 1 ? json(400, {error: 'bad'}) : json(200, tokenPair(1)),
    );
    const h = helper(endpoint.fetch);

    await expect(h.getOfflineSession(SHOP)).rejects.toBeInstanceOf(TokenRequestError);
    await expect(h.getOfflineSession(SHOP)).resolves.toMatchObject({accessToken: 'shpua_new_1'});
  });
});

describe('legacy token migration', () => {
  it('exchanges a non-expiring token for an expiring pair', async () => {
    await storage.storeSession(legacySession());
    const endpoint = mockTokenEndpoint(() => json(200, tokenPair(1)));

    const result = await helper(endpoint.fetch).migrateShop(SHOP);

    expect(result.status).toBe('migrated');
    expect(Object.fromEntries(endpoint.calls[0]!.body)).toEqual({
      client_id: 'client-id',
      client_secret: 'client-secret',
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      subject_token: 'shpat_legacy',
      subject_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      requested_token_type: 'urn:shopify:params:oauth:token-type:offline-access-token',
      expiring: '1',
    });
    const stored = await storage.loadSession(ID);
    expect(stored?.accessToken).toBe('shpua_new_1');
    expect(stored?.refreshToken).toBe('shprt_new_1');
    expect(stored?.expires).toBeInstanceOf(Date);
  });

  it('skips a shop that is already on expiring tokens', async () => {
    await storage.storeSession(expiringSession(30 * MIN));
    const endpoint = mockTokenEndpoint(() => json(200, tokenPair(1)));

    const result = await helper(endpoint.fetch).migrateShop(SHOP);

    expect(result.status).toBe('already-expiring');
    expect(endpoint.calls).toHaveLength(0);
  });

  it('reports a shop with no stored session', async () => {
    const endpoint = mockTokenEndpoint(() => json(200, tokenPair(1)));
    await expect(helper(endpoint.fetch).migrateShop(SHOP)).resolves.toEqual({status: 'no-session'});
  });

  it('leaves the legacy token in place when Shopify rejects the subject token', async () => {
    await storage.storeSession(legacySession());
    const endpoint = mockTokenEndpoint(() => json(400, {error: 'invalid_subject_token'}));

    const error = await helper(endpoint.fetch).migrateShop(SHOP).catch((e) => e);

    expect(error).toBeInstanceOf(TokenRequestError);
    expect(error.status).toBe(400);
    expect(error.responseBody).toEqual({error: 'invalid_subject_token'});
    expect((await storage.loadSession(ID))?.accessToken).toBe('shpat_legacy');
  });

  it('recovers when the store write fails after a successful exchange', async () => {
    await storage.storeSession(legacySession());
    // Shopify returns the same pair when the exchange is repeated with the
    // original token within 7 days.
    const endpoint = mockTokenEndpoint(() => json(200, tokenPair(1)));
    const flaky = {
      loadSession: (id: string) => storage.loadSession(id),
      storeSession: vi.fn().mockRejectedValueOnce(new Error('db down')).mockImplementation((s: Session) => storage.storeSession(s)),
      deleteSession: (id: string) => storage.deleteSession(id),
      deleteSessions: (ids: string[]) => storage.deleteSessions(ids),
      findSessionsByShop: (shop: string) => storage.findSessionsByShop(shop),
    };
    const h = helper(endpoint.fetch, {sessionStorage: flaky});

    await expect(h.migrateShop(SHOP)).rejects.toThrow('db down');
    expect((await storage.loadSession(ID))?.accessToken).toBe('shpat_legacy');

    const retry = await h.migrateShop(SHOP);
    expect(retry.status).toBe('migrated');
    expect(endpoint.calls.map((c) => c.body.get('subject_token'))).toEqual(['shpat_legacy', 'shpat_legacy']);
  });

  it('returns a legacy session unchanged from getOfflineSession', async () => {
    await storage.storeSession(legacySession());
    const endpoint = mockTokenEndpoint(() => json(200, tokenPair(1)));

    const session = await helper(endpoint.fetch).getOfflineSession(SHOP);

    expect(session.accessToken).toBe('shpat_legacy');
    expect(endpoint.calls).toHaveLength(0);
  });

  it('documents why the future flag alone does not migrate existing shops', () => {
    // A legacy session has no expiry, so the template treats it as active and
    // never runs token exchange for it.
    expect(legacySession().isActive(undefined, 5 * MIN)).toBe(true);
  });
});

describe('failed refresh', () => {
  it('raises ReauthRequiredError on 401 and keeps the stored session', async () => {
    await storage.storeSession(expiringSession(1 * MIN));
    const endpoint = mockTokenEndpoint(() =>
      json(401, {error: 'invalid_request', error_description: 'This request requires an active refresh_token'}),
    );
    const onReauthRequired = vi.fn();

    const error = await helper(endpoint.fetch, {onReauthRequired}).getOfflineSession(SHOP).catch((e) => e);

    expect(error).toBeInstanceOf(ReauthRequiredError);
    expect(error.shop).toBe(SHOP);
    // A 401 is final, so no retries.
    expect(endpoint.calls).toHaveLength(1);
    expect(onReauthRequired).toHaveBeenCalledOnce();
    expect((await storage.loadSession(ID))?.refreshToken).toBe('shprt_old');
  });

  it('wrapped storage falls back to the stored session so the template can re-auth', async () => {
    await storage.storeSession(expiringSession(1 * MIN));
    const endpoint = mockTokenEndpoint(() => json(401, {error: 'invalid_request'}));
    const onRefreshError = vi.fn();

    const loaded = await helper(endpoint.fetch, {onRefreshError}).sessionStorage.loadSession(ID);

    expect(loaded?.accessToken).toBe('shpua_old');
    expect(onRefreshError).toHaveBeenCalledWith(SHOP, expect.any(ReauthRequiredError));
  });

  it('gives up after the retry budget on repeated 5xx', async () => {
    await storage.storeSession(expiringSession(1 * MIN));
    const endpoint = mockTokenEndpoint(() => json(502, {}));

    const error = await helper(endpoint.fetch, {retries: 2}).getOfflineSession(SHOP).catch((e) => e);

    expect(error).toBeInstanceOf(TokenRequestError);
    expect(error.status).toBe(502);
    expect(endpoint.calls).toHaveLength(3);
  });

  it('throws NoOfflineSessionError for an unknown shop', async () => {
    const endpoint = mockTokenEndpoint(() => json(200, tokenPair(1)));
    await expect(helper(endpoint.fetch).getOfflineSession(SHOP)).rejects.toBeInstanceOf(NoOfflineSessionError);
  });

  it('refuses a shop value that is not a myshopify.com domain', async () => {
    const endpoint = mockTokenEndpoint(() => json(200, tokenPair(1)));
    await expect(helper(endpoint.fetch).getOfflineSession('evil.example.com')).rejects.toThrow('Invalid shop');
  });
});

describe('isNonExpiringTokenRejection', () => {
  it('tells the April 2027 rejection apart from a missing scope', () => {
    const rejected = {
      errors: 'Non-expiring access tokens are no longer accepted for the Admin API. See https://shopify.dev/...',
    };
    const missingScope = {errors: '[API] This action requires merchant approval for read_orders scope.'};

    expect(isNonExpiringTokenRejection(403, rejected)).toBe(true);
    expect(isNonExpiringTokenRejection(403, missingScope)).toBe(false);
    expect(isNonExpiringTokenRejection(401, rejected)).toBe(false);
  });
});
