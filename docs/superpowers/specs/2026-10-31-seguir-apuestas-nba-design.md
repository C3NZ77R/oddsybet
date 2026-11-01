# Seguir apuestas en vivo (NBA) — diseño

Fecha: 2026-10-31. Estado: **aprobado**. El usuario delegó las decisiones abiertas ("hazlo según tu criterio") y pidió que la lectura del ticket use un modelo gratis, Gemini de Google AI Studio, y nunca su cuenta de Claude.

## Intención
La gente no apuesta en Oddsy: apuesta en Betplay, Betano y otras casas, y usa Oddsy como apoyo estadístico. Hoy, mientras su apuesta está en juego, entran cada minuto a Sofascore o a la casa para ver cómo va ("¿cuántos puntos lleva?", "¿ya van los córners?"). Esta función hace ese seguimiento por ellos: la persona registra en Oddsy la apuesta que ya hizo en su casa, con una foto del ticket o con texto, y Oddsy la sigue en vivo y le manda una **notificación al celular** solo en los momentos que mueven esa apuesta. La persona no tiene que tener Oddsy abierto.

Oddsy acompaña la apuesta, no la vende: no hay cuotas que comprar, ni picks empujados, ni enlaces a casas.

## Objetivos
1. Registrar una apuesta hecha en otra casa (sencilla o combinada) desde un **pantallazo del ticket o texto pegado**. Oddsy muestra lo que entendió y la persona lo confirma o lo corrige antes de que empiece el seguimiento.
2. Seguir cada selección de **NBA** con la **línea y la cuota de la casa** de la persona, no con las de Oddsy.
3. Avisar con **notificaciones push en el celular**, con Oddsy cerrado y la pantalla bloqueada, en Android y en iPhone.
4. Que los avisos sean pocos y útiles: cerca de cumplir, cumplida, en riesgo, resumen por cuarto y resultado final.

## No-objetivos (por ahora)
- Otros deportes y ligas. El fútbol (córners) y el tenis (games del 1.er set) los pidió el usuario como ejemplos; vienen después. Ver "Después" al final.
- Avisos en el computador. El usuario los quiere **solo en celulares**. La función *es* el aviso: sin avisos activados no se puede registrar una apuesta. En un navegador sin push (escritorio, Safari de iPhone sin instalar, permiso negado), "Mis apuestas" explica cómo activarlos y no deja seguir apuestas.
- Cuentas de usuario, registro o inicio de sesión.
- Mercados que Oddsy no cubre en la NBA: cuartos, mitades, totales por equipo, "primer equipo en anotar", carreras a X puntos. Esas selecciones se aceptan en el ticket y quedan marcadas "no seguida".
- Liquidar dinero, guardar el monto apostado o llevar balance de ganancias.

## Anti-objetivos (fallaría aunque funcione)
- **Spam.** Un partido de NBA tiene ~200 canastas. Si la persona recibe un aviso por cada una, silencia Oddsy y la función muere.
- **Seguir una apuesta distinta a la que hizo.** Leer mal el ticket (otra línea, otro jugador, Más en vez de Menos) es peor que no seguirla. Nada se sigue sin la confirmación de la persona.
- **Parecer que Oddsy es una casa** o empujar a apostar más. Los avisos informan; no dicen "apuesta ahora".
- **Guardar datos personales del ticket.** El pantallazo puede traer usuario, saldo o número de ticket de la casa: no se guarda la imagen ni el texto original.

## Lo que decidió el usuario
- Primero solo NBA.
- Apuestas hechas en otras casas, ingresadas con imagen o texto.
- Avisos con notificación del sistema, **solo en dispositivos móviles**, aunque Oddsy esté cerrado.
- Combinadas incluidas, con seguimiento de cada selección.
- **La lectura del ticket usa un modelo gratis: Gemini por la API de Google AI Studio.** No se usa la API ni los tokens de Claude del usuario para nada de esta función.
- Aprobó en el chat este comportamiento: aviso cuando una prop está cerca de cumplirse, cuando se cumple y cuando está en riesgo; resumen al final de cada cuarto para total, ganador y hándicap; resultado final; en combinadas, un aviso cuando se cae y dejar de avisar.

