-- Historial de las lecturas de Betano (lib/betano-read.mjs): una fila cada vez que cambian las cuotas de un partido que
-- no ha empezado, con la hora desde la que rigen (read_at). La cuota vigente en un momento es la fila más reciente con
-- read_at anterior. Solo el servidor entra, con la service role key: RLS activado sin políticas.

create table betano_history (
  key text not null,                        -- la misma clave de betano_read
  read_at timestamptz not null default now(),
  start_at timestamptz not null,
  game jsonb not null,                      -- el objeto de gamesOf (public/betano.js)
  primary key (key, read_at)
);
create index betano_history_start on betano_history (start_at);

alter table betano_history enable row level security;

-- Retención: 120 días, lo que mira el aprendizaje del registro de picks (LEARN_DAYS).
select cron.schedule('oddsy-betano-history-purge', '55 9 * * *', $$
  delete from public.betano_history where start_at < now() - interval '120 days';
$$);
