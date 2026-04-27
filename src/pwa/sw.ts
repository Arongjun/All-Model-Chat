/// <reference lib="WebWorker" />

import { clientsClaim } from 'workbox-core';
import { cleanupOutdatedCaches, createHandlerBoundToURL, precacheAndRoute } from 'workbox-precaching';
import { NavigationRoute, registerRoute } from 'workbox-routing';
import { NetworkFirst, NetworkOnly, StaleWhileRevalidate } from 'workbox-strategies';

declare let self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<string | { url: string; revision: string | null }>;
};

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    void self.skipWaiting();
  }
});

clientsClaim();
precacheAndRoute(self.__WB_MANIFEST);
cleanupOutdatedCaches();

const appShellFallback = createHandlerBoundToURL('/index.html');
const navigationStrategy = new NetworkFirst({
  cacheName: 'navigation-shell',
  networkTimeoutSeconds: 3,
});

const navigationRoute = new NavigationRoute(async (options) => {
  try {
    const response = await navigationStrategy.handle(options);
    if (response) {
      return response;
    }
  } catch {
    // Fall back to the precached app shell when offline.
  }

  return appShellFallback(options);
}, {
  denylist: [/^\/api\//],
});

registerRoute(navigationRoute);

registerRoute(
  ({ request, url }) =>
    url.origin === self.location.origin &&
    ['style', 'script', 'worker', 'font', 'image'].includes(request.destination) &&
    url.pathname !== '/runtime-config.js',
  new StaleWhileRevalidate({
    cacheName: 'static-assets',
  }),
);

registerRoute(
  ({ url }) => url.origin === self.location.origin && (url.pathname === '/runtime-config.js' || url.pathname.startsWith('/api/')),
  new NetworkOnly(),
);
