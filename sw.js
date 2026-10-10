/* Cache the public shell only. Household data and runtime configuration stay online. */
const CACHE = 'household-shell-v0.1.18';
const SHELL = ['./', './?v=0.1.18', './index.html', './index.html?v=0.1.18', './web/style.css?v=0.1.18', './web/app.js?v=0.1.18', './web/update.js?v=0.1.18', './web/transport.js', './web/session.js', './shared/domain.js?v=0.1.18', './manifest.webmanifest', './assets/icon.svg', './assets/icon-192.png', './assets/icon-512.png', './assets/apple-touch-icon.png'];
const SHELL_URLS = new Set(SHELL.map(path => new URL(path, self.registration.scope).href));
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL.map(path => new Request(new URL(path, self.registration.scope), {cache: 'reload'}))))));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('household-shell-') && key !== CACHE).map(key => caches.delete(key))))));
self.addEventListener('message', event => {if (event.data?.type === 'ACTIVATE_UPDATE') self.skipWaiting();});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url), root = new URL('./', self.registration.scope), index = new URL('./index.html', self.registration.scope);
  const releaseNavigation = event.request.mode === 'navigate' && url.origin === root.origin && (url.pathname === root.pathname || url.pathname === index.pathname) && /^\?v=\d+\.\d+\.\d+$/.test(url.search);
  if (event.request.method !== 'GET' || (!SHELL_URLS.has(event.request.url) && !releaseNavigation)) return;
  event.respondWith(fetch(event.request, {cache: 'no-cache'}).then(response => {
    if (response.ok && response.type === 'basic') { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); }
    return response;
  }).catch(async () => (await caches.match(event.request)) || (releaseNavigation ? caches.match(index.href) : undefined)));
});
