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
  didFindRootLayout: boolean,
  needsInstantConfig: boolean
): Promise<FlightRouterState> {
  const [segment, parallelRoutes, { layout, loading, page }] = loaderTree
  const dynamicParam = getDynamicParamFromSegment(loaderTree)
  const treeSegment = dynamicParam ? dynamicParam.treeSegment : segment

  const segmentTree: FlightRouterState = [
    addSearchParamsIfPageSegment(treeSegment, searchParams),
    {},
  ]

  // Only load the module when cacheComponents is enabled (i.e. unstable_instant
  // could be exported). Otherwise skip the import entirely — on cold start this
  // avoids loading every segment's layout/page module just to read a config flag
  // that doesn't exist.
  const modPromise = needsInstantConfig
    ? layout
      ? layout[0]()
      : page
        ? page[0]()
        : Promise.resolve(undefined)
    : Promise.resolve(undefined)

  // Kick off module loading and all child tree traversals concurrently.
  const parallelRouteKeys = Object.keys(parallelRoutes)
  const childPromises = parallelRouteKeys.map((key) =>
    createFlightRouterStateFromLoaderTreeImpl(
      parallelRoutes[key],
      getDynamicParamFromSegment,
      searchParams,
      didFindRootLayout || typeof layout !== 'undefined',
      needsInstantConfig
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
  searchParams: any,
  cacheComponents?: boolean
): Promise<FlightRouterState> {
  const didFindRootLayout = false
  // Only load modules for instant config when cacheComponents is enabled,
  // since unstable_instant requires cacheComponents.
  const needsInstantConfig = !!cacheComponents
  return createFlightRouterStateFromLoaderTreeImpl(
    loaderTree,
    getDynamicParamFromSegment,
    searchParams,
    didFindRootLayout,
    needsInstantConfig
  )
}

export async function createRouteTreePrefetch(
  loaderTree: LoaderTree,
  getDynamicParamFromSegment: GetDynamicParamFromSegment,
  cacheComponents?: boolean
): Promise<FlightRouterState> {
  // Search params should not be added to page segment's cache key during a
  // route tree prefetch request, because they do not affect the structure of
  // the route. The client cache has its own logic to handle search params.
  const searchParams = {}
  const didFindRootLayout = false
  const needsInstantConfig = !!cacheComponents
  return createFlightRouterStateFromLoaderTreeImpl(
    loaderTree,
    getDynamicParamFromSegment,
    searchParams,
    didFindRootLayout,
    needsInstantConfig
  )
}
