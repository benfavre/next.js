# Next.js SSR Performance Improvements

**Branch:** `perf/all-improvements`
**Base:** `canary` (v16.2.0-canary.104)
**PRs:** 30 open against `vercel/next.js`
**Tests:** 171 unit tests across 12 suites, all passing

## Benchmark Results

**Setup:** Node.js v25.7.0, autocannon (10s duration, 3s warmup), bench/app-router-server with minimal-server (minimalMode: true). Both branches built with `rm -rf packages/next/dist && pnpm --filter=next build`. Same machine, same routes, same app, measured back-to-back.

### Static Route (`/rsc` — pre-rendered `<div>hello</div>`, root layout only)

| Concurrency | Canary Baseline | This Branch | Improvement |
|---|---|---|---|
| c=1 | 5,222 req/s | 7,319 req/s | **+40.2%** |
| c=50 | 5,925 req/s | 9,119 req/s | **+53.9%** |

### Dynamic Route (`/deep/a/b/.../j` — 10 nested layouts, `headers()`, 10 dynamic params, force-dynamic)

| Concurrency | Canary Baseline | This Branch | Improvement |
|---|---|---|---|
| c=1 | 604 req/s, 1.08ms | 685 req/s, 1.07ms | **+13.4%** |
| c=50 | 634 req/s, 78.1ms | 731 req/s, 67.7ms | **+15.3%, -13.3% latency** |

---

## CPU Profile Breakdown — Before vs After

### Canary Baseline (dynamic /deep/ route, c=1)

```
structuredClone      247ms  (eliminated)
trace (tracer.js)    152ms  (reduced to 11ms)
loadManifest          84ms  (eliminated — cached)
handleRequestImpl     59ms  (reduced)
normalizeString      136ms  (reduced to 24ms)
isInterceptionRoute   23ms  (eliminated — fast-path)
addRequestMeta       119ms  (reduced — simplified)
IncrementalCache     118ms  (reduced — cached handler)
encode               137ms  (reduced)
setHeader            209ms  (reduced — pre-computed)
```

### This Branch (dynamic /deep/ route, c=1)

```
structuredClone        0ms  ✓ eliminated
trace (tracer.js)     11ms  ✓ noop bypass
loadManifest           0ms  ✓ cached per route
normalizeString       24ms  ✓ reduced 82%
isInterceptionRoute    0ms  ✓ fast-path
addRequestMeta         5ms  ✓ simplified
```

All non-React framework functions are now < 38μs/req.

---

## All 30 PRs — Detailed Breakdown

### Phase Skipping (eliminate entire code paths)

