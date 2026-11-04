-- Registro de picks de Mejores apuestas y lo que el modelo aprende de ellos. Solo el servidor entra, con la service role
-- key: RLS activado sin políticas. Los cron del tick (cada 15 min) y del aprendizaje (diario) van aparte, como el del
-- seguimiento, porque llevan la URL de producción y el secreto del Vault.

create table pick_log (
  id text primary key,                      -- '<liga>:<partido>:<mercado>': un pick por mercado y partido
  source text not null default 'live',      -- 'live' (se mostró) | 'backfill' (reconstruido, solo para aprender)
  league text not null,
  sport text not null,
  game_id text not null,
  espn_date text not null,                  -- YYYYMMDD con el que se pidió el partido: se cierra con el mismo
  game_start timestamptz not null,
  home text,
  away text,
  market text not null,
  label text not null,
  name text not null,
  side int not null,                        -- posición de la selección en su mercado (0 = Local/A/Más/Sí)
  line numeric,
  p_raw numeric not null,                   -- probabilidad del modelo base
  p numeric not null,                       -- la mostrada (con lo aprendido); en backfill = p_raw
  min_odds numeric not null,
  x jsonb not null default '{}',            -- señales: { few, abs }
  featured boolean not null default false,  -- pick del partido: el que cuenta en el registro
  status text not null default 'pendiente', -- pendiente | ganada | perdida | nula
  margin numeric,
  score text,
  reason text,
  logged_at timestamptz not null default now(),
  settled_at timestamptz
);
create index pick_log_pending on pick_log (status, game_start);
create index pick_log_league on pick_log (league, game_start);
create index pick_log_sport on pick_log (sport, game_start);

create table pick_model (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  model jsonb not null
);

create table pick_state (
  id int primary key default 1 check (id = 1),
  backfill jsonb not null default '{}'      -- { league: índice en LEAGUES, day, from, until: 'YYYYMMDD', fails }
);
insert into pick_state default values;

alter table pick_log enable row level security;
alter table pick_model enable row level security;
alter table pick_state enable row level security;

-- Retención: 400 días de registro y de modelos.
create extension if not exists pg_cron;
select cron.schedule('oddsy-picks-purge', '40 9 * * *', $$
  delete from public.pick_log where game_start < now() - interval '400 days';
  delete from public.pick_model where created_at < now() - interval '400 days';
$$);
