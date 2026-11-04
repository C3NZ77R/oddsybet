# Líneas de Betano en Props de NBA: diseño

Fecha: 2026-11-04. Estado: **implementado en la rama, falta la aprobación del usuario**. El usuario pidió saltarse las preguntas ("sigue porfavor"), así que las decisiones de abajo son mías y se pueden cambiar. Probado de punta a punta el 2026-11-04: el marcador leyó en betano.co los 14 partidos de la noche en 1.8 s (2 400 líneas, enlace de 25 KB) y Oddsy local las mostró en Props y en el detalle.

## Intención
El usuario apuesta props de NBA en Betano Colombia. Oddsy pone su propia línea y, aunque el 2026-11-04 se acercó a la de Betano (`bookLine`), en puntos y combinadas (PRA, P+R, P+A) casi nunca coincide, porque la proyección de Betano no es la nuestra. Lo que quiere es ver la probabilidad de Oddsy en la línea exacta que Betano ofrece, en cada jugador.

## Lo que se midió (2026-11-04, desde una pestaña de betano.co)
- `GET /api/cuotas-de-partido/x/{eventId}/?bt=1` responde con fetch del mismo origen. En `data.event.markets`, cada mercado de jugador trae `tableLayout.title` ("Puntos Más/Menos"), `tableLayout.rows[].title` (jugador) y `rows[].groupSelections[0]` con `handicap` (la línea) y `selections[]` con `price` y `columnIndex` (0 = Más, 1 = Menos). Una línea por jugador y mercado, 11 a 14 jugadores por partido.
- La página de la liga (`/sport/baloncesto/ee-uu/nba/441g/`) tiene enlaces `/cuotas-de-partido/{slug}/{id}/` a todos los partidos del día: con eso se leen los 14 partidos de una vez.
- 21 mercados Más/Menos por partido; 15 corresponden a estadísticas de Oddsy (tabla `TITLES` en `public/betano.js`). Fuera quedan Puntos+Bloques, Puntos+Rebotes+Bloqueos, tiros de 2, intentos de 3 y de campo.
- Nombres: de 194 jugadores con línea en Betano, los 155 que Oddsy cotiza coinciden todos con el `norm` de siempre (sin tildes ni signos). Los otros 39 no tienen prop en Oddsy (lesionados y novatos con menos de 8 partidos).
- Tamaño de los 14 partidos: 85 KB de JSON, 19 KB comprimido (deflate) en base64. Cabe sin problema en un enlace.
- El margen de Betano en props es de ~7 % (1.83 / 1.91).
- En Denver–Toronto, 69 líneas de Betano cruzan con props de Oddsy; solo 29 tienen la misma línea que Oddsy. Con la cuota de Betano, Oddsy ve más de 5 % de ventaja en 26. Casi todo eso es información que Oddsy no tiene (DeRozan: Betano 10.5 puntos, media de Oddsy 13.6), y por eso el aviso de abajo.

## Cómo funciona
1. **Marcador "Oddsy ← Betano"** (bookmarklet). Se guarda una vez. En Betano, en la página de la NBA (o en un partido), se toca y:
   - saca los ids de la URL o de los enlaces de la página (máximo 20),
   - pide cada partido a la API de Betano desde el navegador del usuario, como cuando abre la página,
   - guarda solo los mercados "Más/Menos" con línea: `[[partido, inicio, [[título, [[jugador, línea, Más, Menos], …]], …]], …]`,
   - lo comprime (`CompressionStream('deflate-raw')`) y abre `https://oddsybet.vercel.app/#/betano?d=…`. Va en el hash: el servidor de Oddsy nunca lo ve.
   El marcador no sabe qué estadísticas usa Oddsy: el filtro y el cruce viven en Oddsy, así que cambiarlos no obliga a reinstalarlo.
2. **`#/betano?d=…` en Oddsy.** Descomprime con tope de 1 MB, valida cada campo (entrada no confiable), traduce títulos a estadísticas y guarda `{ at, lines: { 'jugador|stat': [línea, Más, Menos] } }` en `oddsy.betano`. Un partido suelto se suma a lo que ya había; lo que tiene más de 12 h se ignora. Avisa cuántas líneas llegaron y lleva a `#/nba/props`.
3. **Lista de Props.** Si un prop tiene línea de Betano, sus dos filas (Más y Menos) pasan a esa línea: probabilidad, justa, cuota Oddsy y % de acierto se recalculan con la misma media y varianza del servidor (`propOver`). Aparece la columna **Betano**: su cuota y la ventaja (probabilidad Oddsy × cuota − 1), en verde si es positiva y en amarillo si pasa de 15 %. Se puede ordenar por ella. Las filas sin línea de Betano quedan como hoy.
4. **Detalle del prop.** La línea por defecto es la de Betano. Muestra "Línea Betano X · Más 1.83 · Menos 1.91" y la ventaja del lado elegido; si se cambia la línea, un botón la devuelve a la de Betano.
5. **Instalar y estado.** Un menú "Betano" en la barra de filtros de Props (solo NBA): cuántas líneas hay y de hace cuánto, un botón para borrarlas, el enlace para arrastrar a la barra de marcadores (computador) y un botón para copiar el código con los pasos para Chrome de Android y Safari de iPhone.

## Por qué así (mi decisión)
- El servidor no puede leer Betano (403 de Cloudflare) y no se intenta saltar.
- Pegar el texto de la página: Betano no muestra los mercados como texto ordenado y habría que abrirlos uno por uno. Frágil.
- Pantallazo leído por Gemini (como el ticket de Mis apuestas): sirve dentro de la app de Betano, pero un partido son 15 mercados y varios pantallazos, gasta la cuota gratis y puede leer mal un número. Queda para después: `linesOf` recibe el mismo formato, así que un lector podría alimentarlo.
- El marcador en el celular: en Chrome de Android se usa escribiendo su nombre en la barra de direcciones y tocándolo; en Safari de iPhone, desde Favoritos. La instalación es incómoda (editar un favorito y pegar el código), pero se hace una vez. **No funciona dentro de la app de Betano**: hay que abrir betano.co en el navegador.

## No-objetivos
- Otras ligas o deportes, las escaleras "25+", doble-doble, mercados H2H.
- Cambiar Mejores apuestas, el registro de picks o el boleto (el boleto sigue con la cuota Oddsy).
- Guardar las líneas en el servidor o compartirlas entre personas.

## Anti-objetivos
- Hacerle creer al usuario que una ventaja grande es plata segura. La tabla lo dice en texto: "Arriba de 15 % suele ser algo que Oddsy no sabe (lesiones, minutos). Revísalo antes de apostar."
- Pedirle a Betano más de lo que pide una visita normal: una petición por partido, solo cuando el usuario toca el marcador, sin cuenta ni datos personales.
- Que el marcador mande algo a otro lado que no sea Oddsy.

## Riesgos y atajos
- Si Betano cambia su API, el marcador avisa "No encontré líneas" y hay que actualizarlo.
- Dos jugadores con el mismo nombre normalizado el mismo día se pisarían (hoy no pasa). Atajo marcado en el código.
- La lista de Props solo trae los próximos 3 partidos; las líneas de los demás se ven al abrir el detalle de cada jugador.

## Lo que queda para quien construye
Textos finales, estilos y el orden exacto de columnas.