## Restricciones
- **Stack actual:** vanilla JS sin build en `public/`, Node ≥ 22 en `server.mjs`, desplegado en Vercel (`api/[...path].mjs` reexporta el handler; `vercel.json` con `maxDuration` 60 s y `buildCommand: node --test`). Hasta hoy **cero dependencias** y **ningún almacenamiento en servidor**: todo el estado del usuario vive en `localStorage` (`public/store.js`).
- **`server.mjs` solo acepta GET/HEAD** (responde 405 a lo demás) y no lee cuerpos. Esta función necesita POST y DELETE con cuerpo JSON y límite de tamaño, y respuestas `no-store` (nada de `EDGE_S`).
- **Fuente de datos en vivo: ESPN**, la misma de la vista En vivo. `lib/espn.mjs → getLive/normLive` ya da el marcador, el periodo, el reloj, `progress`, `winProb` y las estadísticas por jugador (`boxPlayers`, que también calcula los combinados como `pra` y `dd`). El summary de un partido se cachea 15 s (`TTL.live`).
- **Atraso de ESPN:** en la NFL las jugadas llegan ~6 min tarde (medido el 2026-10-18). En la NBA no está medido. Los avisos pueden llegar después de lo que la persona ve en su casa, y la UI lo dice.
- **Push en iPhone:** solo funciona con iOS 16.4+ y con Oddsy **agregado a la pantalla de inicio** (web app con manifiesto `display: standalone`). El permiso de notificaciones se pide desde un toque del usuario dentro de esa app instalada. En iOS, la app instalada tiene un almacenamiento separado de Safari, así que las apuestas se registran desde la app instalada. En Android basta con Chrome; instalarla es opcional.
- **Vercel no corre procesos permanentes** y sus cron no llegan a cada 30 s. El ciclo de revisión lo dispara afuera (Supabase, ver Arquitectura).
- **Límite de cuerpo de Vercel ~4.5 MB:** el pantallazo se reduce en el navegador antes de subirlo.
- **Español (es-CO)** en toda la UI y en los avisos, como el resto de Oddsy.

## Experiencia
### Primera vez
1. La persona entra a **"Mis apuestas"** (vista nueva, `#/nba/seguir`, enlazada desde la navegación de la NBA).
2. Si es iPhone y Oddsy no está instalado (`navigator.standalone` falso), ve instrucciones cortas: Compartir → "Agregar a inicio", luego abrir Oddsy desde el ícono. No se intenta pedir permiso fuera de la app instalada.
3. Botón **"Activar avisos"** → permiso de notificaciones → suscripción push → registro del dispositivo en el servidor, que responde mandando un primer aviso "Avisos activados". Si niega el permiso, se le dice cómo activarlo en los ajustes del sistema; hasta entonces no puede registrar apuestas.

### Registrar una apuesta
1. **"Subir pantallazo"** (input de archivo con `accept="image/*"`; en el celular abre la galería o la cámara) o **"Pegar texto"**. Junto al botón, un aviso corto: la foto la lee Gemini de Google en su capa gratis, donde Google puede revisar lo que se envía, así que conviene recortar o tapar el usuario, el saldo y el número de ticket antes de subirla (el editor de pantallazos del celular lo hace).
2. El navegador reduce la imagen (lado mayor ≤ 1600 px, JPEG, ≤ 2 MB; si queda más pesada, baja la calidad) y la manda en base64 a `/api/track/read`.
3. Oddsy devuelve un borrador: una fila por selección con partido, mercado, jugador, Más/Menos, línea, cuota y una marca "seguida / no seguida (motivo)".
4. **Pantalla de confirmación** editable: cada campo se puede cambiar (partido de una lista de los partidos de NBA de hoy y mañana; jugador de la plantilla de ese partido; mercado de los soportados; línea; lado; cuota). Las selecciones no soportadas se ven, pero no se editan como seguidas.
5. **"Seguir apuesta"** la guarda. Si la lectura falla o no encuentra nada, el mismo formulario aparece vacío para llenarlo a mano.

