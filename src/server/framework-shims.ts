import fs from 'node:fs'
import path from 'node:path'

// Projects without a Vite config (Next.js, Create React App…) import things
// Vite can't run in a browser. These plugins stand in for them: next/* modules
// become small browser versions, JSX in .js files compiles, and the public env
// variables those toolchains inline are defined.

type ViteModule = typeof import('vite')

const PREFIX = '\0paperish-shim:'

interface DepMap {
  [dep: string]: string
}

interface Defines {
  [expression: string]: string
}

interface LegacyVite {
  transformWithEsbuild(
    code: string,
    file: string,
    opts: { loader: 'jsx'; jsx: 'automatic' },
  ): Promise<{ code: string; map: unknown }>
}

export function frameworkShims(vite: ViteModule, root: string) {
  const deps = readDeps(root)
  const plugins: unknown[] = []

  if (deps.next) plugins.push(nextPlugin())

  if (deps['react-scripts'] || deps.next) plugins.push(jsxInJsPlugin(vite, root))

  return { plugins, define: envDefines(vite, root) }
}

function readDeps(root: string): DepMap {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

    return { ...pkg.peerDependencies, ...pkg.devDependencies, ...pkg.dependencies }
  } catch {
    return {}
  }
}

function nextPlugin() {
  return {
    name: 'paperish-next-shims',
    enforce: 'pre' as const,
    resolveId(id: string, importer?: string) {
      const bare = id.replace(/\.js$/, '')

      if (!NEXT_SHIMS.has(bare) && bare !== 'next/font/google') return null

      if (bare === 'next/font/google' && importer)
        return `${PREFIX}${bare}?names=${googleFontNames(importer).join(',')}`

      return PREFIX + bare
    },
    load(id: string) {
      if (!id.startsWith(PREFIX)) return null
      const [mod, query] = id.slice(PREFIX.length).split('?')

      if (mod === 'next/font/google')
        return googleFontsModule(new URLSearchParams(query).get('names')?.split(',') ?? [])

      return NEXT_SHIMS.get(mod) ?? 'export default {}'
    },
  }
}

function googleFontNames(importer: string): string[] {
  let src = ''

  try {
    src = fs.readFileSync(importer.split('?')[0], 'utf8')
  } catch {
    return []
  }

  const names = new Set<string>()

  for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']next\/font\/google["']/g))
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0]

      if (/^\w+$/.test(name)) names.add(name)
    }

  return [...names]
}

function googleFontsModule(names: string[]): string {
  return `const load = (family) => (opts = {}) => {
  const weights = [].concat(opts.weight ?? []).filter((w) => w !== 'variable');
  const spec = family.replace(/ /g, '+') + (weights.length ? ':wght@' + weights.sort().join(';') : ':wght@100..900');
  const href = 'https://fonts.googleapis.com/css2?family=' + spec + '&display=swap';
  if (!document.querySelector('link[href="' + href + '"]')) {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }
  const fontFamily = "'" + family + "', " + (opts.fallback ?? ['system-ui', 'sans-serif']).join(', ');
  if (opts.variable) document.documentElement.style.setProperty(opts.variable, fontFamily);
  return { className: '', variable: '', style: { fontFamily } };
};
${names.map((n) => `export const ${n} = load(${JSON.stringify(n.replace(/_/g, ' '))});`).join('\n')}`
}

const IMAGE = `import * as React from 'react';
const Image = React.forwardRef(function Image(props, ref) {
  const { src, alt = '', width, height, fill, sizes, quality, priority, placeholder, blurDataURL, loader, unoptimized, loading, onLoadingComplete, overrideSrc, layout, objectFit, objectPosition, style, ...rest } = props;
  const url = typeof src === 'object' && src ? src.src ?? src.default ?? '' : src;
  const w = width ?? (typeof src === 'object' && src ? src.width : undefined);
  const h = height ?? (typeof src === 'object' && src ? src.height : undefined);
  const filled = fill || layout === 'fill';
  const s = filled ? { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit, objectPosition, ...style } : { objectFit, objectPosition, ...style };
  return React.createElement('img', { ...rest, ref, src: loader ? loader({ src: url, width: w, quality }) : url, alt, width: filled ? undefined : w, height: filled ? undefined : h, sizes, loading: priority ? 'eager' : loading ?? 'lazy', decoding: 'async', style: s });
});
export default Image;
export const getImageProps = (props) => ({ props });`

const LINK = `import * as React from 'react';
const toHref = (href) => {
  if (typeof href === 'string' || !href) return href ?? '#';
  const q = href.query ? '?' + new URLSearchParams(href.query).toString() : '';
  return (href.pathname ?? '') + q + (href.hash ? '#' + String(href.hash).replace(/^#/, '') : '');
};
const Link = React.forwardRef(function Link({ href, as, prefetch, replace, scroll, shallow, passHref, locale, legacyBehavior, onNavigate, children, ...rest }, ref) {
  const url = toHref(as ?? href);
  if (legacyBehavior && React.isValidElement(children)) return React.cloneElement(children, { href: url, ref });
  return React.createElement('a', { ...rest, ref, href: url, onClick: (e) => { e.preventDefault(); rest.onClick?.(e); } }, children);
});
export default Link;
export const useLinkStatus = () => ({ pending: false });`

