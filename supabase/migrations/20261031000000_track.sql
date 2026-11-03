-- Seguimiento de apuestas de NBA: dispositivos, apuestas, selecciones, contador de lecturas del ticket y el candado
-- del tick. Solo el servidor entra, con la service role key: RLS activado sin políticas. El job del tick va aparte.

create table track_devices (
  id uuid primary key default gen_random_uuid(),
  secret_hash text not null,              -- sha-256 hex del secreto que guarda el navegador
  subscription jsonb not null,            -- PushSubscription: endpoint + keys
  platform text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table track_bets (
  id uuid primary key default gen_random_uuid(),
  device_id uuid not null references track_devices on delete cascade,
  book text,
  odds numeric,
  status text not null default 'pendiente',
  notified jsonb not null default '{}',
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index track_bets_status on track_bets (status);
create index track_bets_device on track_bets (device_id);

create table track_selections (
  id uuid primary key default gen_random_uuid(),
  bet_id uuid not null references track_bets on delete cascade,
  league text not null default 'nba',
  game_id text,
  game_start timestamptz,
  market text not null,
  stat text,
  athlete_id text,
  athlete_name text,
  side text,
  line numeric,
  odds numeric,
  label text not null,
  prior jsonb,
  status text not null,
  current numeric,
  state jsonb not null default '{}'
);
create index track_selections_bet on track_selections (bet_id);

create table track_reads (
  day date not null,
  key text not null,                      -- 'global', 'device:<id>', 'ip:<ip>'
  n int not null default 0,
  primary key (day, key)
);

create table track_lease (
  id int primary key default 1 check (id = 1),
  until timestamptz not null default 'epoch'
);
insert into track_lease default values;

alter table track_devices enable row level security;
alter table track_bets enable row level security;
alter table track_selections enable row level security;
alter table track_reads enable row level security;
alter table track_lease enable row level security;

-- Suma una lectura a cada clave solo si ninguna llegó a su límite. Atómica: bloquea las filas en orden de clave.
create or replace function track_bump(p_day date, p_keys text[], p_limits int[]) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  insert into track_reads (day, key) select p_day, k from unnest(p_keys) as k on conflict do nothing;
  perform 1 from track_reads where day = p_day and key = any (p_keys) order by key for update;
  if exists (
    select 1 from track_reads r join unnest(p_keys, p_limits) as l (k, lim) on r.key = l.k
    where r.day = p_day and r.n >= l.lim
  ) then
    return false;
  end if;
  update track_reads set n = n + 1 where day = p_day and key = any (p_keys);
  return true;
end $$;

-- Candado del tick: true si nadie lo tiene (o venció) y ahora es nuestro por p_seconds.
create or replace function track_take_lease(p_seconds int) returns boolean
language sql security definer set search_path = public as $$
  with u as (
    update track_lease set until = now() + p_seconds * interval '1 second' where id = 1 and until < now() returning 1
  )
  select exists (select 1 from u);
$$;

revoke execute on function track_bump(date, text[], int[]) from public, anon, authenticated;
revoke execute on function track_take_lease(int) from public, anon, authenticated;

-- Retención: apuestas liquidadas a los 7 días; dispositivos sin actividad a los 60 (con sus apuestas).
create extension if not exists pg_cron;
select cron.schedule('oddsy-track-purge', '17 9 * * *', $$
  delete from public.track_bets where status not in ('pendiente', 'en_juego') and settled_at < now() - interval '7 days';
  delete from public.track_devices where last_seen_at < now() - interval '60 days';
$$);
