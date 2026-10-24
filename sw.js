
const CACHE_NAME = "digital-notebook-v4";

const URLS_TO_CACHE = [
  "./",
  "./index.html",
  "./dashboard.js",
  "./add-transaction.html",
  "./add-income.html",
  "./add-saving.html",
  "./house-expense.html",
  "./calculate.html",
  "./calendar.html",
  "./notebook.html",
  "./qrscan.html",
  "./setting.html",
  "./account.html",
  "./N1024.png",
  "./manifest.json"
];

// Install: cache उपलब्ध फाइलहरूलाई अलग-अलग सुरक्षित गर्ने
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAME);

      await Promise.all(
        URLS_TO_CACHE.map(async (url) => {
          try {
            await cache.add(url);
          } catch (error) {
            // एउटा फाइल उपलब्ध नभए पनि अरू फाइल cache हुन दिनुहोस्।
            console.warn("Cache skipped:", url);
          }
        })
      );

      await self.skipWaiting();
    })()
  );
});

// Activate: पुरानो Digital NoteBook cache हटाउने
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();

      await Promise.all(
        cacheNames.map((cacheName) => {
          if (
            cacheName.startsWith("digital-notebook-") &&
            cacheName !== CACHE_NAME
          ) {
            return caches.delete(cacheName);
          }
          return Promise.resolve(false);
        })
      );

      await self.clients.claim();
    })()
  );
});

// Fetch: पहिले network, असफल भए cache बाट उपलब्ध सामग्री दिने
self.addEventListener("fetch", (event) => {
  const request = event.request;

  // GET अनुरोध मात्र cache/network fallback मा सम्हाल्ने
  if (request.method !== "GET") return;

  const requestUrl = new URL(request.url);

  // अर्को origin का अनुरोधलाई यस cache बाट सम्हाल्ने प्रयास नगर्ने
  if (requestUrl.origin !== self.location.origin) return;

  event.respondWith(
    (async () => {
      try {
        const response = await fetch(request);

        // सफल same-origin response लाई cache मा राख्ने प्रयास
        if (response && response.ok && response.type === "basic") {
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, response.clone()).catch(() => {});
        }

        return response;
      } catch (error) {
        const cachedResponse = await caches.match(request);

        if (cachedResponse) {
          return cachedResponse;
        }

        // अफलाइनमा पेज navigation भए cached index.html देखाउने
        if (request.mode === "navigate") {
          const offlinePage = await caches.match("./index.html");

          if (offlinePage) return offlinePage;
        }

        return new Response(
          "यो सामग्री अफलाइनमा उपलब्ध छैन। इन्टरनेट जडान गरेर फेरि प्रयास गर्नुहोस्।",
          {
            status: 503,
            statusText: "Offline",
            headers: {
              "Content-Type": "text/plain; charset=utf-8"
            }
          }
        );
      }
    })()
  );
});
