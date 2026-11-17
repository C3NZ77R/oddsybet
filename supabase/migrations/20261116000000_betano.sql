-- Lecturas de cuotas de Betano que manda el script lector (lib/betano-read.mjs): una fila por partido, que cada
-- lectura nueva pisa. Solo el servidor entra, con la service role key: RLS activado sin políticas.

create table betano_read (
  key text primary key,                     -- '<inicio en ms>|<equipo 1>|<equipo 2>' normalizados: estable entre lecturas
  start_at timestamptz not null,
  team1 text not null,
  team2 text not null,
  game jsonb not null,                      -- el objeto de gamesOf (public/betano.js): { t, teams, ml, spread, ou, btts }
  read_at timestamptz not null default now()
);
create index betano_read_start on betano_read (start_at);

alter table betano_read enable row level security;

-- Retención: los partidos que empezaron hace más de 7 días.
create extension if not exists pg_cron;
select cron.schedule('oddsy-betano-purge', '50 9 * * *', $$
  delete from public.betano_read where start_at < now() - interval '7 days';
$$);
