// Seguimiento: avisos al celular por Web Push (VAPID). web-push firma y cifra (RFC 8291): la única dependencia npm.
const HOSTS = ['fcm.googleapis.com', 'push.apple.com', 'push.services.mozilla.com', 'notify.windows.com'];

// Solo https de los servicios de push de los navegadores: el servidor nunca hace POST a una URL cualquiera.
export function isPushEndpoint(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

// webpush inyectable para los tests; por defecto, el módulo real.
export function createPush({ publicKey, privateKey, subject, webpush }) {
  return {
    async send(subscription, { title, body, tag, url }) {
      const wp = webpush ?? (await import('web-push')).default;
      try {
        await wp.sendNotification(subscription, JSON.stringify({ title, body, tag, url }), { vapidDetails: { subject, publicKey, privateKey }, TTL: 600, urgency: 'high' });
        return { ok: true, gone: false };
      } catch (err) {
        const gone = err?.statusCode === 404 || err?.statusCode === 410; // el celular dio de baja la suscripción
        if (!gone) console.warn('push falló', err?.statusCode ?? 'sin código'); // nunca la suscripción
        return { ok: false, gone };
      }
    },
  };
}
