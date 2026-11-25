// Service worker de Oddsy: los avisos de las apuestas seguidas y recibir el pantallazo compartido desde otra app
// (share_target del manifiesto). Sin caché offline: el único fetch que atiende es ese POST.
// Los mismos nombres usa takeSharedTicket en track.js.
const SHARE_PATH = '/compartir-ticket', SHARE_CACHE = 'oddsy-share', SHARED_TICKET = '/ticket-compartido';

self.addEventListener('install', () => self.skipWaiting());
// Sin claim(), la página que activó los avisos no queda controlada hasta recargar y navigate() del clic falla.
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Compartir un pantallazo a Oddsy: se guarda en Cache Storage y Mis apuestas lo lee al abrir (takeSharedTicket).
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.pathname !== SHARE_PATH) return;
  event.respondWith((async () => {
    const file = (await event.request.formData()).get('ticket');
    if (file instanceof File && file.type.startsWith('image/')) {
      const cache = await caches.open(SHARE_CACHE);
      await cache.put(SHARED_TICKET, new Response(file, { headers: { 'content-type': file.type } }));
    }
    return Response.redirect(new URL('/#/nba/seguir', self.location.origin).href, 303);
  })());
});

self.addEventListener('push', (event) => {
  let msg = {};
  try {
    msg = event.data?.json() ?? {};
  } catch {
    msg = { body: event.data?.text() ?? '' };
  }
  event.waitUntil(self.registration.showNotification(msg.title || 'Oddsy', {
    body: msg.body || '',
    tag: msg.tag, // el aviso nuevo de una apuesta reemplaza al anterior en la bandeja
    data: { url: msg.url || '/#/nba/seguir' },
    icon: '/icons/icon-192.png',
    lang: 'es-CO',
  }));
});

// Tocar el aviso: enfoca una ventana de Oddsy abierta y la lleva a "Mis apuestas"; si no hay, abre una.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/#/nba/seguir', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      return win.navigate(url).catch(() => win.postMessage({ type: 'open', url }));
    }
    return self.clients.openWindow(url);
  })());
});
