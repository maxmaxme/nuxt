import type { Ref } from 'vue'
import { computed, defineComponent, h, isReadonly, reactive } from 'vue'
import { isEqual, joinURL, parseQuery, stringifyParsedURL, stringifyQuery, withoutBase } from 'ufo'
import { createError } from 'h3'
import { defineNuxtPlugin, useRuntimeConfig } from '../nuxt'
import { getRouteRules } from '../composables/manifest'
import { clearError, showError } from '../composables/error'
import { navigateTo } from '../composables/router'

// @ts-expect-error virtual file
import { globalMiddleware } from '#build/middleware'
// @ts-expect-error virtual file
import { appManifest as isAppManifestEnabled } from '#build/nuxt.config.mjs'

interface Route {
  /** Percentage encoded pathname section of the URL. */
  path: string
  /** The whole location including the `search` and `hash`. */
  fullPath: string
  /** Object representation of the `search` property of the current location. */
  query: Record<string, any>
  /** Hash of the current location. If present, starts with a `#`. */
  hash: string
  /** Name of the matched record */
  name: string | null | undefined
  /** Object of decoded params extracted from the `path`. */
  params: Record<string, any>
  /**
   * The location we were initially trying to access before ending up
   * on the current location.
   */
  redirectedFrom: Route | undefined
  /** Merged `meta` properties from all of the matched route records. */
  meta: Record<string, any>
  /** compatibility type for vue-router */
  matched: never[]
}

function getRouteFromPath (fullPath: string | Partial<Route>) {
  const route = fullPath && typeof fullPath === 'object' ? fullPath : {}

  if (typeof fullPath === 'object') {
    fullPath = stringifyParsedURL({
      pathname: fullPath.path || '',
      search: stringifyQuery(fullPath.query || {}),
      hash: fullPath.hash || '',
    })
  }

  const url = new URL(fullPath.toString(), import.meta.client ? window.location.href : 'http://localhost')
  return {
    path: url.pathname,
    fullPath,
    query: parseQuery(url.search),
    hash: url.hash,
    // stub properties for compat with vue-router
    params: route.params || {},
    name: undefined,
    matched: route.matched || [],
    redirectedFrom: undefined,
    meta: route.meta || {},
    href: fullPath,
  }
}

type RouteGuardReturn = void | Error | string | boolean

interface RouteGuard {
  (to: Route, from: Route): RouteGuardReturn | Promise<RouteGuardReturn>
}

interface RouterHooks {
  'resolve:before': (to: Route, from: Route) => RouteGuardReturn | Promise<RouteGuardReturn>
  'navigate:before': (to: Route, from: Route) => RouteGuardReturn | Promise<RouteGuardReturn>
  'navigate:after': (to: Route, from: Route) => void | Promise<void>
  'error': (err: any) => void | Promise<void>
}

interface Router {
  currentRoute: Ref<Route>
  isReady: () => Promise<void>
  options: Record<string, unknown>
  install: () => Promise<void>
  // Navigation
  push: (url: string) => Promise<void>
  replace: (url: string) => Promise<void>
  back: () => void
  go: (delta: number) => void
  forward: () => void
  // Guards
  beforeResolve: (guard: RouterHooks['resolve:before']) => () => void
  beforeEach: (guard: RouterHooks['navigate:before']) => () => void
  afterEach: (guard: RouterHooks['navigate:after']) => () => void
  onError: (handler: RouterHooks['error']) => () => void
  // Routes
  resolve: (url: string | Partial<Route>) => Route
  addRoute: (parentName: string, route: Route) => void
  getRoutes: () => any[]
  hasRoute: (name: string) => boolean
  removeRoute: (name: string) => void
}

