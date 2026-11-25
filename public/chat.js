// Burbuja del asistente (Gemini): vive fuera de #view, así sigue abierta y con su historial al cambiar de vista.

const KEY = 'oddsy.chat';
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) ?? []; } catch { return []; } };
const save = (m) => { try { localStorage.setItem(KEY, JSON.stringify(m.slice(-20))); } catch { /* sin almacenamiento: queda en memoria */ } };
const el = (tag, cls, text) => Object.assign(document.createElement(tag), { className: cls ?? '', textContent: text ?? '' });

// Lo que viaja a /api/chat: los últimos 12 mensajes, recortados como en parseBody (lib/chat.mjs), sin los fallidos.
// Mandar todo el historial pasaba el tope de 20 000 caracteres del servidor y el chat quedaba en 413 para siempre.
export const outgoing = (msgs) => msgs.filter((m) => !m.error).slice(-12).map((m) => ({ role: m.role, text: String(m.text ?? '').slice(0, 1000) }));

export function initChat() {
  let msgs = load(), busy = false;
  const fab = el('button', 'chat-fab'); fab.type = 'button'; fab.setAttribute('aria-controls', 'chat'); fab.setAttribute('aria-expanded', 'false'); fab.setAttribute('aria-label', 'Asistente de IA');
  fab.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M4 5h16v11H9l-5 4Z"/><path d="M9 10h6"/></svg>';
  const panel = el('section', 'chat'); panel.id = 'chat'; panel.hidden = true; panel.setAttribute('aria-label', 'Asistente de IA');
  const head = el('div', 'chat-head'); head.append(el('b', '', 'Asistente Oddsy'), el('span', 'chat-sub', 'IA con estadísticas reales'));
  const close = el('button', 'icon-btn', '✕'); close.type = 'button'; close.setAttribute('aria-label', 'Cerrar asistente'); head.append(close);
  const log = el('div', 'chat-log'); log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite');

  const free = el('form', 'chat-free');
  const input = el('input'); input.placeholder = 'Pide un pick o pregunta por una línea…'; input.maxLength = 1000; input.setAttribute('aria-label', 'Mensaje');
  const send = el('button', 'btn', 'Enviar'); send.type = 'submit';
  free.append(input, send);
  panel.append(head, log, free);
  document.body.append(panel, fab);

  const draw = () => {
    log.replaceChildren(...(msgs.length ? msgs : [{ role: 'model', text: 'Hola, soy el asistente de Oddsy. Pídeme, por ejemplo: «algo seguro para hoy, más del 80 %» o «Curry más de 3.5 triples» y te respondo con los datos del modelo.' }])
      .map((m) => el('div', `chat-msg ${m.role}`, m.text)));
    log.scrollTop = log.scrollHeight;
  };
  const toggle = (open = panel.hidden) => { panel.hidden = !open; fab.setAttribute('aria-expanded', String(open)); if (open) { draw(); input.focus(); } };
  fab.onclick = () => toggle();
  close.onclick = () => { toggle(false); fab.focus(); };
  panel.addEventListener('keydown', (e) => { if (e.key === 'Escape') { toggle(false); fab.focus(); } });

  async function ask(text) {
    if (busy) return;
    busy = true; send.disabled = true;
    const mine = { role: 'user', text };
    msgs.push(mine);
    draw();
    const wait = el('div', 'chat-msg model', 'Pensando…'); log.append(wait); log.scrollTop = log.scrollHeight;
    try {
      const res = await fetch('/api/chat', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: outgoing(msgs), page: `${document.title} (${location.hash})` }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'El asistente no respondió.');
      msgs.push({ role: 'model', text: body.reply });
    } catch (err) {
      mine.error = true; // se ve en el chat pero no se reenvía: Gemini no debe leer el error como respuesta suya
      msgs.push({ role: 'model', text: err.message, error: true });
    }
    save(msgs); busy = false; send.disabled = false; draw();
  }
  free.onsubmit = (e) => { e.preventDefault(); const t = input.value.trim(); if (t) { input.value = ''; ask(t); } };
}
