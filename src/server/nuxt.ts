import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

// Nuxt apps have no vite.config: Nuxt assembles their Vite setup at runtime,
// with auto-imported composables and components, ~ aliases and an app context
// around every component. This recreates enough of it for one component to
// render alone: the app's own auto-imports (through its unimport), component
// resolution, and small browser stand-ins for Nuxt's runtime and built-ins.

const RUNTIME = 'virtual:paperish-nuxt'

const RUNTIME_ID = '\0paperish-nuxt'

const COMPONENTS_ID = '\0paperish-nuxt-components'

interface AutoImport {
  name: string
  as?: string
  from: string
}

interface NuxtComponent {
  name: string
  file: string
  export: string
}

interface UnimportOptions {
  imports: AutoImport[]
  presets?: 'vue'[]
  dirs?: string[]
  addons: { vueTemplate: boolean }
}

interface UnimportLike {
  init(): Promise<void>
  injectImports(code: string, id: string): Promise<{ code: string; s: { hasChanged(): boolean } }>
}

export function nuxtConfigFile(root: string): string | null {
  for (const f of ['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs', 'nuxt.config.mts'])
    if (fs.existsSync(path.join(root, f))) return path.join(root, f)

  return null
}

/** Nuxt's srcDir: `srcDir` from nuxt.config, else app/ (Nuxt 4 layout), else the root. */
export function nuxtSrcDir(root: string): string {
  const config = readText(nuxtConfigFile(root))
  const explicit = config.match(/\bsrcDir\s*:\s*["']([^"']+)["']/)?.[1]

  if (explicit) return path.resolve(root, explicit)
  const app = path.join(root, 'app')

  return ['app.vue', 'pages', 'components', 'layouts'].some((f) => fs.existsSync(path.join(app, f)))
    ? app
    : root
}

/** Alias prefix -> project-relative directory, as Nuxt defines them. */
export function nuxtAliases(root: string) {
  const src = path.relative(root, nuxtSrcDir(root)).split(path.sep).join('/')
  const srcDir = src ? `${src}/` : './'

  return { '~~/': './', '@@/': './', '~/': srcDir, '@/': srcDir }
}

/** Stylesheets listed in nuxt.config's `css`, as import specifiers. */
export function nuxtCss(root: string): string[] {
  const list = readText(nuxtConfigFile(root)).match(/\bcss\s*:\s*\[([^\]]*)\]/)?.[1] ?? ''
  const aliases = nuxtAliases(root)
  const src = nuxtSrcDir(root)
  const out: string[] = []

  for (const m of list.matchAll(/["']([^"']+)["']/g)) {
    const spec = m[1]
    const alias = Object.entries(aliases).find(([a]) => spec.startsWith(a))

    const candidates = alias
      ? [path.join(root, alias[1], spec.slice(alias[0].length))]
      : [path.resolve(src, spec), path.resolve(root, spec)]

    const file = candidates.find((f) => fs.existsSync(f))

    if (file) out.push(`/${path.relative(root, file).split(path.sep).join('/')}`)
    else if (!alias && !spec.startsWith('.')) out.push(spec)
  }

  return out
}

