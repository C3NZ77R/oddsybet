-- Registro de picks: la cuota de Betano al congelar el pick y su ventaja (p × cuota − 1). Opcionales: las filas viejas,
-- el relleno y los picks sin lectura fresca quedan en null. Aplicar antes de desplegar: el tick ya manda las columnas.
alter table pick_log add column if not exists betano_odds numeric;
alter table pick_log add column if not exists betano_edge numeric;