### Mientras se juega
- Llegan los avisos (sección Avisos). Tocar uno abre "Mis apuestas" en esa apuesta.
- Con la app abierta, "Mis apuestas" muestra cada apuesta con su estado en vivo (valor actual contra la línea, estado de cada selección) y se refresca cada 15 s, como la vista En vivo.
- Se puede **dejar de seguir** (borrar) una apuesta en cualquier momento.

## Mercados que se siguen (los que Oddsy ya cubre en la NBA)
| Mercado | Selección | Se cumple cuando |
|---|---|---|
| Ganador | equipo | gana el partido |
| Hándicap | equipo + línea (ej. −5.5) | puntos del equipo + línea > puntos del rival |
| Total de puntos | Más/Menos + línea | suma de los dos equipos contra la línea |
| Prop de jugador | Más/Menos + línea, de `STATS.basketball` en `public/stats.js`: puntos, rebotes, asistencias, triples, PTS+REB+AST, PTS+REB, PTS+AST, REB+AST, robos, tapones, robos+tapones, pérdidas, tiros de campo, tiros libres anotados e intentados | el valor final del jugador contra la línea |
| Doble-doble / triple-doble | Sí/No | lo logra o no (`dd`/`td` de `boxPlayers`) |

Reglas de liquidación (estándar de las casas para NBA; decisión mía):
- Todo es **partido completo con prórroga incluida**.
- Línea entera exacta (ej. total 220 y terminan 220) → **devuelta**.
- Prop de un jugador que **no juega** (no aparece con minutos > 0 al final) → **anulada**.
- En una combinada, una selección anulada o devuelta sale de la cuenta y las demás siguen. La cuota total se recalcula solo si la persona escribió las cuotas de cada selección; si no, se muestra "cuota ajustada por tu casa".
- Partido aplazado o suspendido → **anulada**, con aviso.

## Avisos
Tono: corto, en español, con el dato que la persona iría a buscar. Título = quién/qué; cuerpo = cómo va. Ejemplos:
- "Jokić · Más de 24.5 puntos" / "Lleva 22, le faltan 3 · quedan 6:12 del 4.º · 71 % de cumplir"
- "¡Cumplida! Jokić pasó 24.5 puntos" / "Lleva 26 con 4:01 por jugar"
- "Nuggets vs Lakers · fin del 3.er cuarto" / "Van 168. A este ritmo terminan en ~224: tu Más de 220.5 tiene 64 %"
- "Se cayó tu combinada" / "LeBron terminó con 7 asistencias (necesitaba 8). Ya no te avisamos de las demás."
- "¡Ganaste la combinada!" / "Las 4 selecciones cumplidas · cuota 8.40"

### Catálogo por tipo de selección
Cada aviso se manda **una sola vez** por selección, salvo los resúmenes por cuarto (uno por cuarto) y los cambios de ventaja (con límite).

**Prop Más / Sí (dd, td):**
- *Cerca*: le falta ≤ max(1, ⌈0.15 × línea⌉). Con 24.5 puntos: ≤ 4; con 8.5 rebotes: ≤ 2; con 2.5 triples: 1. Doble-doble: ya tiene una categoría en 10+ y otra en 8+.
- *Cumplida*: apenas la pasa (ya no puede perderse).
- *En riesgo*: 4.ª falta antes del 4.º cuarto o 5.ª en cualquier momento; partido definido (diferencia ≥ 18 con ≥ 60 % jugado, la regla de `scriptFor` en `public/live.js`), solo si todavía no la cumplió.
- *Final*: cumplida, fallada ("terminó con 22, necesitaba 25") o anulada.

**Prop Menos / No:**
- *En peligro*: le falta ≤ el mismo umbral para pasarse.
- *Fallada*: apenas se pasa.
- *Final*: cumplida o anulada.

**Total Más/Menos:** resumen al final del 1.º, 2.º y 3.er cuarto (marcador, proyección y probabilidad con la línea de la persona); *cumplida* (Más) o *fallada* (Menos) apenas se cruza la línea; final.

