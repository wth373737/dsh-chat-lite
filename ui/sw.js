// dsh-chat-lite Service Worker：离线壳 + 最近 3 天数据缓存
'use strict'

const VERSION = 'v2'
const SHELL_CACHE = 'chat-lite-shell-' + VERSION
const API_CACHE = 'chat-lite-api-' + VERSION
const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000 // 最近 3 天

const SHELL_ASSETS = [
  './',
  'ui/index.html',
  'ui/app.css',
  'ui/app.js',
  'ui/manifest.webmanifest',
  'ui/icon-192.png',
  'ui/icon-512.png',
]

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) =>
      Promise.allSettled(SHELL_ASSETS.map((asset) => cache.add(new Request(asset, { cache: 'reload' })))),
    ).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== SHELL_CACHE && key !== API_CACHE)
          .map((key) => caches.delete(key)),
      ),
    ).then(() => self.clients.claim()),
  )
})

/** 清理超过 3 天的 API 缓存。 */
async function purgeOld() {
  const cache = await caches.open(API_CACHE)
  const requests = await cache.keys()
  const now = Date.now()
  for (const request of requests) {
    const response = await cache.match(request)
    if (!response) continue
    const stored = Number(response.headers.get('x-cached-at') || 0)
    if (!stored || now - stored > MAX_AGE_MS) await cache.delete(request)
  }
}

/** 给响应打上缓存时间戳后写入缓存。 */
async function putWithTime(cache, request, response) {
  const body = await response.clone().arrayBuffer()
  const headers = new Headers(response.headers)
  headers.set('x-cached-at', String(Date.now()))
  await cache.put(request, new Response(body, { status: response.status, headers }))
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  // 图片：缓存优先（内容哈希命名，天然不变）
  if (url.pathname.includes('/api/image')) {
    event.respondWith(
      caches.open(API_CACHE).then(async (cache) => {
        const hit = await cache.match(request)
        if (hit) return hit
        const response = await fetch(request)
        if (response.ok) await putWithTime(cache, request, response)
        return response
      }).catch(() => new Response('', { status: 504 })),
    )
    return
  }

  // 数据接口：网络优先，失败回落缓存（3 天内）
  if (url.pathname.includes('/api/')) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(API_CACHE)
        try {
          const response = await fetch(request)
          if (response.ok) await putWithTime(cache, request, response)
          purgeOld()
          return response
        } catch (error) {
          const hit = await cache.match(request)
          if (hit) return hit
          return new Response(JSON.stringify({ ok: false, offline: true, error: '离线且无缓存' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          })
        }
      })(),
    )
    return
  }

  // 壳：网络优先（避免旧前端卡在缓存里），失败回落缓存
  event.respondWith(
    (async () => {
      const cache = await caches.open(SHELL_CACHE)
      try {
        const response = await fetch(request)
        if (response.ok) await cache.put(request, response.clone())
        return response
      } catch {
        const hit = await cache.match(request, { ignoreSearch: true })
        if (hit) return hit
      }
      // 导航请求兜底到首页
      const shell = await cache.match('ui/index.html', { ignoreSearch: true })
      return shell || new Response('离线', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8' } })
    })(),
  )
})
