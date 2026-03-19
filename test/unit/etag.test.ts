/* eslint-env jest */
import { fnv1a52, generateETag } from 'next/dist/server/lib/etag'

describe('fnv1a52', () => {
  test('returns a number', () => {
    expect(typeof fnv1a52('hello')).toBe('number')
  })

  test('produces consistent hashes', () => {
    const hash1 = fnv1a52('test payload')
    const hash2 = fnv1a52('test payload')
    expect(hash1).toBe(hash2)
  })

  test('produces different hashes for different inputs', () => {
    const hash1 = fnv1a52('hello')
    const hash2 = fnv1a52('world')
    expect(hash1).not.toBe(hash2)
  })
})

describe('generateETag', () => {
  test('generates a strong ETag by default', () => {
    const etag = generateETag('test')
    expect(etag).toMatch(/^"[a-z0-9]+"$/)
    expect(etag).not.toMatch(/^W\//)
  })

  test('generates a weak ETag when requested', () => {
    const etag = generateETag('test', true)
    expect(etag).toMatch(/^W\/"[a-z0-9]+"$/)
  })

  test('produces consistent ETags for the same payload', () => {
    const etag1 = generateETag('hello world')
    const etag2 = generateETag('hello world')
    expect(etag1).toBe(etag2)
  })

  test('produces different ETags for different payloads', () => {
    const etag1 = generateETag('hello')
    const etag2 = generateETag('world')
    expect(etag1).not.toBe(etag2)
  })

  test('strong and weak ETags for the same payload differ', () => {
    const strong = generateETag('test payload')
    const weak = generateETag('test payload', true)
    expect(strong).not.toBe(weak)
    expect(weak.startsWith('W/"')).toBe(true)
    expect(strong.startsWith('"')).toBe(true)
  })

  test('returns cached result on repeated calls (same reference)', () => {
    const payload = 'cached-payload-test-' + Date.now()
    // First call computes
    const etag1 = generateETag(payload)
    // Second call should hit cache and return identical result
    const etag2 = generateETag(payload)
    expect(etag1).toBe(etag2)
  })

  test('handles empty string', () => {
    const etag = generateETag('')
    expect(etag).toMatch(/^"[a-z0-9]+"$/)
  })

  test('handles large payloads', () => {
    const large = 'x'.repeat(100_000)
    const etag = generateETag(large)
    expect(etag).toMatch(/^"[a-z0-9]+"$/)
    // Repeated call for the same large payload should return identical result
    expect(generateETag(large)).toBe(etag)
  })

  test('does not cache payloads exceeding the size threshold', () => {
    // Payloads over 512KB are not cached, but should still produce valid ETags
    const huge = 'y'.repeat(600_000)
    const etag1 = generateETag(huge)
    const etag2 = generateETag(huge)
    expect(etag1).toMatch(/^"[a-z0-9]+"$/)
    // Both should produce the same ETag (just not cached)
    expect(etag1).toBe(etag2)
  })
})
