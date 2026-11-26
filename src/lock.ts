/**
 * Runs fn while holding an exclusive lock for one shop.
 *
 * The in-memory lock below only covers one Node process. If more than one
 * process or machine can refresh the same shop (several web instances, a
 * separate worker), supply a lock they all share, such as a Postgres advisory
 * lock or a Redis lock. The README has an example.
 */
export interface ShopLock {
  withLock<T>(shop: string, fn: () => Promise<T>): Promise<T>;
}

export function createInMemoryShopLock(): ShopLock {
  const tails = new Map<string, Promise<unknown>>();

  return {
    async withLock<T>(shop: string, fn: () => Promise<T>): Promise<T> {
      const previous = tails.get(shop) ?? Promise.resolve();
      const run = previous.then(() => fn());
      // The stored tail never rejects, so a failed refresh does not skip the
      // lock for whoever is queued behind it.
      const tail = run.catch(() => undefined);
      tails.set(shop, tail);
      try {
        return await run;
      } finally {
        if (tails.get(shop) === tail) tails.delete(shop);
      }
    },
  };
}
