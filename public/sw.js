const V="procinity-v3";
self.addEventListener("install",e=>{self.skipWaiting();e.waitUntil(caches.open(V).then(c=>Promise.all(["./","index.html","auth.js","manifest.webmanifest"].map(u=>fetch(u,{cache:"no-cache"}).then(r=>r.ok?c.put(u,r):null)))).catch(()=>{}))});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==V).map(x=>caches.delete(x)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",e=>{if(e.request.method!=="GET")return;const u=new URL(e.request.url);if(u.origin!==location.origin||u.pathname.startsWith("/api/"))return;
if(u.pathname.includes("/images/")){e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(n=>{const cp=n.clone();caches.open(V).then(c=>c.put(e.request,cp));return n})))}
else{e.respondWith(fetch(e.request,{cache:"no-cache"}).then(n=>{const cp=n.clone();caches.open(V).then(c=>c.put(e.request,cp));return n}).catch(()=>caches.match(e.request).then(r=>r||caches.match("index.html"))))}});