**Ganador y hándicap:** resumen al final del 1.º, 2.º y 3.er cuarto (marcador y si va ganando o cubriendo; en ganador, la probabilidad de ESPN para su equipo); en el 4.º cuarto y la prórroga, aviso cuando cambia de "ganando/cubriendo" a "perdiendo/no cubriendo" o al revés, **máximo uno cada 3 minutos** por selección; final.

**Apuesta completa:**
- *Arrancó*: uno solo, cuando empieza el primer partido de la apuesta ("Empezó Nuggets vs Lakers: seguimos tu apuesta").
- *Combinada*: cada aviso de una selección lleva el estado de la combinada ("2 de 4 cumplidas"). Si una selección falla: un aviso de "se cayó" y **no se manda nada más** de esa apuesta. Si se cumple la última: "¡Ganaste!". Si la combinada tiene selecciones no seguidas: "Cumpliste las de NBA; faltan las que no seguimos".

La probabilidad en vivo se muestra solo donde Oddsy ya la calcula: props y total con `remaining`/`liveOver` de `public/live.js` (media y varianza previas del prop de Oddsy para ese jugador y estadística, si existe; si no, se omite el %), y ganador con `winProb` de ESPN. En hándicap no se muestra %.

Las notificaciones usan `tag` = id de la apuesta, para que en la bandeja el aviso nuevo reemplace al anterior de la misma apuesta en vez de apilarse. Por eso, si en un mismo tick salen varios avisos de una apuesta (ej. dos selecciones de una combinada cumplidas a la vez), se **juntan en un solo push**; si no, el segundo taparía al primero sin que se vea.

## Arquitectura
```
celular (PWA)                  Vercel (server.mjs)                     Supabase
─────────────                  ───────────────────                     ────────
sw.js ◄── push ─────────────── /api/track/tick ◄── cada 30 s ──────── pg_cron + pg_net
"Mis apuestas" ─ POST ticket ─► /api/track/read ── Gemini (visión) ──► (nada se guarda)
               ─ POST/GET/DEL ► /api/track/device, /api/track/bets ──► tablas devices, bets, selections
                                /api/track/tick ── ESPN summary (lib/espn.mjs) + public/live.js
```

### Piezas nuevas
1. **PWA:** `public/manifest.webmanifest` (nombre, íconos PNG 192 y 512, `display: standalone`, `start_url` en la vista NBA), `<link rel="manifest">` y metas de Apple en `index.html`, y `public/sw.js` (service worker) con solo dos tareas: mostrar el push (`push` → `showNotification`) y abrir o enfocar Oddsy al tocarlo (`notificationclick`). Sin caché offline.
2. **Supabase** (Postgres) para guardar dispositivos, apuestas y selecciones. Solo el servidor habla con Supabase, con la service role key por su API REST (PostgREST) con `fetch`. El navegador nunca tiene llaves de Supabase.
3. **Ciclo de revisión:** un job de `pg_cron` en Supabase que cada 30 s hace `POST https://<dominio de producción>/api/track/tick` con `pg_net`, con un secreto en un header. El tick trabaja solo si hay selecciones pendientes o en juego cuyo partido empieza en menos de 10 min o ya empezó.
4. **Lectura del ticket:** `/api/track/read` llama a la **API de Gemini** (`POST https://generativelanguage.googleapis.com/v1beta/models/{modelo}:generateContent`, header `x-goog-api-key`, con `fetch`) mandando la imagen en `inline_data` o el texto, y pide JSON con `generationConfig.responseMimeType: "application/json"` y un `responseSchema`. Modelo: el **Flash más reciente que tenga capa gratis** y lea imágenes. Al construir se confirma el id exacto y sus límites gratis en la documentación oficial (ai.google.dev, páginas de modelos y de rate limits) y con `GET /v1beta/models`; queda como una constante. Un 429 (`RESOURCE_EXHAUSTED`, cuota gratis agotada) o cualquier fallo de Gemini lleva al formulario manual, nunca a un error sin salida. El modelo devuelve los campos crudos de cada selección (texto del jugador, equipos, mercado, lado, línea, cuota). El servidor los cruza con los partidos de NBA de hoy y mañana (`getGames`) y las plantillas (`getRoster`), normalizando tildes y mayúsculas, y devuelve el borrador con ids de ESPN.
5. **Push:** Web Push estándar con llaves VAPID.

