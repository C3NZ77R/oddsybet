// Seguimiento de apuestas en el navegador: permiso y suscripción de avisos, foto del ticket reducida y llamadas a
// /api/track/* con el id y el secreto del dispositivo (store 'track').
import { store } from './store.js';
import { SLOW } from './api.js';

// 'ok' se pueden activar · 'ios-install' iPhone sin agregar a inicio · 'denied' permiso negado · 'unsupported' sin push.
export function pushSupport({ standalone, hasPush, ios, permission }) {
  if (ios && !standalone) return 'ios-install'; // en iOS el push solo existe en la app instalada (16.4+)
  if (!hasPush) return 'unsupported';
  return permission === 'denied' ? 'denied' : 'ok';
}

// Llave VAPID (base64url) → bytes para applicationServerKey.
export function b64ToBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

const auth = () => {
  const t = store.get('track');
  return t ? { 'x-device-id': t.deviceId, 'x-device-secret': t.secret } : {};
};

// 30 s: leer el ticket con Gemini puede tardar hasta 20 s en el servidor.
const TIMEOUT = 30_000;
async function call(method, path, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT);
  let res, data;
  try {
    try {
      res = await fetch(`/api/track/${path}`, {
        method,
        headers: { ...auth(), ...(body !== undefined && { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch {
      throw new Error(ctrl.signal.aborted ? SLOW : 'No se pudo conectar con el servidor. Revisa tu conexión.');
    }
    if (res.status === 204) return null;
    data = await res.json().catch(() => ({}));
    if (ctrl.signal.aborted) throw new Error(SLOW);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 401 && store.get('track')) store.set('track', null); // el servidor ya no conoce este celular
  if (!res.ok) throw Object.assign(new Error(data.error || `El servidor respondió ${res.status}.`), { status: res.status });
  return data;
}

const platform = () => (/iP(hone|ad|od)/.test(navigator.userAgent) ? 'ios' : /Android/.test(navigator.userAgent) ? 'android' : 'otro');

// Llamar desde el clic: iOS solo muestra el permiso si se pide dentro del gesto, por eso va antes de cualquier await.
export async function enablePush() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied' ? 'Negaste el permiso de notificaciones. Actívalo en los ajustes del celular para Oddsy.' : 'Necesitamos el permiso de notificaciones para avisarte.');
  }
  const reg = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const { publicKey } = await call('GET', 'vapid');
  const sub = (await reg.pushManager.getSubscription()) ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
  const body = { subscription: sub.toJSON(), platform: platform() };
  if (store.get('track')) {
    try {
      return await call('POST', 'device', body);
    } catch (err) {
      if (err.status !== 401) throw err; // el 401 ya borró el dispositivo viejo: se registra de nuevo
    }
  }
  const { deviceId, secret } = await call('POST', 'device', body);
  store.set('track', { deviceId, secret });
}

// Foto del ticket → JPEG en base64 con lado mayor ≤ 1600 px y ≤ 2 MB (baja la calidad hasta 0.5).
const MAX_SIDE = 1600, MAX_BYTES = 2 * 1024 * 1024;
export async function shrinkImage(file) {
  let img;
  try {
    img = await createImageBitmap(file);
  } catch {
    throw new Error('No pude abrir la imagen. Prueba con un pantallazo en JPG o PNG.');
  }
  const k = Math.min(1, MAX_SIDE / Math.max(img.width, img.height));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.round(img.width * k), height: Math.round(img.height * k) });
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  img.close?.();
  for (let q = 0.85; q >= 0.5; q -= 0.1) {
    const b64 = canvas.toDataURL('image/jpeg', q).split(',')[1];
    if (b64.length * 0.75 <= MAX_BYTES) return b64;
  }
  throw new Error('La foto es muy pesada incluso reducida. Recórtala y vuelve a intentar.');
}

export const trackApi = {
  read: (input) => call('POST', 'read', input),
  createBet: (bet) => call('POST', 'bets', bet),
  listBets: () => call('GET', 'bets'),
  deleteBet: (id) => call('DELETE', `bets?id=${encodeURIComponent(id)}`),
};
