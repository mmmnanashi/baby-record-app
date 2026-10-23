// オフラインでもアプリを開けるようにするための Service Worker
// アプリを更新したら VERSION の数字を上げてください。
const VERSION = 'v1';
const CACHE = 'babylog-' + VERSION;
const SHELL = ['./', './index.html', './app.js', './icons.js', './firebase-config.js', './manifest.webmanifest', './icon.svg', './icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request;
  if(req.method !== 'GET') return;
  const url = new URL(req.url);
  // Firebase SDK 本体（バージョン固定なのでキャッシュ優先）
  if(url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')){
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res;
    })));
    return;
  }
  // 自分のファイル：ネット優先（更新がすぐ反映）、つながらない時はキャッシュ
  if(url.origin === location.origin){
    e.respondWith(fetch(req).then(res => {
      const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); return res;
    }).catch(() => caches.match(req).then(hit => hit || caches.match('./index.html'))));
  }
  // それ以外（Firestore・ログインなど）は SDK に任せる
});
