# Improvement 001: Parallelize Flight Router State Tree Walk

## Problem

`createFlightRouterStateFromLoaderTree` processes the route tree sequentially:

1. **Module loading blocks children**: Line 26 awaits the layout/page module import before processing any children
2. **Children processed sequentially**: The `for...in` loop (line 51) awaits each child one-by-one

On cold start with a large app (500+ routes), this creates a cascade of sequential `await` calls for module loading. Each segment's layout/page is dynamically imported for the first time, hitting disk I/O.

### Profiling data (500+ routes app, /manage dashboard)

| Metric              | Before     | After                        |
| ------------------- | ---------- | ---------------------------- |
| Cold start          | 331ms      | 331ms (no change — see note) |
| Warm (2nd request)  | 24ms total | 15ms total (37% faster)      |
| Warm (steady state) | 34ms avg   | 20ms avg                     |

**Note on cold start:** For mostly-linear route trees (single `children` key per level), there are no parallel siblings to fan out. The cold-start bottleneck is CPU-bound JS module parsing which is single-threaded. Apps with parallel routes (`@modal`, `@sidebar`, etc.) will see cold-start improvements proportional to the number of parallel slots.

**Warm-state improvement:** The `Promise.all` reduces microtask overhead compared to sequential `for...in` + `await`, yielding a measurable warm improvement.

## Root Cause

```typescript
// BEFORE: Sequential — each await blocks the next
const mod = layout ? await layout[0]() : page ? await page[0]() : undefined
// ... config checks ...
for (const key in parallelRoutes) {
  const child = await createFlightRouterStateFromLoaderTreeImpl(...)  // blocks
  children[key] = child
}
```

On cold start, `layout[0]()` triggers a dynamic import that loads and evaluates the module for the first time (~5-50ms per module depending on complexity). With N segments, total time is O(N × avg_module_load_time) instead of O(max_module_load_time).

## Solution

Kick off the module load AND all child tree traversals concurrently using `Promise.all`:

```typescript
// AFTER: Concurrent — module load + all children run in parallel
const modPromise = layout ? layout[0]() : page ? page[0]() : undefined
const childPromises = Object.keys(parallelRoutes).map(key =>
  createFlightRouterStateFromLoaderTreeImpl(parallelRoutes[key], ...)
)
const [mod, ...childResults] = await Promise.all([modPromise, ...childPromises])
```

This converts the sequential cascade into a parallel fan-out at every tree level.

## Behavioral Correctness

- **`didFindRootLayout` flag**: Original code mutated this before the loop. The parallel version computes the updated value inline: `didFindRootLayout || typeof layout !== 'undefined'`. Semantically identical since the flag only flows downward.
- **Prefetch hint propagation**: Still collected from all children after they complete. No ordering dependency.
- **Module side effects**: Module loading order is now non-deterministic within a tree level. This is safe because layout/page modules should not have cross-module side effects that depend on load order.

## Files Changed

- `packages/next/src/server/app-render/create-flight-router-state-from-loader-tree.ts`

## Testing

- Verified with SSR profiler on a 500+ route production app
- Type check passes
- No behavioral change for warm requests
