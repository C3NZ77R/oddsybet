-- Registro de picks: cuota de cierre de Betano (última lectura de betano_history antes del inicio) y valor contra el
-- cierre, clv = betano_odds / close_odds − 1. Null sin lectura. Aplicar antes de desplegar: el tick ya manda las columnas.
alter table pick_log add column if not exists close_odds numeric;
alter table pick_log add column if not exists clv numeric;
