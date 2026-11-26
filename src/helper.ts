import {Session} from '@shopify/shopify-api';
import type {SessionStorage} from '@shopify/shopify-app-session-storage';

import {NoOfflineSessionError, ReauthRequiredError} from './errors.js';
import {createInMemoryShopLock, type ShopLock} from './lock.js';
import {assertShop, createTokenClient, type TokenResponse} from './token-client.js';

export interface ExpiringTokenHelperOptions {
  /** The storage you already pass to shopifyApp(), e.g. PrismaSessionStorage. */
  sessionStorage: SessionStorage;
  /** The app's client ID (SHOPIFY_API_KEY in the template). */
  clientId: string;
  /** The app's client secret (SHOPIFY_API_SECRET in the template). */
  clientSecret: string;
  /** Defaults to an in-memory lock, which only covers one process. */
  lock?: ShopLock;
  /**
   * Refresh when the access token has less than this left. Default 10 minutes.
   * Keep it above the template's own 5 minute margin so the template finds a
   * fresh token and does not start a second, unlocked refresh.
   */
  refreshMarginMs?: number;
  /** Called once per failed refresh that needs the merchant to reopen the app. */
  onReauthRequired?: (shop: string, error: ReauthRequiredError) => void | Promise<void>;
  /** Called when the wrapped storage could not refresh and fell back to the stored session. */
  onRefreshError?: (shop: string, error: unknown) => void;
  /** Extra attempts after a network error, 429 or 5xx. Default 2. */
  retries?: number;
  retryDelayMs?: number;
  fetch?: typeof fetch;
}

export interface GetOfflineSessionOptions {
  /**
   * Minimum time the returned access token must stay valid. Use this for a
   * job that runs longer than the default margin. Capped at 45 minutes,
   * because access tokens last about an hour and asking for more would
   * refresh on every call.
   */
  minValidityMs?: number;
}

export type MigrationResult =
  | {status: 'migrated'; session: Session}
  | {status: 'already-expiring'; session: Session}
  | {status: 'no-session'};

const DEFAULT_MARGIN_MS = 10 * 60 * 1000;
const MAX_VALIDITY_MS = 45 * 60 * 1000;

export function createExpiringTokenHelper(options: ExpiringTokenHelperOptions) {
  const storage = options.sessionStorage;
  const lock = options.lock ?? createInMemoryShopLock();
  const defaultMargin = options.refreshMarginMs ?? DEFAULT_MARGIN_MS;
  if (defaultMargin > MAX_VALIDITY_MS) {
    throw new RangeError(`refreshMarginMs cannot exceed ${MAX_VALIDITY_MS} ms`);
  }
  const client = createTokenClient({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    fetch: options.fetch ?? globalThis.fetch,
    retries: options.retries ?? 2,
    retryDelayMs: options.retryDelayMs ?? 250,
  });

  function needsRefresh(session: Session, marginMs: number): boolean {
    if (!session.refreshToken) return false;
    if (!session.expires) return true;
    return session.expires.getTime() - marginMs <= Date.now();
  }

  // Loads the session again after taking the lock. If another caller refreshed
  // while we waited, its result is already in storage and we return that
  // instead of spending the refresh token a second time.
  async function refreshUnderLock(shop: string, id: string, marginMs: number): Promise<Session> {
    return lock.withLock(shop, async () => {
      const current = await storage.loadSession(id);
      if (!current) throw new NoOfflineSessionError(shop);
      if (!needsRefresh(current, marginMs)) return current;

      let tokens: TokenResponse;
      try {
        tokens = await client.refresh(shop, current.refreshToken!);
      } catch (error) {
        if (error instanceof ReauthRequiredError) {
          await options.onReauthRequired?.(shop, error);
        }
        throw error;
      }

      // If this write fails, storage still holds the refresh token we just
      // presented. Shopify keeps that one usable until the new one is used,
      // so the next attempt can refresh again.
      const next = toSession(current, tokens);
      await storage.storeSession(next);
      return next;
    });
  }

  /**
   * Returns the shop's offline session with an access token that is valid for
   * at least the margin. Refreshes under the shop lock when needed.
   * Sessions still on a non-expiring token are returned unchanged.
   */
  async function getOfflineSession(shop: string, opts: GetOfflineSessionOptions = {}): Promise<Session> {
    assertShop(shop);
    const marginMs = Math.max(opts.minValidityMs ?? 0, defaultMargin);
    if (marginMs > MAX_VALIDITY_MS) {
      throw new RangeError(`minValidityMs cannot exceed ${MAX_VALIDITY_MS} ms`);
    }
    const id = offlineId(shop);
    const session = await storage.loadSession(id);
    if (!session) throw new NoOfflineSessionError(shop);
    if (!needsRefresh(session, marginMs)) return session;
    return refreshUnderLock(shop, id, marginMs);
  }

  /**
   * Swaps the shop's stored non-expiring offline token for an expiring pair.
   * Shopify invalidates the old token for Admin API calls as soon as the
   * exchange succeeds, so only run this from the system that will own
   * refreshes for this shop.
   */
  async function migrateShop(shop: string): Promise<MigrationResult> {
    assertShop(shop);
    const id = offlineId(shop);
    return lock.withLock(shop, async () => {
      const current = await storage.loadSession(id);
      if (!current?.accessToken) return {status: 'no-session'};
      if (current.refreshToken || current.expires) {
        return {status: 'already-expiring', session: current};
      }

      const tokens = await client.migrate(shop, current.accessToken);
      // If this write fails the legacy token is still in storage. Shopify
      // returns the same pair when the exchange is repeated with the original
      // token within 7 days, so calling migrateShop again recovers it.
      const next = toSession(current, tokens);
      await storage.storeSession(next);
      return {status: 'migrated', session: next};
    });
  }

  /**
   * Wraps your storage for shopifyApp({sessionStorage}). When the template
   * loads an offline session that is close to expiry, the wrapper refreshes it
   * under the shop lock first. That routes the template's own refresh paths
   * (webhooks, unauthenticated.admin, flow, app proxy) and the embedded admin
   * path through the lock. If the refresh fails, the stored session is
   * returned as is and the template falls back to its normal behaviour.
   */
  const sessionStorage: SessionStorage = {
    async loadSession(id) {
      const session = await storage.loadSession(id);
      if (!session || session.isOnline || !session.accessToken) return session;
      if (!needsRefresh(session, defaultMargin)) return session;
      try {
        return await refreshUnderLock(session.shop, id, defaultMargin);
      } catch (error) {
        options.onRefreshError?.(session.shop, error);
        return session;
      }
    },
    storeSession: (session) => storage.storeSession(session),
    deleteSession: (id) => storage.deleteSession(id),
    deleteSessions: (ids) => storage.deleteSessions(ids),
    findSessionsByShop: (shop) => storage.findSessionsByShop(shop),
  };

  return {sessionStorage, getOfflineSession, migrateShop};
}

/** Same ID format the template uses: api.session.getOfflineId(shop). */
function offlineId(shop: string): string {
  return `offline_${shop}`;
}

function toSession(previous: Session, tokens: TokenResponse): Session {
  const now = Date.now();
  return new Session({
    id: previous.id,
    shop: previous.shop,
    state: previous.state ?? '',
    isOnline: false,
    scope: tokens.scope ?? previous.scope,
    accessToken: tokens.access_token,
    expires: new Date(now + tokens.expires_in * 1000),
    refreshToken: tokens.refresh_token,
    refreshTokenExpires: tokens.refresh_token_expires_in
      ? new Date(now + tokens.refresh_token_expires_in * 1000)
      : undefined,
  });
}
