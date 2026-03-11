# Improvement 003: Synchronous Flight Router State Tree Walk

## Problem

`createFlightRouterStateFromLoaderTree` uses an async recursive function with `Promise.all` to traverse the route tree — even when `cacheComponents` is disabled and no module loading is needed. On a 500+ segment app, this creates 500+ Promises, microtask scheduling overhead, and async state machine overhead (V8 compiles each async function into a state machine).

### Profiling data (500+ routes app, /manage dashboard)

| Metric                         | Before (improvement 002) | After               |
| ------------------------------ | ------------------------ | ------------------- |
| Cold `createFlightRouterState` | 261ms                    | 47.8ms (82% faster) |
| Warm `createFlightRouterState` | 0.1ms                    | 0.0ms (sub-ms)      |

**vs original baseline (before any improvements):**

| Metric                         | Original | After improvement 003 |
| ------------------------------ | -------- | --------------------- |
| Cold `createFlightRouterState` | 331ms    | 47.8ms (86% faster)   |
| Warm `createFlightRouterState` | ~1ms     | 0.0ms                 |

The remaining 47.8ms cold cost is V8's first-parse/JIT compilation of the module. After JIT warmup, the synchronous tree walk completes in <0.1ms for 500+ segments.

## Root Cause

```typescript
// BEFORE: Always async, even when no module loading is needed
async function createFlightRouterStateFromLoaderTreeImpl(
  loaderTree, getDynamicParamFromSegment, searchParams,
  didFindRootLayout, needsInstantConfig
): Promise<FlightRouterState> {
  // Creates Promise.resolve(undefined) even when not loading modules
  const modPromise = needsInstantConfig ? layout[0]() : Promise.resolve(undefined)

  // 500+ recursive async calls, each creating Promise objects
  const childPromises = parallelRouteKeys.map((key) =>
    createFlightRouterStateFromLoaderTreeImpl(...)
  )

  // Promise.all across 500+ Promises
  const [mod, ...childResults] = await Promise.all([modPromise, ...childPromises])
}
```

Each async function invocation:

1. Allocates a Promise object
2. Creates an async state machine in V8
3. Schedules microtasks for each `await`
4. Requires `Promise.all` to coordinate children

With 500+ segments, this overhead dominates cold-start time.

## Solution

Split into two functions — a synchronous fast path and an async path:

```typescript
// Synchronous fast path — no Promises, no microtasks, no async overhead
function createFlightRouterStateSync(
  loaderTree, getDynamicParamFromSegment, searchParams, didFindRootLayout
): FlightRouterState {
  const [segment, parallelRoutes, { layout, loading }] = loaderTree
  // ... simple recursive traversal with for-in loop
  for (const key in parallelRoutes) {
    children[key] = createFlightRouterStateSync(parallelRoutes[key], ...)
  }
  return segmentTree
}

// Async path — only used when cacheComponents is enabled
async function createFlightRouterStateAsync(...): Promise<FlightRouterState> {
  // ... loads modules via layout[0](), uses Promise.all
}

// Dispatcher
export function createFlightRouterStateFromLoaderTree(
  loaderTree, getDynamicParamFromSegment, searchParams,
  cacheComponents?: boolean
): FlightRouterState | Promise<FlightRouterState> {
  if (!cacheComponents) {
    return createFlightRouterStateSync(...)  // Returns plain value, not Promise
  }
  return createFlightRouterStateAsync(...)   // Returns Promise
}
```

The sync function:

- Returns `FlightRouterState` directly (not `Promise<FlightRouterState>`)
- Uses `for...in` loop instead of `Object.keys().map()`
- No `Promise.all`, no `Promise.resolve`, no `await`
- Simple call stack recursion — V8 optimizes this trivially

## Behavioral Correctness

- **When `cacheComponents` is disabled** (default): The sync path produces identical output. It computes the same `PrefetchHint` flags (`IsRootLayout`, `SegmentHasLoadingBoundary`, `SubtreeHasLoadingBoundary`) using the same logic. `SubtreeHasInstant` and `HasRuntimePrefetch` are never set (they require module loading, which is only available with `cacheComponents`).
- **When `cacheComponents` is enabled**: The async path runs exactly as before — loads modules, checks `unstable_instant`, uses `Promise.all` for concurrent traversal.
- **Return type**: Changed from `Promise<FlightRouterState>` to `FlightRouterState | Promise<FlightRouterState>`. Callers already use `await`, which handles both cases (`await` on a non-Promise returns the value immediately).
- **`createRouteTreePrefetch`**: Same sync/async dispatch applied.

## Files Changed

- `packages/next/src/server/app-render/create-flight-router-state-from-loader-tree.ts` — added `createFlightRouterStateSync`, renamed old impl to `createFlightRouterStateAsync`, changed return types
- `packages/next/src/server/app-render/walk-tree-with-flight-router-state.tsx` — passes `ctx.renderOpts.cacheComponents` to all call sites
- `packages/next/src/server/app-render/app-render.tsx` — passes `ctx.renderOpts.cacheComponents` to all call sites

## Testing

- Verified with SSR profiler on a 500+ route production app
- Cold start `createFlightRouterState`: 261ms → 47.8ms (82% faster)
- Warm state: 0.1ms → <0.1ms (sub-millisecond)
- After full JIT warmup: consistently 0.0ms
- No behavioral change — `cacheComponents` is not enabled in the test app
- All callers use `await`, which correctly handles both sync and async return paths