### Dependencias: una sola, `web-push`
`docs/architecture.md` tiene la regla "Sin dependencias npm ni CDN de JS". Se rompe con **una** excepción en el servidor: `web-push`, para firmar (VAPID) y cifrar (RFC 8291) los avisos, porque escribir esa criptografía a mano es delicado. La regla se actualiza a: "sin dependencias npm salvo `web-push` en el servidor (seguimiento de apuestas); nada de CDN de JS". Gemini y Supabase van con `fetch` a sus API REST, sin SDK. El cliente sigue sin dependencias.

### Modelo de datos (Supabase)
- `devices`: `id` uuid, `secret_hash` (sha-256 del secreto que guarda el navegador), `subscription` jsonb (endpoint + keys), `platform` (ios/android/otro, informativo), `created_at`, `last_seen_at`.
- `bets`: `id` uuid, `device_id`, `book` (texto opcional: Betplay, Betano…), `odds` (decimal opcional, cuota total), `status` (pendiente · en_juego · ganada · perdida · anulada · parcial), `created_at`, `settled_at`, `notified` jsonb (arrancó, final).
- `selections`: `id`, `bet_id`, `league` ('nba'), `game_id` (ESPN), `market` (ml · spread · total · prop), `stat` (clave de `STATS`, en props), `athlete_id`, `athlete_name`, `team_id`, `side` (Over · Under · home · away · Sí · No), `line`, `odds`, `label` (texto mostrado, ej. "Jokić · Más de 24.5 puntos"), `status` (pendiente · en_juego · cumplida · fallada · anulada · devuelta · no_seguida), `current` (último valor visto), `state` jsonb (avisos ya mandados: cerca, riesgo, cuartos, último cambio de ventaja y su hora).
- Retención: apuestas liquidadas se borran a los **7 días**. Dispositivos sin actividad 60 días o cuyo push responde 404/410 se borran con sus apuestas.

### Rutas nuevas (todas `no-store`, cuerpo JSON ≤ 3 MB —por debajo del límite de 4.5 MB de Vercel—, errores como el resto: `{ error }`)
- `GET /api/track/vapid` → llave pública VAPID.
- `POST /api/track/device` `{ subscription }` → crea el dispositivo y devuelve `{ deviceId, secret }`, o actualiza la suscripción si ya existe (con `deviceId` + `secret`). El `endpoint` tiene que ser de un servicio de push conocido (FCM de Google, Apple, Mozilla, Microsoft) y el servidor manda el aviso "Avisos activados": si el servicio de push lo rechaza, no se crea el dispositivo. Así no se fabrican dispositivos falsos para gastar lecturas. El navegador guarda id y secreto en `store`.
- `POST /api/track/read` `{ image: base64 } | { text }` → borrador de selecciones. **No guarda nada.**
- `POST /api/track/bets` `{ book?, odds?, selections: [...] }` → crea la apuesta. El servidor valida cada selección: partido de NBA existente y no terminado, jugador de alguno de los dos equipos, mercado y estadística soportados, línea numérica.
- `GET /api/track/bets` → apuestas del dispositivo con su estado.
- `DELETE /api/track/bets?id=…` → deja de seguirla.
- `POST /api/track/tick` → solo con el header secreto; corre un ciclo.
Las rutas de dispositivo y apuestas se autentican con `x-device-id` + `x-device-secret`.

### El tick
1. Lee las selecciones activas y las agrupa por partido.
2. Por partido pide el summary de ESPN con caché de **15 s siempre**, también antes del salto inicial y después del final (hoy `getGames`/summary usan 5 min fuera del juego, y el aviso de "arrancó" o el final llegarían hasta 5 min tarde), y lo normaliza con `normLive`. Los partidos que ya terminaron se procesan una última vez para liquidar.
3. Por selección calcula el estado nuevo con una **función pura** `(selección, estado anterior, partido, ahora) → { estado nuevo, avisos[] }`, y por apuesta agrega el estado de la combinada.
4. **Guarda el estado nuevo antes de mandar los avisos** (si el push falla, se pierde un aviso; nunca se repite). Dos ticks no deben procesar a la vez: una fila de "lease" con hora de vencimiento (~55 s) que el tick toma con un update condicional. Un advisory lock de Postgres no sirve: por PostgREST se suelta al terminar cada llamada.
5. Manda los push, uno por apuesta con los avisos de ese tick juntos. Un 404/410 borra el dispositivo.
6. Debe terminar holgado dentro de los 60 s de Vercel; con muchos partidos, los summaries se piden en paralelo con límite (`mapLimit`).

