// Service worker de Oddsy: solo los avisos de las apuestas seguidas. Sin caché offline ni manejo de fetch.
self.addEventListener('install', () => self.skipWaiting());
// Sin claim(), la página que activó los avisos no queda controlada hasta recargar y navigate() del clic falla.
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

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
