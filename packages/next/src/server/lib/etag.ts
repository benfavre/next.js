/**
 * FNV-1a Hash implementation
 * @author Travis Webb (tjwebb) <me@traviswebb.com>
 *
 * Ported from https://github.com/tjwebb/fnv-plus/blob/master/index.js
 *
 * Simplified, optimized and add modified for 52 bit, which provides a larger hash space
 * and still making use of Javascript's 53-bit integer space.
 */
export const fnv1a52 = (str: string) => {
  const len = str.length
  let i = 0,
    t0 = 0,
    v0 = 0x2325,
    t1 = 0,
    v1 = 0x8422,
    t2 = 0,
    v2 = 0x9ce4,
    t3 = 0,
    v3 = 0xcbf2

  while (i < len) {
    v0 ^= str.charCodeAt(i++)
    t0 = v0 * 435
    t1 = v1 * 435
    t2 = v2 * 435
    t3 = v3 * 435
    t2 += v0 << 8
    t3 += v1 << 8
    t1 += t0 >>> 16
    v0 = t0 & 65535
    t2 += t1 >>> 16
    v1 = t1 & 65535
    v3 = (t3 + (t2 >>> 16)) & 65535
    v2 = t2 & 65535
  }

  return (
    (v3 & 15) * 281474976710656 +
    v2 * 4294967296 +
    v1 * 65536 +
    (v0 ^ (v3 >> 4))
  )
}

/**
 * LRU cache for computed ETags. Pre-rendered/static pages produce identical
 * payloads across requests, so caching the ETag avoids re-running the O(n)
 * fnv1a52 hash on every request.
 *
 * The cache is bounded by entry count (MAX_ETAG_CACHE_ENTRIES) and skips
 * payloads larger than MAX_CACHED_PAYLOAD_LENGTH to avoid holding references
 * to very large strings.
 *
 * V8's native Map string-key hashing is used for lookups, which is
 * significantly faster than the JS-level character-by-character FNV-1a loop.
 */
const MAX_ETAG_CACHE_ENTRIES = 512
const MAX_CACHED_PAYLOAD_LENGTH = 512 * 1024 // 512 KB

// Using a Map as an LRU: Map iteration order is insertion order.
// On cache hit we delete + re-insert to move the entry to the end.
// On eviction we delete the first (oldest) entry.
const etagCache = new Map<string, string>()

export const generateETag = (payload: string, weak = false) => {
  // Build a cache key that incorporates the `weak` flag so that
  // strong and weak ETags for the same payload are cached separately.
  // The vast majority of calls use strong (weak=false), so we avoid
  // string concatenation in the common case.
  const cacheKey = weak ? 'w\0' + payload : payload

  const cached = etagCache.get(cacheKey)
  if (cached !== undefined) {
    // Move to end (most-recently-used) by re-inserting
    etagCache.delete(cacheKey)
    etagCache.set(cacheKey, cached)
    return cached
  }

  const prefix = weak ? 'W/"' : '"'
  const etag =
    prefix + fnv1a52(payload).toString(36) + payload.length.toString(36) + '"'

  // Only cache payloads within the size threshold to avoid pinning
  // very large strings in memory.
  if (payload.length <= MAX_CACHED_PAYLOAD_LENGTH) {
    if (etagCache.size >= MAX_ETAG_CACHE_ENTRIES) {
      // Evict the least-recently-used entry (first key in insertion order)
      const firstKey = etagCache.keys().next().value
      if (firstKey !== undefined) {
        etagCache.delete(firstKey)
      }
    }
    etagCache.set(cacheKey, etag)
  }

  return etag
}
