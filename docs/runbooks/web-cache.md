# Web fetch cache

The web container uses Next.js's in-process LRU cache with a 50 MiB accounting
budget. Runtime incremental/fetch cache writes to disk are disabled. The budget
is Next.js's estimate of cached entries, not a limit on total process memory.

Public API responses retain their 15-second revalidation interval. Session
lookups and requests with cookies remain `no-store`. Evicted entries and entries
lost on restart are fetched again. Each web process has its own cache.

The pinned Next.js version supports `experimental.isrFlushToDisk: false` in
`apps/web/next.config.mjs`. Keep `apps/web/cache.test.mjs` passing when upgrading
Next.js; it exercises the actual cache implementation, including eviction,
cache hits, tag invalidation, and absence of filesystem writes. Also verify the
built standalone server's public cache hits, revalidation, and cookie bypass.

Recreating the web container removes its old cache tmpfs. Verify that
`/app/apps/web/.next/cache/fetch-cache` stays absent or empty during public page
traffic and that new web logs contain no `ENOSPC` or
`Failed to update prerender cache` errors. A healthy `/healthz` response alone
does not establish that caching works.

This configuration addresses fetch-cache growth. Image optimization and other
Next.js features may use separate caches; check the directory responsible if
the cache mount fills again.
