# Cómo cotiza Betano (auditoría del 2026-10-31)

Fuente: la API pública que usa betano.co para pintar sus páginas (`/api/sports/{FOOT|BASK|TENN}/hot/trending/leagues/{id}/events` y `/api/cuotas-de-partido/x/{eventId}/`), leída desde el navegador como cualquier visita. REA en headless recibió 403 de Cloudflare y no se forzó. Muestra: 46 partidos antes de empezar (Liga BetPlay, Premier, LaLiga, Serie A, Liga Profesional argentina, NBA, Liga Endesa, B.League, Masters de París), 4 479 líneas.

**Lo que no se ve:** el modelo. Las cuotas se calculan en su servidor; el cliente solo las muestra. Cada partido trae `betRadarId` y estadísticas de Sportradar, así que su base de datos (y probablemente su feed de cuotas) es Sportradar, pero eso es inferencia. Lo de abajo es cómo **ponen el margen**, que sí se mide en las cuotas publicadas.

## 1. El margen depende del mercado, no es uno solo
Overround (Σ 1/cuota − 1), mediana de la línea principal:

| Mercado | Fútbol (ligas top) | Liga BetPlay | Básquet | Tenis |
|---|---|---|---|---|
| Principal (1X2, ganador, hándicap/total principal) | 5.0 % | 5.2 % (total 6.7 %) | NBA 5.0 %, Endesa 7.0 % | ganador 5.2 %, juegos 5.9 % |
| Secundario de 2 lados (ambos anotan, sin empate, total de un equipo, córners, tarjetas, sets) | 7.0 % | 7.1–8.1 % | total de equipo 8–9 %, alternativas 8.5 % | 7.0 % |
| 3 lados secundario (1X2 del 1.er tiempo, resultado en tiempo regular) | 9 % | 11.2 % | 11.2 % | — |
| Muchas salidas (medio tiempo/final, marcador exacto, margen de victoria) | 20 % / 24–26 % | 26 % | 7 vías 35 %, 14 vías 55 % | apuesta de set 12 % |

- En fútbol el total de goles lleva 5 % en todas las líneas; en básquet la línea principal lleva 5 % (NBA) y las alternativas 8.5 %.
- Las ligas con menos volumen llevan +1.5 a 2 puntos (Liga BetPlay, Endesa, B.League).
- El margen no crece con lo desbalanceado de la línea: de 50/50 a 95/5 se queda igual en cada mercado.

## 2. El margen se carga más en el no favorito (no proporcional)
Con el 1X2 y el "sin empate" del mismo partido (25 partidos de fútbol) se prueba cómo reparten el margen: si se quita con el método de potencias (cuota = 1/pᵏ, con k tal que Σpᵏ = 1 + margen) los dos mercados cuadran con 0.19 puntos de error (lo que da el redondeo); proporcional (1/(p·(1+m))) falla por 1.43 puntos.
Ejemplo, Medellín–Alianza 1.55 / 4.15 / 6.00 (5.3 %): el local lleva 2.6 % de margen, el empate 8.8 % y la visita 11.2 %. Justas: 1.59 / 4.51 / 6.67 (proporcional diría 1.63 / 4.37 / 6.32).

## 3. Otros detalles
- Publican hasta 1.005 (no recortan los casi seguros) y hasta 1 250.
- Escalera de cuotas: centésimos hasta 3, de 0.05 de 3 a 5, de 0.1 de 5 a 10, de 0.25–0.5 de 10 a 20, enteros de 20 a 50, de 5 o 10 arriba de 50.
- Props de jugador en básquet: escalera de un solo lado ("25+, 27+, 29+…") en vez de Más/Menos.

## Aplicado en Oddsy (2026-11-04)
Antes: un solo margen del 5 % proporcional para todo (`price`: 1/(p·1.05)).
Ahora, en los mercados de partidos (`MARGINS` y `publishable` en lib/pricing.mjs): (a) margen por tipo de mercado y (b) repartido con potencias. En las líneas muy desbalanceadas casi todo el margen cae en el no favorito; Betano hace lo mismo (goles visitante 3.5 a 12.5 / 1.01, total 7.5 a 16.5 / 1.01).
Sin aplicar: +1.5 puntos en Liga BetPlay, la escalera de cuotas, las props de un lado y el margen de los props (Betano no publica el otro lado y no se puede medir; siguen con `price` al 5 % proporcional).