export default defineNuxtPlugin<{ route: Route, router: Router }>({
  name: 'nuxt:router',
  enforce: 'pre',
  setup (nuxtApp) {
    const initialURL = import.meta.client
      ? withoutBase(window.location.pathname, useRuntimeConfig().app.baseURL) + window.location.search + window.location.hash
      : nuxtApp.ssrContext!.url

    const routes: Route[] = []

    const hooks: { [key in keyof RouterHooks]: RouterHooks[key][] } = {
      'navigate:before': [],
      'resolve:before': [],
      'navigate:after': [],
      'error': [],
    }

    const registerHook = <T extends keyof RouterHooks> (hook: T, guard: RouterHooks[T]) => {
      hooks[hook].push(guard)
      return () => hooks[hook].splice(hooks[hook].indexOf(guard), 1)
    }
    const baseURL = useRuntimeConfig().app.baseURL

    const route: Route = reactive(getRouteFromPath(initialURL))
    async function handleNavigation (url: string | Partial<Route>, replace?: boolean): Promise<void> {
      try {
        // Resolve route
        const to = getRouteFromPath(url)

        // Run beforeEach hooks
        for (const middleware of hooks['navigate:before']) {
          const result = await middleware(to, route)
          // Cancel navigation
          if (result === false || result instanceof Error) { return }
          // Redirect
          if (typeof result === 'string' && result.length) { return handleNavigation(result, true) }
        }

        for (const handler of hooks['resolve:before']) {
          await handler(to, route)
        }
        // Perform navigation
        Object.assign(route, to)
        if (import.meta.client) {
          window.history[replace ? 'replaceState' : 'pushState']({}, '', joinURL(baseURL, to.fullPath))
          if (!nuxtApp.isHydrating) {
            // Clear any existing errors
            await nuxtApp.runWithContext(clearError)
          }
        }
        // Run afterEach hooks
        for (const middleware of hooks['navigate:after']) {
          await middleware(to, route)
        }
      } catch (err) {
        if (import.meta.dev && !hooks.error.length) {
          console.warn('No error handlers registered to handle middleware errors. You can register an error handler with `router.onError()`', err)
        }
        for (const handler of hooks.error) {
          await handler(err)
        }
      }
    }

    const currentRoute = computed(() => route)

    const router: Router = {
      currentRoute,
      isReady: () => Promise.resolve(),
      // These options provide a similar API to vue-router but have no effect
      options: {},
      install: () => Promise.resolve(),
      // Navigation
      push: (url: string) => handleNavigation(url, false),
      replace: (url: string) => handleNavigation(url, true),
      back: () => window.history.go(-1),
      go: (delta: number) => window.history.go(delta),
      forward: () => window.history.go(1),
      // Guards
      beforeResolve: (guard: RouterHooks['resolve:before']) => registerHook('resolve:before', guard),
      beforeEach: (guard: RouterHooks['navigate:before']) => registerHook('navigate:before', guard),
      afterEach: (guard: RouterHooks['navigate:after']) => registerHook('navigate:after', guard),
      onError: (handler: RouterHooks['error']) => registerHook('error', handler),
      // Routes
      resolve: getRouteFromPath,
      addRoute: (parentName: string, route: Route) => { routes.push(route) },
      getRoutes: () => routes,
      hasRoute: (name: string) => routes.some(route => route.name === name),
      removeRoute: (name: string) => {
        const index = routes.findIndex(route => route.name === name)
        if (index !== -1) {
          routes.splice(index, 1)
        }
      },
    }

    nuxtApp.vueApp.component('RouterLink', defineComponent({
      functional: true,
      props: {
        to: {
          type: String,
          required: true,
        },
        custom: Boolean,
        replace: Boolean,
        // Not implemented
        activeClass: String,
        exactActiveClass: String,
        ariaCurrentValue: String,
      },
      setup: (props, { slots }) => {
        const navigate = () => handleNavigation(props.to!, props.replace)
        return () => {
          const route = router.resolve(props.to!)
          return props.custom
            ? slots.default?.({ href: props.to, navigate, route })
            : h('a', { href: props.to, onClick: (e: MouseEvent) => { e.preventDefault(); return navigate() } }, slots)
        }
      },
    }))

    if (import.meta.client) {
      window.addEventListener('popstate', (event) => {
        const location = (event.target as Window).location
        router.replace(location.href.replace(location.origin, ''))
      })
    }

    // @ts-expect-error vue-router types diverge from our Route type above
    nuxtApp._route = route

    // Handle middleware
    nuxtApp._middleware ||= {
      global: [],
      named: {},
    }

    const initialLayout = nuxtApp.payload.state._layout
    nuxtApp.hooks.hookOnce('app:created', async () => {
      router.beforeEach(async (to, from) => {
        to.meta = reactive(to.meta || {})
        if (nuxtApp.isHydrating && initialLayout && !isReadonly(to.meta.layout)) {
          to.meta.layout = initialLayout
        }
        nuxtApp._processingMiddleware = true

        if (import.meta.client || !nuxtApp.ssrContext?.islandContext) {
          const middlewareEntries = new Set<RouteGuard>([...globalMiddleware, ...nuxtApp._middleware.global])

          if (isAppManifestEnabled) {
            const routeRules = await nuxtApp.runWithContext(() => getRouteRules({ path: to.path }))

            if (routeRules.appMiddleware) {
              for (const key in routeRules.appMiddleware) {
                const guard = nuxtApp._middleware.named[key] as RouteGuard | undefined
                if (!guard) { return }

                if (routeRules.appMiddleware[key]) {
                  middlewareEntries.add(guard)
                } else {
                  middlewareEntries.delete(guard)
                }
              }
            }
          }

          for (const middleware of middlewareEntries) {
            const result = await nuxtApp.runWithContext(() => middleware(to, from))
            if (import.meta.server) {
              if (result === false || result instanceof Error) {
                const error = result || createError({
                  statusCode: 404,
                  statusMessage: `Page Not Found: ${initialURL}`,
                  data: {
                    path: initialURL,
                  },
                })
                delete nuxtApp._processingMiddleware
                return nuxtApp.runWithContext(() => showError(error))
              }
            }
            if (result === true) { continue }
            if (result || result === false) { return result }
          }
        }
      })

      router.afterEach(() => { delete nuxtApp._processingMiddleware })

      await router.replace(initialURL)
      if (!isEqual(route.fullPath, initialURL)) {
        await nuxtApp.runWithContext(() => navigateTo(route.fullPath))
      }
    })

    return {
      provide: {
        route,
        router,
      },
    }
  },
})