## Seguridad y privacidad
- La imagen y el texto del ticket **no se guardan ni se registran en logs**. Solo quedan las selecciones confirmadas.
- **Capa gratis de Gemini:** según los términos de la API de Gemini, lo que se manda sin facturación activa puede usarse para mejorar los productos de Google y pueden leerlo revisores humanos, y Google pide no enviar información personal. Por eso: el aviso de recortar el pantallazo (sección Experiencia), el prompt pide solo las selecciones, y Oddsy no reenvía nada más que la imagen o el texto que la persona eligió subir.
- El prompt a Gemini pide solo las selecciones y trata el contenido del ticket como datos, no como instrucciones. La salida se valida con el esquema y después contra ESPN: nada que no exista en ESPN llega a la base.
- **Límites contra abuso** de `/api/track/read` (la cuota gratis es compartida por todos): exige un dispositivo registrado (con push verificado), máximo 20 lecturas por dispositivo al día, un tope por IP y un **tope global diario** (`TRACK_READS_PER_DAY`) un poco por debajo del límite diario gratis del modelo elegido, para que unos pocos no agoten la cuota de todos. Al llegar al tope, la lectura responde 429 y la persona puede llenar el formulario a mano. Imagen ≤ 2 MB después de reducirla.
- `/api/track/tick` solo con el secreto (`TRACK_TICK_SECRET`), comparado en tiempo constante.
- El secreto del dispositivo se guarda hasheado. Sin datos personales: ni nombre, ni correo, ni teléfono.

