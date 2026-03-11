# Improvement 006: Stream Transform Pipeline Optimizations

## Problem

The SSR stream transform pipeline in `node-web-streams-helper.ts` has two categories of per-request overhead:

### 1. `slice()` instead of `subarray()` for Uint8Array splitting

Multiple transforms use `chunk.slice()` to split chunks before/after insertion points. `slice()` **copies** the underlying buffer data, while `subarray()` creates a zero-copy **view** over the same buffer.

Affected transforms:

- `createHeadInsertionTransformStream` — 2 slice calls per first chunk
- `createClientResumeScriptInsertionTransformStream` — 2 slice calls per first chunk
- `createInstantTestScriptInsertionTransformStream` — 2 slice calls per first chunk
- `createMoveSuffixStream` — 2 slice calls when suffix found

### 2. Repeated `encoder.encode()` on constant strings

Several transforms encode the same constant string on every request, even though the string never changes:

- `createDeferredSuffixStream` — encodes suffix at flush time (called once per request, but the string is constant for the render)
- `createHtmlDataDplIdTransformStream` — encodes dplId attribute at transform time
- `createClientResumeScriptInsertionTransformStream` — encodes resume script at transform time
- `createInstantTestScriptInsertionTransformStream` — encodes test script at transform time

### Impact on throughput

For a typical page with 100 chunks:

- `slice()` creates unnecessary buffer copies (the data is immediately consumed by `Uint8Array.set()`)
- `encoder.encode()` allocates a new Uint8Array for the same constant string on every request

## Solution

### Replace `slice()` with `subarray()`

```typescript
// BEFORE: Copies buffer data
insertedHeadContent.set(chunk.slice(0, index))
insertedHeadContent.set(chunk.slice(index), index + encodedInsertion.length)

// AFTER: Zero-copy view over same buffer
insertedHeadContent.set(chunk.subarray(0, index))
insertedHeadContent.set(chunk.subarray(index), index + encodedInsertion.length)
```

### Pre-encode constant strings at creation time

```typescript
// BEFORE: Encodes at transform/flush time
function createDeferredSuffixStream(suffix: string) {
  return new TransformStream({
    flush(controller) {
      controller.enqueue(encoder.encode(suffix)) // Encodes every request
    },
  })
}

// AFTER: Encodes once at creation time
function createDeferredSuffixStream(suffix: string) {
  const encodedSuffix = encoder.encode(suffix) // Encoded once
  return new TransformStream({
    flush(controller) {
      controller.enqueue(encodedSuffix) // Reuses pre-encoded buffer
    },
  })
}
```

## Behavioral Correctness

- `subarray()` returns a view over the same buffer — when passed to `Uint8Array.set()`, the behavior is identical since `set()` copies from the source regardless
- Pre-encoded strings produce identical Uint8Array output — just computed once instead of per-request
- No change in stream output or ordering

## Files Changed

- `packages/next/src/server/stream-utils/node-web-streams-helper.ts` — replace `slice()` with `subarray()`, pre-encode constant strings