| PR | What | Impact |
|---|---|---|
| [#91586](https://github.com/vercel/next.js/pull/91586) | **Noop tracer bypass** — detect NoopTracer via `isRecording()` probe, skip `context.with()` + `startActiveSpan()` + `rootSpanAttributesStore` for all 4 methods | 30+ ALS context switches eliminated per request |
| [#91590](https://github.com/vercel/next.js/pull/91590) | **Skip dev-only convention lookups** — all `getConventionPathByType()` calls guarded by `isSegmentViewEnabled` | ~100 function calls eliminated per production render |
| [#91597](https://github.com/vercel/next.js/pull/91597) | **Skip empty rewrites** — pre-computed `hasRewrites` flag, fast-return when no rewrites configured | URL copy + 2 closures + 3 array iterations eliminated |
| [#91623](https://github.com/vercel/next.js/pull/91623) | **Remove unnecessary async** — `createBoundaryConventionElement` was `async` with zero `await` inside | 30 Promise allocations + microtask ticks eliminated per request |

### structuredClone Elimination (was 4.5% of CPU)

| PR | What | Before → After |
|---|---|---|
| [#91577](https://github.com/vercel/next.js/pull/91577) | **Metadata resolution** — targeted spread with deep-copy for `openGraph`, `twitter`, `icons` | 247ms → 0ms (called 20× per request with 10 layouts) |
| [#91572](https://github.com/vercel/next.js/pull/91572) | **handleRewrites** — shallow copy for flat URL object + pre-compiled basePath regex | Part of 1140ms total |
| [#91574](https://github.com/vercel/next.js/pull/91574) | **Params + regex reference** — spread for flat Records | Part of 1140ms total |

### Caching (eliminate redundant computation)

| PR | What | Impact |
|---|---|---|
| [#91608](https://github.com/vercel/next.js/pull/91608) | **ETag cache** — LRU cache (512 entries) for `generateETag()` which hashes response body char-by-char | 1,840ms (8% CPU) → 0ms for repeated content. 31× speedup on cache hit |
| [#91599](https://github.com/vercel/next.js/pull/91599) | **Manifest cache** — `Map<string, LoadedManifests>` per route, `Map<string, LoadComponentsReturnType>` per page | 10+ path.join + Map lookups eliminated per request |
| [#91604](https://github.com/vercel/next.js/pull/91604) | **Runtime checks + CacheHandler** — cached `process.env.NEXT_RUNTIME`, cached CacheHandler promise, cached IncrementalCache env reads | 196ms isNodeNextResponse → ~0, handler resolved once |
| [#91617](https://github.com/vercel/next.js/pull/91617) | **In-memory response cache** — complete HTTP response (status + headers + body) cached for static pages | Skips entire framework pipeline on cache hit |
| [#91618](https://github.com/vercel/next.js/pull/91618) | **React element cache** — `RenderFromTemplateContext` element cached via WeakMap, loop-invariant code hoisted | 10 createElement + 10 destructurings saved per request |

### Stream Pipeline (was 10.8% of CPU)

| PR | What | Impact |
|---|---|---|
| [#91575](https://github.com/vercel/next.js/pull/91575) | **Merge 3 head transforms** — DplId + Metadata + Validator into `createUnifiedHeadTransform` | 8 → 6 TransformStreams per request |
| [#91621](https://github.com/vercel/next.js/pull/91621) | **Merge buffer + head + suffix + insertion** — `createBufferedUnifiedTransform` + `createMoveSuffixAndHeadInsertionStream` | 8 → 4 TransformStreams per request |
| [#91592](https://github.com/vercel/next.js/pull/91592) | **Buffer.concat + allocUnsafe** — C++ merge, skip zero-fill, cached encoder.encode, subarray | GC pressure reduced across 6 allocation sites |
| [#91580](https://github.com/vercel/next.js/pull/91580) | **Node.js native stream helpers** — 12 functions with ALS-safe `bindSnapshot()`, pre-computed Buffer.indexOf | Foundation for native stream pipeline |
| [#91583](https://github.com/vercel/next.js/pull/91583) | **Wire into render pipeline** — `stream-ops.node.ts` + `stream-ops.ts` switcher behind `useNodeStreams` flag | Native `continueFizzStream` with Node.js Transforms |

### URL / Regex / Parsing

| PR | What | Impact |
|---|---|---|
| [#91571](https://github.com/vercel/next.js/pull/91571) | **parseRelativeUrl server fast path** — `SERVER_ORIGIN` constant, 1 URL construction instead of 3 | 17ms → single URL parse |
| [#91564](https://github.com/vercel/next.js/pull/91564) | **splitCookiesString charCode** — integer comparison instead of per-character `/\s/` regex | Regex eliminated from tight loop |
| [#91565](https://github.com/vercel/next.js/pull/91565) | **Walk-tree for...in** — avoids `Object.keys()` array allocation; pre-compiled postponed-state regex | Array allocation saved per recursion |
| [#91569](https://github.com/vercel/next.js/pull/91569) | **Pre-compile PARAM_SEPARATOR regex** — hoisted from `stripParameterSeparators` loop | 35ms → 14ms |
| [#91594](https://github.com/vercel/next.js/pull/91594) | **Interception route fast-path** — `path.includes('(')` pre-check; cached streaming-metadata regex | 23ms → 3ms |
| [#91613](https://github.com/vercel/next.js/pull/91613) | **Eliminate remaining URL + cache bot** — string-based pathname in minimalMode; 6 hoisted regex; `.test()` over `.match()` | 2 URL constructions + 1 regex test + 6 inline regex eliminated |

### React Element Reduction

| PR | What | Impact |
|---|---|---|
| [#91593](https://github.com/vercel/next.js/pull/91593) | **Skip Fragment wrapper** for Template; single-child fast path avoids Promise.all; boundary short-circuit | 10+ createElement + 10 Promise.all eliminated |
| [#91601](https://github.com/vercel/next.js/pull/91601) | **Omit undefined LayoutRouter props** — conditionally built props object | 96 fewer prop serializations, ~1.4KB smaller Flight payload |
| [#91567](https://github.com/vercel/next.js/pull/91567) | **CopyOnWriteSet** — defers `new Set(parent)` until first mutation | 30+ Set allocations saved per request |

### Object Shape / V8 / Headers

| PR | What | Impact |
|---|---|---|
| [#91607](https://github.com/vercel/next.js/pull/91607) | **Pre-computed Vary header** — module-level constants; simplified `addRequestMeta`; hoisted send-payload constants | ~178 function calls + string concat eliminated |
| [#91570](https://github.com/vercel/next.js/pull/91570) | **Tracer early exit** — allowlist check before options parsing; cached tracer instance | Options spread + span creation skipped for filtered spans |
| [#91587](https://github.com/vercel/next.js/pull/91587) | **ALS cache** — cached `getStore()` in create-component-tree and incremental-cache | 20-30 redundant getStore calls eliminated |
| [#91625](https://github.com/vercel/next.js/pull/91625) | **Response writer** — lazy drained promise; `hideSpan` on startResponse trace; cached flush check | Promise + event listener + per-chunk checks eliminated |

---

## Architecture — Request Processing Pipeline

```
Request → HTTP Parse → Route Match → [Cache Check] → Component Tree → React Flight → React Fizz → Stream Transforms → Response Write
           (kernel)     (routing)     (manifests)      (createElement)   (serialize)    (HTML)      (buffer+head+data)    (socket)
            16μs          23μs          0μs*             147μs            ~400μs         ~400μs        56μs**                38μs
```

\* Manifests cached per route after first request
\** 56μs with WhatWG streams; ~15μs with native node streams (behind flag)

---

## How to Use

### In Next.js repo (benchmarking)
```bash
git checkout perf/all-improvements
rm -rf packages/next/dist
pnpm --filter=next build
cd bench/app-router-server
node ../../packages/next/dist/bin/next build
PORT=3199 node ../next-minimal-server/bin/minimal-server.js
# In another terminal:
autocannon -d 10 -c 50 http://localhost:3199/rsc
```

### In external project
```bash
# Symlink to use the optimized build
rm node_modules/next
ln -s /path/to/next.js/packages/next node_modules/next
```

### Native Node.js Streams (experimental)
```js
// next.config.js
module.exports = {
  experimental: {
    useNodeStreams: true,
  },
}
```

---

## What's Left (not framework-addressable)

| Category | CPU % | Notes |
|---|---|---|
| React RSC rendering | ~44% | Flight serialization + Fizz HTML generation |
| V8/GC/microtasks | ~15% | Garbage collection + promise scheduling |
| Kernel I/O | ~5% | HTTP parsing + socket writes |
| WhatWG Streams | ~9% | Addressable by native node streams (behind flag) |

The framework overhead has been reduced from ~30% to ~5% of total CPU time.
