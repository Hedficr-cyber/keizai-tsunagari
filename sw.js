// アプリのファイルは版ごとにそろえ、ニュースのデータはネットを先に確認する。
const CACHE = "keizai-v0.8.2";
const DATA_CACHE = "keizai-data";
const LATEST = "data/latest.json";
const SHELL = ["./", "index.html", "css/app.css", "css/relationships.css", "css/navigation.css", "js/app.js", "js/graph.js", "js/relationships.js", "js/navigation.js", "js/sheet-gesture.js", "js/versions.js", "data/graph.json", "data/glossary.json", "manifest.webmanifest", "icons/mark.svg"];
const scope = self.registration.scope;
const appURL = path => new URL(path, scope).href;
const dataPath = new URL("data/", scope).pathname;
const latestPath = new URL(LATEST, scope).pathname;
const shellURLs = new Map(SHELL.map(path => [new URL(path, scope).pathname, appURL(path)]));
const VERSION = CACHE.slice("keizai-".length);

async function installRelease() {
  const cache = await caches.open(CACHE);
  await cache.addAll([...SHELL, LATEST].map(path => new Request(appURL(path), { cache: "reload" })));
  const versions = await cache.match(appURL("js/versions.js"));
  const first = (await versions.text()).match(/v:\s*"(v[\d.]+)"/)?.[1];
  // 配信途中などで版がそろっていない場合は、いま動いている版を残す。
  if (first !== VERSION) throw new Error("Incomplete app release");
  await self.skipWaiting();
}
self.addEventListener("install", e => e.waitUntil(installRelease()));
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith("keizai-v") && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener("message", e => {
  if (e.data === "keizai:get-version") e.ports[0]?.postMessage(VERSION);
});

async function latestInfo(response) {
  if (!response?.ok) return null;
  const data = await response.clone().json().catch(() => null);
  if (!Array.isArray(data?.news)) return null;
  const time = Date.parse(data.updated);
  return { time: Number.isFinite(time) ? time : -Infinity, revision: data.revision };
}

async function cachedData(request, latest) {
  const [lastRead, bundled] = await Promise.all([
    caches.match(request, { cacheName: DATA_CACHE }),
    caches.match(latest ? appURL(LATEST) : request, { cacheName: CACHE }),
  ]);
  if (!latest) return lastRead || bundled;

  const [previous, installed] = await Promise.all([latestInfo(lastRead), latestInfo(bundled)]);
  if (!previous) return installed ? bundled : null;
  if (!installed) return lastRead;
  if (installed.time !== previous.time) return installed.time > previous.time ? bundled : lastRead;
  if (Number.isFinite(installed.revision) && Number.isFinite(previous.revision) && installed.revision > previous.revision) return bundled;
  // 同じ時刻で改訂の順番を判定できなければ、通常の取得で最後に保存した内容を使う。
  return lastRead;
}

function fetchData(e, latest) {
  const reply = fetch(e.request, { cache: "no-cache" }).then(async response => {
    if (latest && response.ok && !await latestInfo(response)) return null;
    return response;
  }).catch(() => null);
  e.waitUntil(reply.then(async response => {
    if (!response?.ok) return;
    const copy = response.clone();
    await (await caches.open(DATA_CACHE)).put(e.request, copy);
  }).catch(() => {}));
  e.respondWith(reply.then(async response => {
    if (response?.ok) return response;
    return await cachedData(e.request, latest) || response || Response.error();
  }));
}
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  const shellURL = shellURLs.get(url.pathname);
  if (shellURL) {
    e.respondWith(caches.match(shellURL, { cacheName: CACHE }).then(hit => hit || fetch(e.request)));
  } else if (url.pathname.startsWith(dataPath)) fetchData(e, url.pathname === latestPath);
});
