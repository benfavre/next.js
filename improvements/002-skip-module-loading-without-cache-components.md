# Improvement 002: Skip Module Loading When cacheComponents Is Disabled

## Problem

`createFlightRouterStateFromLoaderTree` loads every layout/page module in the route tree via `layout[0]()` (dynamic import) to check for `unstable_instant` config — even when `cacheComponents` is disabled, which means `unstable_instant` cannot be used.

On a 500+ route app, this loads hundreds of modules on cold start purely to read a config flag that doesn't exist.

### Profiling data (500+ routes app, /manage dashboard)

| Metric                         | Before | After              |
| ------------------------------ | ------ | ------------------ |
| Cold `createFlightRouterState` | 331ms  | 261ms (21% faster) |
| Warm `createFlightRouterState` | 0.1ms  | 0.1ms (no change)  |

**Note on remaining cold cost:** The remaining 261ms is V8 JIT compilation overhead for 500+ recursive async function calls with `Promise.all`. This disappears on warm runs (0.1ms) once V8 optimizes the hot path. Further improvement would require reducing the async overhead (e.g., synchronous tree walk).

## Root Cause

```typescript
// BEFORE: Always loads modules, even when cacheComponents is disabled
const modPromise = layout
  ? layout[0]() // triggers dynamic import on EVERY segment
  : page
    ? page[0]()
    : Promise.resolve(undefined)
```

`layout[0]()` triggers a dynamic import that loads and evaluates the module file. With 500+ segments, this is hundreds of unnecessary imports on cold start for apps that don't use `unstable_instant`.

## Solution

Add a `needsInstantConfig` parameter that gates module loading:

```typescript
// AFTER: Only load modules when cacheComponents is enabled
const modPromise = needsInstantConfig
  ? layout
    ? layout[0]()
    : page
      ? page[0]()
      : Promise.resolve(undefined)
  : Promise.resolve(undefined) // skip entirely
```

The `needsInstantConfig` flag is derived from `cacheComponents` at the call sites:

```typescript
export async function createFlightRouterStateFromLoaderTree(
  loaderTree,
  getDynamicParamFromSegment,
  searchParams,
  cacheComponents?: boolean // NEW parameter
) {
  const needsInstantConfig = !!cacheComponents
  // ...
}
```

## Behavioral Correctness

- **When `cacheComponents` is disabled** (default): Module loading is skipped entirely. `unstable_instant` is not available without `cacheComponents`, so there's nothing to read. `mod` resolves to `undefined`, and `instantConfig` is `undefined` — identical to the previous behavior when no module exported `unstable_instant`.
- **When `cacheComponents` is enabled**: Behavior is identical to before — modules are loaded and `unstable_instant` is read normally.
- **Prefetch hints**: `PrefetchHint.IsRootLayout`, `SegmentHasLoadingBoundary`, and `SubtreeHasLoadingBoundary` are unaffected — they don't depend on module content. Only `SubtreeHasInstant` and `HasRuntimePrefetch` are gated by `instantConfig`, which is correctly `undefined` when skipped.

## Files Changed

- `packages/next/src/server/app-render/create-flight-router-state-from-loader-tree.ts`
- `packages/next/src/server/app-render/walk-tree-with-flight-router-state.tsx` (pass `cacheComponents` to callers)
- `packages/next/src/server/app-render/app-render.tsx` (pass `cacheComponents` to callers)

## Testing

- Verified with SSR profiler on a 500+ route production app
- Cold start `createFlightRouterState`: 331ms → 261ms
- Warm state: unchanged at 0.1ms
- No behavioral change — `cacheComponents` is not enabled in the test app