const ROUTER_OBJECT = `const noop = () => {};
const router = { push: async () => true, replace: async () => true, back: noop, forward: noop, refresh: noop, prefetch: async () => {}, reload: noop, beforePopState: noop, pathname: '/', route: '/', asPath: '/', query: {}, basePath: '', isReady: true, isFallback: false, isPreview: false, isLocaleDomain: false, locale: undefined, events: { on: noop, off: noop, emit: noop } };`

const NEXT_SHIMS = new Map([
  ['next/image', IMAGE],
  ['next/legacy/image', IMAGE],
  ['next/link', LINK],
  ['next/head', `export default function Head() { return null; }`],
  ['next/script', `export default function Script() { return null; }`],
  [
    'next/dynamic',
    `import * as React from 'react';
export default function dynamic(loader, opts = {}) {
  const load = typeof loader === 'function' ? loader : loader.loader;
  const Lazy = React.lazy(() => Promise.resolve(load()).then((m) => ({ default: m && m.default ? m.default : m })));
  return function Dynamic(props) {
    return React.createElement(React.Suspense, { fallback: opts.loading ? React.createElement(opts.loading, { isLoading: true }) : null }, React.createElement(Lazy, props));
  };
}`,
  ],
  [
    'next/navigation',
    `${ROUTER_OBJECT}
export const useRouter = () => router;
export const usePathname = () => '/';
export const useSearchParams = () => new URLSearchParams();
export const useParams = () => ({});
export const useSelectedLayoutSegment = () => null;
export const useSelectedLayoutSegments = () => [];
export const useServerInsertedHTML = noop;
export const redirect = noop;
export const permanentRedirect = noop;
export const notFound = noop;
export const forbidden = noop;
export const unauthorized = noop;
export const RedirectType = { push: 'push', replace: 'replace' };`,
  ],
  [
    'next/router',
    `import * as React from 'react';
${ROUTER_OBJECT}
export const useRouter = () => router;
export const withRouter = (C) => (props) => React.createElement(C, { ...props, router });
export default router;`,
  ],
  [
    'next/headers',
    `const store = { get: () => undefined, getAll: () => [], has: () => false, set: () => {}, delete: () => {}, toString: () => '' };
const later = (v) => Object.assign(Promise.resolve(v), v);
export const cookies = () => later(store);
export const headers = () => { const h = new Headers(); return Object.assign(Promise.resolve(h), { get: (k) => h.get(k), has: (k) => h.has(k), forEach: (f) => h.forEach(f) }); };
export const draftMode = () => later({ isEnabled: false, enable: () => {}, disable: () => {} });`,
  ],
  [
    'next/font/local',
    `export default function localFont(opts = {}) {
  const fontFamily = opts.fallback ? opts.fallback.join(', ') : 'system-ui, sans-serif';
  return { className: '', variable: '', style: { fontFamily } };
}`,
  ],
  ['server-only', 'export {}'],
  ['client-only', 'export {}'],
])

function jsxInJsPlugin(vite: ViteModule, root: string) {
  const own = (id: string) =>
    id.startsWith(root + path.sep) && !id.includes(`${path.sep}node_modules${path.sep}`)

  return {
    name: 'paperish-jsx-in-js',
    enforce: 'pre' as const,
    async transform(code: string, id: string) {
      const file = id.split('?')[0]

      if (!file.endsWith('.js') || !own(file) || !/<[A-Za-z>]/.test(code)) return null

      if ('transformWithOxc' in vite) {
        const r = await vite.transformWithOxc(code, file, {
          lang: 'jsx',
          jsx: { runtime: 'automatic' },
        })

        return { code: r.code, map: r.map }
      }

      // SAFETY: Vite versions without transformWithOxc ship transformWithEsbuild.
      const legacy: LegacyVite = vite as never

      const r = await legacy.transformWithEsbuild(code, file, { loader: 'jsx', jsx: 'automatic' })

      return { code: r.code, map: r.map }
    },
  }
}

function envDefines(vite: ViteModule, root: string): Defines {
  const env = vite.loadEnv('development', root, ['NEXT_PUBLIC_', 'REACT_APP_', 'PUBLIC_URL'])

  const define: Defines = {
    'process.env': '{}',
    'process.env.NODE_ENV': JSON.stringify('development'),
    'process.env.PUBLIC_URL': JSON.stringify(env.PUBLIC_URL ?? ''),
  }

  for (const [k, v] of Object.entries(env)) define[`process.env.${k}`] = JSON.stringify(v)

  return define
}