## Variables de entorno nuevas (Vercel)
`GEMINI_API_KEY` (clave gratis de Google AI Studio, en un proyecto **sin facturación activa** para que nunca cobre), `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` (mailto del proyecto), `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `TRACK_TICK_SECRET`, `TRACK_READS_PER_DAY` (opcional). Sin ellas, las rutas de seguimiento responden 503 con un mensaje claro y el resto de Oddsy sigue igual (los tests no dependen de ellas).

## Costos (estimados)
- **Lectura de un ticket con Gemini: $0.** La capa gratis tiene límites por minuto y por día que dependen del modelo y que Google cambia seguido (las guías de 2026 van de ~250 a ~1 500 lecturas diarias para los Flash); se confirman al construir. Sin facturación activa en el proyecto de Google no hay cobro posible: al agotar la cuota, Gemini responde 429 y la persona llena el formulario a mano.
- **Supabase:** el plan gratis alcanza (pocas tablas pequeñas; `pg_cron` y `pg_net` incluidos).
- **Vercel:** ~2 880 invocaciones al día del tick (la mayoría vacías y cortas), más los summaries de ESPN de los partidos con apuestas.

## Pruebas
- `node --test`, sin red ni variables de entorno (corre en el build de Vercel).
- La función pura del tick, con casos por mercado: cerca/cumplida/riesgo de Más y Menos, umbral de cerca, doble-doble, resúmenes por cuarto, cambio de ventaja con el límite de 3 min, prórroga, línea exacta (devuelta), jugador que no juega (anulada), combinada que se cae (y que no avisa más), combinada con no seguidas. Partidos de prueba armados a mano y, donde sirva, summaries reales de `.cache/espn/`.
- El cruce del borrador del modelo con partidos y plantillas: tildes, nombres cortos ("N. Jokić"), jugador ambiguo, partido de mañana, mercado no soportado → "no seguida".
- Las rutas: validación, autenticación del dispositivo, 405/404/413, `no-store`.
- Gemini, Supabase y Web Push van detrás de envoltorios delgados que los tests reemplazan.
- **Antes de dar por terminado:** una noche real de NBA en un Android y un iPhone (instalado), con una sencilla y una combinada, midiendo el atraso de ESPN en la NBA (hora del aviso contra la hora real de la jugada) y anotándolo en `docs/architecture.md`.

## Lo que se deja al constructor
- Cómo se ven "Mis apuestas" y la pantalla de confirmación, siguiendo el estilo de las vistas existentes (`public/views/live.js`, `public/css/live.css`).
- El prompt exacto y el esquema de salida para leer el ticket.
- El algoritmo de cruce de nombres (normalización, coincidencia parcial) y cómo mostrar un jugador ambiguo.
- El mecanismo concreto del candado del tick.
- Los íconos de la PWA (a partir del logo actual de `index.html`).
- Cómo partir el código en archivos (`lib/track.mjs` para la lógica pura, `lib/push.mjs`, `lib/db.mjs`, `public/views/seguir.js`…), siguiendo los patrones del repo.
- Actualizar `docs/architecture.md` con las rutas, las tablas y las variables nuevas.

## Decisiones mías (revisables)
1. Ticket con foto o texto → borrador → confirmación obligatoria; formulario manual si falla la lectura.
2. Supabase como base de datos y como disparador cada 30 s.
3. Sin avisos activados no se registran apuestas; el registro del dispositivo verifica la suscripción con un primer aviso.
4. Umbral de "cerca": falta ≤ max(1, ⌈0.15 × línea⌉).
5. En riesgo: 4.ª falta antes del 4.º cuarto, 5.ª en cualquier momento, partido definido.
6. Cambios de ventaja en ganador y hándicap: solo en el 4.º cuarto y la prórroga, máximo uno cada 3 min.
7. Aviso de "arrancó" al empezar el primer partido de la apuesta.
8. Reglas de liquidación: prórroga incluida, línea exacta devuelta, jugador que no juega anulada.
9. Guardar el estado antes de mandar el aviso: se puede perder uno, nunca se repite.
10. Retención de 7 días para apuestas liquidadas; sin imágenes ni texto del ticket guardados.
11. Máximo 20 lecturas de ticket por dispositivo al día y un tope global un poco por debajo de la cuota gratis diaria de Gemini (configurable).
12. Varios avisos de una apuesta en el mismo tick van en un solo push.
13. El tick usa caché de 15 s para los partidos seguidos en cualquier estado, y una fila de lease como candado.

## Decisiones del usuario y las que me delegó
- **Modelo para leer el ticket (del usuario): Gemini gratis de Google AI Studio**, nunca Claude. El id exacto (el Flash más reciente con capa gratis y visión) se confirma al construir.
- **Dependencias (delegada):** solo `web-push`; Gemini y Supabase con `fetch`. Se actualiza la regla de `docs/architecture.md`.
- **Montaje (delegada): lo configura el constructor** con las herramientas conectadas. En Supabase no hay un proyecto de Oddsy (los que existen en la organización son de otras cosas), así que se crea uno nuevo, `oddsy-bet`. Antes de crearlo se consulta su costo; si no es gratis (el plan gratis suele permitir solo dos proyectos activos y ya hay dos), se le pregunta al usuario. Las variables de Vercel las pone el constructor, salvo `GEMINI_API_KEY`: el usuario la crea en AI Studio y la pone él en Vercel, sin pasarla por el chat. El job de `pg_cron` se crea cuando el código ya esté en producción.
- **Prueba final (delegada):** el constructor verifica todo lo que se puede sin celulares (tests, servidor local, un push real a un navegador de escritorio solo como humo). La noche real de NBA en Android e iPhone la hace el usuario, con una lista de pasos que le deja el constructor.

## Después (fuera de este proyecto)
- Fútbol: córners por equipo (ESPN trae "Corner Awarded" con equipo y minuto en `commentary`, y `wonCorners` en vivo en el boxscore), goles y tarjetas.
- Tenis: total de games del 1.er set (ESPN trae los games por set; no trae el punto a punto ni quién saca, así que no hay avisos de break point).
- Más ligas de básquet que Oddsy ya cubre (WNBA). Oddsy quedó en fútbol, básquet y tenis (NFL y MLB se quitaron el 2026-10-31).
