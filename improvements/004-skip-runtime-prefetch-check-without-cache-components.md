# Improvement 004: Skip Runtime Prefetch Module Loading When cacheComponents Is Disabled

## Problem

`anySegmentHasRuntimePrefetchEnabled` recursively loads ALL layout/page modules via `getLayoutOrPageModule(tree)` to check if any segment exports `unstable_instant` with `prefetch: 'runtime'`. This loads every module in the route tree on cold start — the same expensive operation that improvements 002/003 eliminated from `createFlightRouterState`.

The function is called 3 times in the main render pipeline (in `generateDynamicRSCPayload`, `getRSCPayload`, and `getErrorRSCPayload`), and each call traverses the entire route tree.

However, `unstable_instant` is a feature that requires `cacheComponents` to function. When `cacheComponents` is disabled (the default), these module loads are wasted — the function always returns `false`.

### Evidence

- `anySegmentNeedsInstantValidation` (the companion function) is already explicitly gated on `ctx.renderOpts.cacheComponents` (line 550)
- `generateStagedDynamicFlightRenderResult` (which uses the result) is only called when `cacheComponents && cachedNavigations` (line 2423)
- The `unstable_instant` config is only read by `createFlightRouterStateAsync` (the async path), which only runs when `cacheComponents` is enabled

### Impact on cold start

On a 500+ segment app, each call to `anySegmentHasRuntimePrefetchEnabled` loads every layout/page module in the tree via dynamic import. On cold start, this is the same ~300ms cost that the sync path (improvement 003) was designed to avoid. Without this fix, the module-loading work removed from `createFlightRouterState` is still performed by `anySegmentHasRuntimePrefetchEnabled`.

## Solution

Gate `anySegmentHasRuntimePrefetchEnabled` calls on `cacheComponents`:

```typescript
// BEFORE: Always traverses tree and loads all modules
const metadataIsRuntimePrefetchable =
  await anySegmentHasRuntimePrefetchEnabled(tree)

// AFTER: Skip when cacheComponents is disabled
const metadataIsRuntimePrefetchable = ctx.renderOpts.cacheComponents
  ? await anySegmentHasRuntimePrefetchEnabled(tree)
  : false
```

Applied to all 3 ungated call sites in `app-render.tsx`:

- `generateDynamicRSCPayload` (line 555)
- `getRSCPayload` (line 1657)
- `getErrorRSCPayload` (line 1800)

The remaining 2 call sites are already gated:

- `generateStagedDynamicFlightRenderResult` (line 820) — only called when `cacheComponents && cachedNavigations`
- Line 3029 — inside `cacheComponents && cachedNavigations` block

## Behavioral Correctness

- **When `cacheComponents` is disabled** (default): `unstable_instant` cannot function, so `anySegmentHasRuntimePrefetchEnabled` would always return `false`. The short-circuit produces the same result without loading modules.
- **When `cacheComponents` is enabled**: Behavior is identical — the function is called normally and modules are loaded to check for `unstable_instant` config.
- **`metadataIsRuntimePrefetchable`**: Only affects metadata rendering when runtime prefetch is active. When `false`, metadata is rendered normally.

## Files Changed

- `packages/next/src/server/app-render/app-render.tsx` — gate 3 `anySegmentHasRuntimePrefetchEnabled` calls on `cacheComponents`

## Testing

- Verified that `anySegmentNeedsInstantValidation` is already gated on `cacheComponents`
- Verified that the remaining 2 call sites are inside `cacheComponents` blocks
- No behavioral change for apps without `cacheComponents` (the default)
