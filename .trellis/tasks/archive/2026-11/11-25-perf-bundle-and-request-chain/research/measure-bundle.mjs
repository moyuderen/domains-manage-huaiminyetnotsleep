// 测量 Next 16 生产构建里每个路由的首屏 JS 体积，并检查服务端代码是否泄漏进浏览器产物。
// 用法：先在沙箱里执行生产构建，再运行
//   node measure-bundle.mjs <沙箱目录>
// 按路由报告入口 chunk 的 gzip 体积；依赖指纹另标记是否出现在入口中。
// 退出码：0 表示通过；1 表示有 chunk 含服务端专属代码（Supabase 客户端 / next/cache）。

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import zlib from 'node:zlib'
import process from 'node:process'
import console from 'node:console'

const sandbox = process.argv[2]
if (!sandbox) {
  console.error('用法: node measure-bundle.mjs <沙箱目录>')
  process.exit(2)
}
const nextDir = path.join(sandbox, '.next')
if (!fs.existsSync(path.join(nextDir, 'BUILD_ID'))) {
  console.error(`在 ${nextDir} 找不到生产构建，请先在沙箱里执行 next build`)
  process.exit(2)
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)}KB`

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (/page_client-reference-manifest\.js$/.test(entry.name)) out.push(full)
  }
  return out
}

function loadManifest(file) {
  const sandboxScope = { globalThis: {} }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandboxScope)
  const key = Object.keys(sandboxScope.globalThis.__RSC_MANIFEST)[0]
  return { key, manifest: sandboxScope.globalThis.__RSC_MANIFEST[key] }
}

const gzCache = new Map()
function gzipSize(file) {
  if (!gzCache.has(file)) {
    const abs = path.join(nextDir, file.replace('/_next/', ''))
    gzCache.set(file, fs.existsSync(abs) ? zlib.gzipSync(fs.readFileSync(abs), { level: 9 }).length : 0)
  }
  return gzCache.get(file)
}

function sumGzip(files) {
  return files.reduce((total, file) => total + gzipSize(file), 0)
}

const SIGNATURES = {
  'supabase 客户端': /GoTrueClient|PostgrestClient|RealtimeClient|postgrest-js|gotrue/,
  'next/cache': /unstable_cache/,
  'service-role 环境变量名': /SUPABASE_SERVICE_ROLE_KEY/,
  'framer-motion': /AnimatePresence|useReducedMotion|MotionConfig/,
  zod: /ZodError/,
  'react-hook-form': /shouldUnregister/,
  'react-day-picker': /rdp-/,
  recharts: /CartesianGrid|recharts/,
}

function readText(file) {
  return fs.readFileSync(path.join(nextDir, file.replace('/_next/', '')), 'utf8')
}

const SERVER_ONLY = ['supabase 客户端', 'next/cache', 'service-role 环境变量名']
const LIBRARY_KEYS = Object.keys(SIGNATURES).filter((name) => !SERVER_ONLY.includes(name))

const routes = []
for (const file of walk(path.join(nextDir, 'server', 'app'))) {
  const { key, manifest } = loadManifest(file)
  if (/\/_not-found|_global-error|\/api\//.test(key)) continue
  const entryFiles = [...new Set(Object.values(manifest.entryJSFiles).flat())].map((f) => '/_next/' + f)
  routes.push({ key, entryFiles, gzipBytes: sumGzip(entryFiles) })
}
routes.sort((a, b) => b.gzipBytes - a.gzipBytes)

const routeLabel = (key) => key.replace(/\/page$/, '').replace(/^\/\((main|auth)\)/, '') || '/'
console.log('=== 首屏 JS（入口 chunk，gzip） ===')
console.log('路由'.padEnd(28), '首屏合计'.padEnd(11), '入口 chunk 数')
for (const route of routes) {
  console.log(routeLabel(route.key).padEnd(28), kb(route.gzipBytes).padEnd(11), String(route.entryFiles.length))
}

console.log('\n=== 各路由的入口 chunk 里出现了哪些库 ===')
for (const route of routes) {
  const entryText = route.entryFiles.map(readText).join('\n')
  const inEntry = LIBRARY_KEYS.filter((name) => SIGNATURES[name].test(entryText))
  console.log(routeLabel(route.key).padEnd(28), '入口:', inEntry.join('、') || '无')
}

// 动态 import 拆出的文件并不保证出现在 RSC manifest 中，故单独扫描全量 JS。
const entryRoutesByFile = new Map()
for (const route of routes) {
  for (const f of route.entryFiles) {
    if (!entryRoutesByFile.has(f)) entryRoutesByFile.set(f, [])
    entryRoutesByFile.get(f).push(routeLabel(route.key))
  }
}
console.log('\n=== 各库分布在哪些 chunk ===')
const chunkDir = path.join(nextDir, 'static', 'chunks')
const chunks = fs.readdirSync(chunkDir).filter((name) => name.endsWith('.js')).map((name) => {
  const file = `static/chunks/${name}`
  const text = readText(file)
  return { name, file, text, gz: gzipSize('/_next/' + file), routes: entryRoutesByFile.get('/_next/' + file) ?? [] }
})
for (const lib of Object.keys(SIGNATURES)) {
  const hits = chunks.filter((chunk) => SIGNATURES[lib].test(chunk.text))
  if (!hits.length) continue
  console.log(`${lib}:`)
  for (const chunk of hits) {
    console.log(`  ${chunk.name.padEnd(24)} ${kb(chunk.gz).padEnd(10)} ${chunk.routes.length ? `入口于 ${[...new Set(chunk.routes)].join('、')}` : '按需加载'}`)
  }
}

console.log('\n=== 服务端专属代码检查 ===')
let leaked = false
for (const chunk of chunks) {
  for (const lib of SERVER_ONLY) {
    if (SIGNATURES[lib].test(chunk.text)) {
      leaked = true
      console.log(`  ✗ static/chunks/${chunk.name} 含 ${lib}`)
    }
  }
}
console.log(leaked ? '  结论：浏览器产物中存在服务端专属代码' : '  结论：未发现服务端专属代码进入浏览器产物')
process.exit(leaked ? 1 : 0)
