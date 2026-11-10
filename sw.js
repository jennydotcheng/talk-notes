// Keeps the app available with no internet, and adds the headers that let the
// speech models use several processor cores.
const V = 'talk-notes-v1';
const SHELL = [
  './', 'index.html', 'app.js', 'worker.js', 'rec-worklet.js', 'manifest.webmanifest',
  'icon-192.png', 'icon-512.png', 'apple-touch-icon.png',
  'vendor/transformers.min.js',
  'vendor/ort-wasm-simd-threaded.jsep.mjs',
  'vendor/ort-wasm-simd-threaded.jsep.wasm',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(V).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('talk-notes-') && k !== V).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isolate(res) {
  if (!res || res.status === 0) return res;
  const h = new Headers(res.headers);
  h.set('Cross-Origin-Opener-Policy', 'same-origin');
  h.set('Cross-Origin-Embedder-Policy', 'require-corp');
  h.set('Cross-Origin-Resource-Policy', 'same-origin');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

async function fromCache(req) {
  const c = await caches.open(V);
  return (await c.match(req, { ignoreSearch: true })) || (req.mode === 'navigate' ? c.match('index.html') : undefined);
}

async function handle(req) {
  const url = new URL(req.url);
  const big = url.pathname.includes('/vendor/');
  if (big) {
    const hit = await fromCache(req);
    if (hit) return isolate(hit);
  }
  try {
    const res = await fetch(req);
    if (res.ok) { const c = await caches.open(V); c.put(req, res.clone()); }
    return isolate(res);
  } catch (err) {
    const hit = await fromCache(req);
    if (hit) return isolate(hit);
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return; // model downloads go straight through
  e.respondWith(handle(req));
});
