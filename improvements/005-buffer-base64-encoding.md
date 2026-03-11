# Improvement 005: Use Buffer.from for Base64 Encoding of Binary Flight Data

## Problem

`writeFlightDataInstruction` in `use-flight-response.tsx` uses `btoa(String.fromCodePoint(...chunk))` to base64-encode binary Flight data chunks. The spread operator `...chunk` converts the entire Uint8Array into individual arguments on the call stack.

For a 64KB binary chunk, this creates 65,536 arguments — causing significant overhead from:

- Call stack pressure (V8 has a ~65K argument limit, larger chunks will throw)
- Temporary string allocation from `String.fromCodePoint`
- The entire chunk being converted to a JS string before base64 encoding

### Impact on throughput

Every SSR response with binary Flight data hits this path. For a page with 1MB of Flight data across 16 chunks, that's 16 spread operations on the hot path.

## Solution

Use Node.js `Buffer.from()` which performs base64 encoding natively in C++ without spreading:

```typescript
// BEFORE: Spreads entire Uint8Array into varargs
const base64 = btoa(String.fromCodePoint(...chunk))

// AFTER: Native C++ base64 encoding, falls back to btoa for Edge runtime
const base64 =
  typeof Buffer !== 'undefined'
    ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString(
        'base64'
      )
    : btoa(String.fromCodePoint(...chunk))
```

## Behavioral Correctness

- Produces identical base64 output
- Edge runtime falls back to the original `btoa` path (no `Buffer` available)
- Node.js runtime uses `Buffer.from` which handles arbitrary binary data correctly

## Files Changed

- `packages/next/src/server/app-render/use-flight-response.tsx` — replace `btoa(String.fromCodePoint(...chunk))` with `Buffer.from().toString('base64')`
