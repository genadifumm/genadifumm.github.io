// שומר בטלפון רק את הדף העוטף (cards.html), כדי שייפתח מיד וגם בלי קליטה. אין כאן נתונים.
// פותחים מהעותק, ובמקביל מביאים גרסה חדשה לפעם הבאה.
var C = "cards-shell-v1";
self.addEventListener("install", function (e) { self.skipWaiting(); e.waitUntil(caches.open(C).then(function (c) { return c.add("cards.html"); })); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) {
  var u = new URL(e.request.url);
  if (u.origin !== location.origin || !/\/cards\.html$/.test(u.pathname)) return;
  e.respondWith(caches.open(C).then(function (c) {
    return c.match("cards.html").then(function (hit) {
      var net = fetch("cards.html", { cache: "no-store" }).then(function (r) { if (r.ok) c.put("cards.html", r.clone()); return r; });
      return hit || net;
    });
  }));
});