export async function nuxtPlugins(root: string) {
  const src = nuxtSrcDir(root)
  const components = nuxtComponents(root, src)
  const unimport = await loadUnimport(root, src)

  const appConfig = ['app.config.ts', 'app.config.js']
    .map((f) => path.join(src, f))
    .find((f) => fs.existsSync(f))

  const own = (id: string) =>
    id.startsWith(root + path.sep) && !id.includes(`${path.sep}node_modules${path.sep}`)

  return [
    {
      name: 'paperish-nuxt',
      enforce: 'pre' as const,
      resolveId(id: string) {
        if (id === RUNTIME || /^(#imports|#app|nuxt\/app)(\/|$)|^#build\/app\.config/.test(id))
          return RUNTIME_ID

        if (id === '#components') return COMPONENTS_ID

        return null
      },
      load(id: string) {
        if (id === RUNTIME_ID) return runtimeSource(root, appConfig)

        if (id === COMPONENTS_ID)
          return components
            .map((c) => `export { ${c.export} as ${c.name} } from ${JSON.stringify(c.file)};`)
            .join('\n')

        return null
      },
    },
    {
      name: 'paperish-nuxt-imports',
      enforce: 'post' as const,
      async transform(code: string, id: string) {
        const [file, query = ''] = id.split('?')

        if (!own(file) || !/\.(vue|[cm]?[jt]sx?)$/.test(file)) return null

        if (file.endsWith('.vue') && query && !/type=script/.test(query)) return null
        let out = file.endsWith('.vue') ? resolveComponents(code, components) : code

        if (unimport) {
          const r = await unimport.injectImports(out, id)

          if (r.s.hasChanged()) out = r.code
        }

        return out === code ? null : { code: out, map: null }
      },
    },
  ]
}

/** `_resolveComponent("BaseButton")` in compiled templates -> an import of that component. */
function resolveComponents(code: string, components: NuxtComponent[]): string {
  const byName = new Map(components.map((c) => [c.name.toLowerCase(), c]))
  const imports: string[] = []

  const out = code.replace(
    /\b_?resolveComponent\(\s*["']([\w-]+)["']\s*(?:,\s*true\s*)?\)/g,
    (m, raw: string) => {
      const key = raw.replace(/-/g, '').toLowerCase()
      const c = byName.get(key) ?? byName.get(key.replace(/^lazy/, ''))

      if (!c) return m
      const local = `__pw_nuxt_${imports.length}`
      imports.push(`import { ${c.export} as ${local} } from ${JSON.stringify(c.file)};`)

      return local
    },
  )

  return imports.length ? `${imports.join('\n')}\n${out}` : code
}

/** The app's components: from .nuxt/components.d.ts when Nuxt has run, else components/. */
function nuxtComponents(root: string, src: string): NuxtComponent[] {
  const out: NuxtComponent[] = []
  const dts = readText(path.join(root, '.nuxt/components.d.ts'))

  for (const m of dts.matchAll(
    /^\s*(?:export const )?['"]?(\w+)['"]?\s*:\s*typeof import\(["']([^"']+)["']\)\[['"](\w+)['"]\]/gm,
  )) {
    const file = path.resolve(root, '.nuxt', m[2])

    if (!file.includes(`${path.sep}node_modules${path.sep}nuxt${path.sep}`))
      out.push({ name: m[1], file, export: m[3] })
  }

  if (!dts) {
    const walk = (dir: string, prefix: string[]) => {
      let entries: fs.Dirent[] = []

      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {}

      for (const e of entries) {
        if (e.isDirectory()) walk(path.join(dir, e.name), [...prefix, pascal(e.name)])
        else if (e.name.endsWith('.vue')) {
          const base = path.basename(e.name, '.vue')
          let name = base === 'index' ? '' : pascal(base)

          for (const p of prefix.toReversed()) if (!name.startsWith(p)) name = p + name
          out.push({ name, file: path.join(dir, e.name), export: 'default' })
        }
      }
    }

    walk(path.join(src, 'components'), [])
  }

  for (const name of BUILTINS) out.push({ name, file: RUNTIME, export: name })

  return [...new Map(out.toReversed().map((c) => [c.name.toLowerCase(), c])).values()]
}

/** The project's unimport (a Nuxt dependency) loaded with the app's auto-imports. */
async function loadUnimport(root: string, src: string): Promise<UnimportLike | null> {
  try {
    const nuxt = createRequire(path.join(root, 'package.json')).resolve('nuxt/package.json')
    const entry = createRequire(nuxt).resolve('unimport')

    // SAFETY: the resolved unimport entry exports createUnimport.
    const { createUnimport } = (await import(pathToFileURL(entry).href)) as {
      createUnimport(opts: UnimportOptions): UnimportLike
    }

    const generated = generatedImports(root)

    const ctx = createUnimport(
      generated
        ? { imports: generated, addons: { vueTemplate: true } }
        : {
            imports: RUNTIME_EXPORTS.map((name) => ({ name, from: RUNTIME })),
            presets: ['vue'],
            dirs: [path.join(src, 'composables'), path.join(src, 'utils')],
            addons: { vueTemplate: true },
          },
    )

    await ctx.init()

    return ctx
  } catch (e) {
    // SAFETY: module resolution and unimport setup throw Error instances.
    console.warn(`[paperish] Nuxt auto-imports unavailable for ${root}:`, (e as Error).message)

    return null
  }
}

/** Auto-imports Nuxt generated for this app, with its runtime swapped for ours. */
function generatedImports(root: string): AutoImport[] | null {
  const dts = readText(path.join(root, '.nuxt/imports.d.ts'))

  if (!dts) return null
  const runtime = new Set(RUNTIME_EXPORTS)
  const out: AutoImport[] = []

  for (const m of dts.matchAll(/export\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
    const from = m[2]
    const nuxt = from.startsWith('#') || from.startsWith('nuxt/')

    for (const part of m[1].split(',')) {
      const [name, as] = part.trim().split(/\s+as\s+/)

      if (!name || name.startsWith('type ')) continue

      if (nuxt) {
        if (runtime.has(as ?? name)) out.push({ name: as ?? name, from: RUNTIME })
      } else
        out.push({
          name,
          as,
          from: from.startsWith('.') ? path.resolve(root, '.nuxt', from) : from,
        })
    }
  }

  return out
}

function runtimeSource(root: string, appConfig: string | undefined): string {
  const pinia = fs.existsSync(path.join(root, 'node_modules/pinia/package.json'))

  return [
    appConfig ? `import appConfigFile from ${JSON.stringify(appConfig)};` : '',
    pinia
      ? `import { createPinia, setActivePinia } from 'pinia';\nsetActivePinia(createPinia());`
      : '',
    RUNTIME_SOURCE.replace('__APP_CONFIG__', appConfig ? 'appConfigFile' : '{}'),
  ].join('\n')
}

const RUNTIME_SOURCE = `import { ref, reactive, computed, defineComponent, h } from 'vue';
export * from 'vue';
const noop = () => {};
const route = reactive({ path: '/', fullPath: '/', href: '/', name: undefined, params: {}, query: {}, hash: '', meta: {}, matched: [], redirectedFrom: undefined });
const router = { currentRoute: computed(() => route), options: {}, push: async () => {}, replace: async () => {}, back: noop, forward: noop, go: noop, resolve: (to) => ({ ...route, href: typeof to === 'string' ? to : (to && to.path) || '/' }), beforeEach: () => noop, afterEach: () => noop, onError: () => noop, isReady: async () => {}, hasRoute: () => false, getRoutes: () => [], addRoute: () => noop, removeRoute: noop };
const config = reactive({ public: {}, app: { baseURL: '/', buildAssetsDir: '/_nuxt/', cdnURL: '' } });
const appConfig = reactive(__APP_CONFIG__);
const nuxtApp = { $config: config, payload: { data: {}, state: {} }, static: { data: {} }, isHydrating: false, provide: noop, hook: () => noop, callHook: async () => {}, runWithContext: (fn) => fn(), versions: {} };
const states = {};
const lastObject = (args) => { const a = args[args.length - 1]; return a && typeof a === 'object' && !Array.isArray(a) ? a : {}; };
const asyncData = (args) => { const opts = lastObject(args); const r = { data: ref(opts.default ? opts.default() : null), pending: ref(false), status: ref('success'), error: ref(null), refresh: async () => {}, execute: async () => {}, clear: noop }; return Object.assign(Promise.resolve(r), r); };
export function defineAppConfig(c) { return c; }
export const useRoute = () => route;
export const useRouter = () => router;
export const navigateTo = async () => {};
export const abortNavigation = noop;
export const addRouteMiddleware = noop;
export const defineNuxtRouteMiddleware = (m) => m;
export const setPageLayout = noop;
export const onBeforeRouteLeave = noop;
export const onBeforeRouteUpdate = noop;
export const definePageMeta = noop;
export const defineRouteRules = noop;
export const useState = (key, init) => { if (typeof key === 'function') { init = key; key = undefined; } if (key === undefined) return ref(init ? init() : undefined); return states[key] || (states[key] = ref(init ? init() : undefined)); };
export const clearNuxtState = noop;
export const useCookie = (_name, opts = {}) => ref(opts.default ? opts.default() : undefined);
export const refreshCookie = noop;
export const useRuntimeConfig = () => config;
export const useAppConfig = () => appConfig;
export const updateAppConfig = (c) => Object.assign(appConfig, c);
export const defineNuxtPlugin = (p) => p;
export const definePayloadPlugin = (p) => p;
export const defineNuxtComponent = (c) => defineComponent(c);
export const useNuxtApp = () => nuxtApp;
export const tryUseNuxtApp = () => nuxtApp;
export const useFetch = (...args) => asyncData(args);
export const useLazyFetch = useFetch;
export const useAsyncData = (...args) => asyncData(args);
export const useLazyAsyncData = useAsyncData;
export const useNuxtData = () => ({ data: ref(null) });
export const refreshNuxtData = async () => {};
export const clearNuxtData = noop;
export const $fetch = Object.assign(async () => null, { raw: async () => ({ _data: null }), create: () => $fetch });
globalThis.$fetch = globalThis.$fetch || $fetch;
export const useHead = noop;
export const useHeadSafe = noop;
export const useServerHead = noop;
export const useServerHeadSafe = noop;
export const useSeoMeta = noop;
export const useServerSeoMeta = noop;
export const injectHead = () => ({ push: noop });
export const useRequestHeaders = () => ({});
export const useRequestHeader = () => undefined;
export const useRequestEvent = () => undefined;
export const useRequestFetch = () => $fetch;
export const useRequestURL = () => new URL(location.href);
export const setResponseStatus = noop;
export const useError = () => ref(null);
export const createError = (e) => Object.assign(new Error(typeof e === 'string' ? e : e.message || e.statusMessage), typeof e === 'object' ? e : {});
export const showError = noop;
export const clearError = async () => {};
export const isNuxtError = () => false;
export const useLoadingIndicator = () => ({ progress: ref(0), isLoading: ref(false), error: ref(false), start: noop, finish: noop, set: noop, clear: noop });
export const onNuxtReady = (fn) => setTimeout(fn);
export const callOnce = async (key, fn) => (typeof key === 'function' ? key : fn)();
export const reloadNuxtApp = noop;
export const isPrerendered = () => false;
export const preloadComponents = async () => {};
export const prefetchComponents = async () => {};
export const preloadRouteComponents = async () => {};
const slot = (name) => defineComponent({ name, setup: (_, { slots }) => () => slots.default ? slots.default() : null });
const empty = (name) => defineComponent({ name, setup: () => () => null });
export const NuxtLink = defineComponent({
  name: 'NuxtLink',
  props: ['to', 'href', 'target', 'rel', 'noRel', 'external', 'activeClass', 'exactActiveClass', 'ariaCurrentValue', 'prefetch', 'noPrefetch', 'prefetchOn', 'replace', 'custom', 'trailingSlash'],
  setup(props, { slots }) {
    return () => {
      const to = props.to ?? props.href;
      const href = typeof to === 'string' ? to : (to && to.path) || '#';
      if (props.custom && slots.default) return slots.default({ href, route, navigate: noop, isActive: false, isExactActive: false });
      return h('a', { href, target: props.target, rel: props.rel, onClick: (e) => e.preventDefault() }, slots.default ? slots.default() : undefined);
    };
  },
});
export const NuxtImg = defineComponent({ name: 'NuxtImg', inheritAttrs: false, setup: (_, { attrs }) => () => h('img', attrs) });
export const NuxtPicture = NuxtImg;
export const NuxtTime = defineComponent({ name: 'NuxtTime', props: ['datetime', 'locale'], setup: (p) => () => h('time', { datetime: String(p.datetime) }, new Date(p.datetime).toLocaleString(p.locale)) });
export const ClientOnly = slot('ClientOnly');
export const DevOnly = slot('DevOnly');
export const NuxtLayout = slot('NuxtLayout');
export const NuxtErrorBoundary = slot('NuxtErrorBoundary');
export const NuxtPage = empty('NuxtPage');
export const NuxtWelcome = empty('NuxtWelcome');
export const NuxtLoadingIndicator = empty('NuxtLoadingIndicator');
export const NuxtRouteAnnouncer = empty('NuxtRouteAnnouncer');
export const NuxtAnnouncer = empty('NuxtAnnouncer');
export const Head = empty('Head');
export const Title = empty('Title');
export const Meta = empty('Meta');
export const Style = empty('Style');
export const Base = empty('Base');
export const NoScript = empty('NoScript');
export const Html = empty('Html');
export const Body = empty('Body');
export default appConfig;`

const EXPORTED = [...RUNTIME_SOURCE.matchAll(/^export (?:const|function) (\$?\w+)/gm)].map(
  (m) => m[1],
)

const BUILTINS = EXPORTED.filter((n) => /^[A-Z]/.test(n))

const RUNTIME_EXPORTS = EXPORTED.filter((n) => !/^[A-Z]/.test(n))

function readText(file: string | null): string {
  try {
    return file ? fs.readFileSync(file, 'utf8') : ''
  } catch {
    return ''
  }
}

function pascal(s: string): string {
  return s.replace(/(^|[-_ .]+)(\w)/g, (_m, _s, c: string) => c.toUpperCase())
}
