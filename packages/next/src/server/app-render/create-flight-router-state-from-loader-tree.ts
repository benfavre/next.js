import type { LoaderTree } from '../lib/app-dir-module'
import {
  PrefetchHint,
  type FlightRouterState,
} from '../../shared/lib/app-router-types'
import type { GetDynamicParamFromSegment } from './app-render'
import { addSearchParamsIfPageSegment } from '../../shared/lib/segment'
import type { AppSegmentConfig } from '../../build/segment-config/app/app-segment-config'

async function createFlightRouterStateFromLoaderTreeImpl(
  loaderTree: LoaderTree,
  getDynamicParamFromSegment: GetDynamicParamFromSegment,
  searchParams: any,
  didFindRootLayout: boolean
): Promise<FlightRouterState> {
  const [segment, parallelRoutes, { layout, loading, page }] = loaderTree
  const dynamicParam = getDynamicParamFromSegment(loaderTree)
  const treeSegment = dynamicParam ? dynamicParam.treeSegment : segment

  const segmentTree: FlightRouterState = [
    addSearchParamsIfPageSegment(treeSegment, searchParams),
    {},
  ]

  // Kick off module loading and all child tree traversals concurrently.
  // Previously these were sequential: module load blocked children, and
  // children were awaited one-by-one in a for...in loop. On cold start
  // with many segments this caused cascading awaits for module loading.
  const modPromise = layout
    ? layout[0]()
    : page
      ? page[0]()
      : Promise.resolve(undefined)

  const parallelRouteKeys = Object.keys(parallelRoutes)
  const childPromises = parallelRouteKeys.map((key) =>
    createFlightRouterStateFromLoaderTreeImpl(
      parallelRoutes[key],
      getDynamicParamFromSegment,
      searchParams,
      didFindRootLayout || typeof layout !== 'undefined'
    )
  )

  // Await module and all children in parallel
  const [mod, ...childResults] = await Promise.all([
    modPromise,
    ...childPromises,
  ])

  const instantConfig = mod
    ? (mod as AppSegmentConfig).unstable_instant
    : undefined
  let prefetchHints = 0

  // Mark the first segment that has a layout as the "root" layout
  if (!didFindRootLayout && typeof layout !== 'undefined') {
    prefetchHints |= PrefetchHint.IsRootLayout
  }

  if (instantConfig && typeof instantConfig === 'object') {
    prefetchHints |= PrefetchHint.SubtreeHasInstant
    if (instantConfig.prefetch === 'runtime') {
      prefetchHints |= PrefetchHint.HasRuntimePrefetch
    }
  }

  // Check if this segment has a loading boundary
  if (loading) {
    prefetchHints |= PrefetchHint.SegmentHasLoadingBoundary
  }

  const children: FlightRouterState[1] = {}
  for (let i = 0; i < parallelRouteKeys.length; i++) {
    const child = childResults[i]
    // Propagate subtree flags from children
    if (child[4] !== undefined) {
      prefetchHints |=
        child[4] &
        (PrefetchHint.SubtreeHasInstant |
          PrefetchHint.SubtreeHasLoadingBoundary)
      // If a child has a loading boundary (either directly or in its subtree),
      // propagate that as SubtreeHasLoadingBoundary to this segment.
      if (
        child[4] &
        (PrefetchHint.SegmentHasLoadingBoundary |
          PrefetchHint.SubtreeHasLoadingBoundary)
      ) {
        prefetchHints |= PrefetchHint.SubtreeHasLoadingBoundary
      }
    }
    children[parallelRouteKeys[i]] = child
  }
  segmentTree[1] = children

  if (prefetchHints !== 0) {
    segmentTree[4] = prefetchHints
  }

  return segmentTree
}

export async function createFlightRouterStateFromLoaderTree(
  loaderTree: LoaderTree,
  getDynamicParamFromSegment: GetDynamicParamFromSegment,
  searchParams: any
): Promise<FlightRouterState> {
  const didFindRootLayout = false
  return createFlightRouterStateFromLoaderTreeImpl(
    loaderTree,
    getDynamicParamFromSegment,
    searchParams,
    didFindRootLayout
  )
}

export async function createRouteTreePrefetch(
  loaderTree: LoaderTree,
  getDynamicParamFromSegment: GetDynamicParamFromSegment
): Promise<FlightRouterState> {
  // Search params should not be added to page segment's cache key during a
  // route tree prefetch request, because they do not affect the structure of
  // the route. The client cache has its own logic to handle search params.
  const searchParams = {}
  const didFindRootLayout = false
  return createFlightRouterStateFromLoaderTreeImpl(
    loaderTree,
    getDynamicParamFromSegment,
    searchParams,
    didFindRootLayout
  )
}
