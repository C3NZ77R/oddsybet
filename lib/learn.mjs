// Lo que el modelo aprende de sus picks cerrados (registro en lib/picklog.mjs). Señales por partido y un ajuste
// logístico por deporte sobre la p del modelo: logit p' = a_mercado + b_mercado·logit p + c_liga + w·señales.
// Sin ajuste en uso (o sin base), p' = p: nada de esto puede tumbar Mejores apuestas.

// Partidos desde los que la muestra ya no es "poca": temporada actual del equipo con menos, o historia Elo del tenista.
export const FEW_N = { soccer: 10, basketball: 10, tennis: 20 };
export const fewOf = (sport, n) => Math.max(0, 1 - (n ?? 0) / FEW_N[sport]);
