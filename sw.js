// いつも新しい内容を取りに行き（ネットがあれば最新）、つながらないときだけ手元に保存した分を出す
const CACHE = "keizai-v0.6.2";
const SHELL = ["./", "index.html", "css/app.css", "js/app.js", "js/graph.js", "js/versions.js", "data/graph.json", "data/glossary.json", "data/latest.json", "manifest.webmanifest", "icons/mark.svg"];
self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL.map(u => new Request(u, { cache: "reload" })))).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: "no-cache" })
      .then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match("index.html")))
  );
});
