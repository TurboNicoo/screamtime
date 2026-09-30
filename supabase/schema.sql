-- ScreamTime — online ranglijst (Supabase / Postgres)
-- Plak dit hele bestand in Supabase → SQL Editor → Run. Je kunt het veilig opnieuw draaien.
--
-- Wat er online staat: username, auto (naam/merk/pk/gewicht), tijden per split, topsnelheid,
-- GPS-frequentie en helling. Geen GPS-posities, geen e-mailadressen in openbare tabellen.

-- ---------- profielen ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text not null check (username ~ '^[A-Za-z0-9_]{3,20}$'),
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_username_lower on public.profiles (lower(username));

-- profiel automatisch aanmaken bij registratie (username komt uit de sign-up metadata)
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, username) values (new.id, new.raw_user_meta_data ->> 'username');
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- is een username nog vrij? (werkt ook zonder in te loggen)
create or replace function public.username_available(name text) returns boolean
language sql stable security definer set search_path = public as $$
  select name ~ '^[A-Za-z0-9_]{3,20}$' and not exists (select 1 from public.profiles where lower(username) = lower(name));
$$;

-- ---------- runs ----------
create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  local_id text not null,
  created_at timestamptz not null default now(),
  run_at timestamptz not null,
  car_name text not null check (length(car_name) between 1 and 60),
  car_make text check (length(car_make) <= 80),
  car_hp int check (car_hp between 1 and 5000),
  car_kg int check (car_kg between 300 and 6000),
  source text not null check (source in ('phone', 'usb', 'racebox', 'ble')), -- demo-runs kunnen er niet in
  hz real not null check (hz > 0 and hz <= 100),
  slope real check (slope between -30 and 30),
  peak_kmh real not null check (peak_kmh between 0 and 520),
  verified boolean generated always as (hz >= 9.5) stored,
  unique (user_id, local_id)
);
-- v1.7: snelheidscurve (voor controle) en vermogensklasse
alter table public.runs add column if not exists trace jsonb; -- [[t (s), v (km/u), d (m)], …] max 400 punten
alter table public.runs add column if not exists class text generated always as (
  case when car_hp is null then null when car_hp <= 300 then 'k300' when car_hp <= 600 then 'k600' when car_hp <= 900 then 'k900' else 'k900p' end) stored;
create index if not exists runs_peak on public.runs (peak_kmh desc);

-- ---------- splittijden ----------
-- metric: 'S:kmh:0-100', 'S:mph:60-130', 'D:1/4', ...
create table if not exists public.splits (
  run_id uuid not null references public.runs (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  metric text not null,
  time_s real not null check (time_s > 0 and time_s <= 120),
  primary key (run_id, metric)
);
-- v1.7: remtest (B:kmh:100-0) met remweg
alter table public.splits add column if not exists dist_m real check (dist_m is null or (dist_m > 0 and dist_m < 2000));
alter table public.splits drop constraint if exists splits_metric_check;
alter table public.splits add constraint splits_metric_check check (metric ~ '^(S:(kmh|mph):[0-9]{1,3}-[0-9]{1,3}|D:(60ft|100m|1/8|1000ft|1/4|1/2|1km|1mi)|B:(kmh|mph):[0-9]{2,3}-0)$');
create index if not exists splits_metric_time on public.splits (metric, time_s);

-- Fysieke ondergrens: gemiddeld meer dan 1,7 g is voor geen enkele auto haalbaar.
create or replace function public.min_split_time(metric text) returns real
language plpgsql immutable as $$
declare kind text := split_part(metric, ':', 1); a real; b real; f real; d real;
begin
  if kind = 'B' then -- remmen: gemiddeld hooguit 1,6 g vertraging
    f := case split_part(metric, ':', 2) when 'mph' then 0.44704 else 1 / 3.6 end;
    a := split_part(split_part(metric, ':', 3), '-', 1)::real;
    return a * f / (1.6 * 9.80665);
  end if;
  if kind = 'S' then
    f := case split_part(metric, ':', 2) when 'mph' then 0.44704 else 1 / 3.6 end;
    a := split_part(split_part(metric, ':', 3), '-', 1)::real;
    b := split_part(split_part(metric, ':', 3), '-', 2)::real;
    if b <= a then return 1e9; end if;
    return (b - a) * f / (1.7 * 9.80665);
  end if;
  d := case split_part(metric, ':', 2)
    when '60ft' then 18.288 when '100m' then 100 when '1/8' then 201.168 when '1000ft' then 304.8
    when '1/4' then 402.336 when '1/2' then 804.672 when '1km' then 1000 when '1mi' then 1609.344 end;
  return sqrt(2 * d / (1.7 * 9.80665));
end $$;

-- Tijdstip waarop de curve voor het eerst de waarde x passeert (kolom col: 1 = snelheid, 2 = afstand),
-- lineair geïnterpoleerd. down = neerwaarts (laatste kruising). NULL als de curve x niet haalt.
create or replace function public.trace_cross(tr jsonb, col int, x real, down boolean default false) returns real
language plpgsql immutable as $$
declare n int := jsonb_array_length(tr); i int; ta real; tb real; va real; vb real; res real := null;
begin
  for i in 1..n - 1 loop
    ta := (tr -> (i - 1) ->> 0)::real; tb := (tr -> i ->> 0)::real;
    va := (tr -> (i - 1) ->> col)::real; vb := (tr -> i ->> col)::real;
    if not down and va < x and vb >= x then return ta + (x - va) / nullif(vb - va, 0) * (tb - ta); end if;
    if down and va > x and vb <= x then res := ta + (va - x) / nullif(va - vb, 0) * (tb - ta); end if;
  end loop;
  return res;
end $$;

create or replace function public.check_split() returns trigger language plpgsql as $$
declare tr jsonb; f real; a real; b real; ta real; tb real; d real; derived real; ddist real;
begin
  if new.time_s < public.min_split_time(new.metric) then
    raise exception 'Onrealistische tijd voor % (% s)', new.metric, round(new.time_s::numeric, 3) using errcode = '22023';
  end if;
  if not exists (select 1 from public.runs r where r.id = new.run_id and r.user_id = new.user_id) then
    raise exception 'Run hoort niet bij deze gebruiker' using errcode = '42501';
  end if;
  if split_part(new.metric, ':', 1) = 'B' then
    a := split_part(split_part(new.metric, ':', 3), '-', 1)::real * (case split_part(new.metric, ':', 2) when 'mph' then 0.44704 else 1 / 3.6 end);
    if new.dist_m is null or new.dist_m < a * a / (2 * 1.6 * 9.80665) then raise exception 'Onrealistische remweg voor %', new.metric using errcode = '22023'; end if;
  end if;
  -- Klopt de split met de meegestuurde snelheidscurve?
  select r.trace into tr from public.runs r where r.id = new.run_id;
  if tr is not null then
    f := case split_part(new.metric, ':', 2) when 'mph' then 1.609344 else 1 end;
    if split_part(new.metric, ':', 1) = 'S' then
      a := split_part(split_part(new.metric, ':', 3), '-', 1)::real * f;
      b := split_part(split_part(new.metric, ':', 3), '-', 2)::real * f;
      tb := public.trace_cross(tr, 1, b);
      ta := case when a = 0 then 0 else public.trace_cross(tr, 1, a) end;
      derived := tb - ta;
    elsif split_part(new.metric, ':', 1) = 'D' then
      d := case split_part(new.metric, ':', 2) when '60ft' then 18.288 when '100m' then 100 when '1/8' then 201.168 when '1000ft' then 304.8
        when '1/4' then 402.336 when '1/2' then 804.672 when '1km' then 1000 when '1mi' then 1609.344 end;
      derived := public.trace_cross(tr, 2, d);
    else
      a := split_part(split_part(new.metric, ':', 3), '-', 1)::real * f;
      ta := public.trace_cross(tr, 1, a, true); tb := public.trace_cross(tr, 1, 1, true);
      derived := tb - ta;
    end if;
    if derived is null or abs(derived - new.time_s) > greatest(0.3, new.time_s * 0.1) then
      raise exception 'Tijd klopt niet met de snelheidscurve (% s vs % s)', round(new.time_s::numeric, 2), round(coalesce(derived, -1)::numeric, 2) using errcode = '22023';
    end if;
  end if;
  return new;
end $$;

-- Fysieke controle van de curve bij het delen van een run.
create or replace function public.check_run() returns trigger language plpgsql as $$
declare n int; i int; j int := 0; ti real; tj real; vi real; vmax real := 0; prev real := null; acc real;
begin
  if new.trace is null then return new; end if;
  if jsonb_typeof(new.trace) <> 'array' then raise exception 'Ongeldige curve' using errcode = '22023'; end if;
  n := jsonb_array_length(new.trace);
  if n < 5 or n > 400 then raise exception 'Ongeldige curve (lengte %)', n using errcode = '22023'; end if;
  for i in 0..n - 1 loop
    ti := (new.trace -> i ->> 0)::real; vi := (new.trace -> i ->> 1)::real;
    if ti is null or vi is null or vi < 0 or vi > 560 then raise exception 'Ongeldige waarde in curve' using errcode = '22023'; end if;
    if prev is not null and ti <= prev then raise exception 'Curve loopt niet op in de tijd' using errcode = '22023'; end if;
    prev := ti; vmax := greatest(vmax, vi);
    -- versnelling over vensters van minstens 0,25 s
    while j + 1 < i and ti - (new.trace -> (j + 1) ->> 0)::real >= 0.25 loop j := j + 1; end loop;
    tj := (new.trace -> j ->> 0)::real;
    if ti - tj >= 0.25 then
      acc := (vi - (new.trace -> j ->> 1)::real) / 3.6 / (ti - tj);
      if acc > 2.0 * 9.80665 or acc < -2.6 * 9.80665 then raise exception 'Onmogelijke versnelling in curve (% g)', round((acc / 9.80665)::numeric, 2) using errcode = '22023'; end if;
    end if;
  end loop;
  if abs(vmax - new.peak_kmh) > greatest(5, new.peak_kmh * 0.06) then raise exception 'Topsnelheid klopt niet met de curve' using errcode = '22023'; end if;
  return new;
end $$;
drop trigger if exists runs_check on public.runs;
create trigger runs_check before insert or update on public.runs for each row execute function public.check_run();
drop trigger if exists splits_check on public.splits;
create trigger splits_check before insert or update on public.splits for each row execute function public.check_split();

-- ---------- vrienden (volgen: jij voegt iemand toe aan jouw lijst) ----------
create table if not exists public.friends (
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  friend_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, friend_id),
  check (user_id <> friend_id)
);

-- ---------- ranglijsten ----------
-- Ranglijsten. Alleen runs met snelheidscurve (gecontroleerd) en maximaal 1% helling tellen mee.
drop view if exists public.best_times; drop view if exists public.best_times_class;
drop view if exists public.top_speeds; drop view if exists public.top_speeds_class; drop view if exists public.best_brakes;
create view public.best_times with (security_invoker = true) as
select distinct on (s.user_id, s.metric)
  s.metric, s.time_s, s.user_id, p.username, r.car_name, r.car_make, r.car_hp, r.verified, r.hz, r.run_at, r.class, r.id as run_id
from public.splits s
join public.runs r on r.id = s.run_id
join public.profiles p on p.id = s.user_id
where (r.slope is null or abs(r.slope) <= 1) and r.trace is not null and s.metric not like 'B:%'
order by s.user_id, s.metric, s.time_s, r.run_at;
-- Beste tijd per gebruiker per onderdeel per vermogensklasse.
create view public.best_times_class with (security_invoker = true) as
select distinct on (s.user_id, s.metric, r.class)
  s.metric, s.time_s, s.user_id, p.username, r.car_name, r.car_make, r.car_hp, r.verified, r.hz, r.run_at, r.class, r.id as run_id
from public.splits s
join public.runs r on r.id = s.run_id
join public.profiles p on p.id = s.user_id
where (r.slope is null or abs(r.slope) <= 1) and r.trace is not null and s.metric not like 'B:%' and r.class is not null
order by s.user_id, s.metric, r.class, s.time_s, r.run_at;
-- Kortste remweg per gebruiker.
create view public.best_brakes with (security_invoker = true) as
select distinct on (s.user_id, s.metric)
  s.metric, s.time_s, s.dist_m, s.user_id, p.username, r.car_name, r.car_make, r.car_hp, r.verified, r.hz, r.run_at, r.class, r.id as run_id
from public.splits s
join public.runs r on r.id = s.run_id
join public.profiles p on p.id = s.user_id
where (r.slope is null or abs(r.slope) <= 1) and r.trace is not null and s.metric like 'B:%'
order by s.user_id, s.metric, s.dist_m, r.run_at;

-- Hoogste gemeten snelheid per gebruiker (ook hier telt bergaf niet mee), en per klasse.
create view public.top_speeds with (security_invoker = true) as
select distinct on (r.user_id)
  r.user_id, p.username, r.peak_kmh, r.car_name, r.car_make, r.car_hp, r.verified, r.hz, r.run_at, r.class, r.id as run_id
from public.runs r
join public.profiles p on p.id = r.user_id
where (r.slope is null or abs(r.slope) <= 1) and r.trace is not null
order by r.user_id, r.peak_kmh desc, r.run_at;
create view public.top_speeds_class with (security_invoker = true) as
select distinct on (r.user_id, r.class)
  r.user_id, p.username, r.peak_kmh, r.car_name, r.car_make, r.car_hp, r.verified, r.hz, r.run_at, r.class, r.id as run_id
from public.runs r
join public.profiles p on p.id = r.user_id
where (r.slope is null or abs(r.slope) <= 1) and r.trace is not null and r.class is not null
order by r.user_id, r.class, r.peak_kmh desc, r.run_at;

-- ---------- meldingen van verdachte tijden (alleen zichtbaar in het Supabase-dashboard) ----------
create table if not exists public.reports (
  id bigint generated always as identity primary key,
  run_id uuid not null references public.runs (id) on delete cascade,
  reporter uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  reason text not null check (length(reason) between 1 and 300),
  created_at timestamptz not null default now(),
  unique (run_id, reporter)
);
alter table public.reports enable row level security;
drop policy if exists "melding doen" on public.reports;
create policy "melding doen" on public.reports for insert to authenticated with check (reporter = auth.uid());

-- ---------- foutmeldingen uit de app (alleen zichtbaar in het dashboard) ----------
create table if not exists public.client_errors (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  version text check (length(version) <= 20),
  message text not null check (length(message) <= 500),
  stack text check (length(stack) <= 2000),
  agent text check (length(agent) <= 200)
);
alter table public.client_errors enable row level security;
drop policy if exists "fout melden" on public.client_errors;
create policy "fout melden" on public.client_errors for insert to anon, authenticated with check (true);

-- ---------- account verwijderen (alles gaat mee via cascade) ----------
create or replace function public.delete_me() returns void
language sql security definer set search_path = public, auth as $$
  delete from auth.users where id = auth.uid();
$$;

-- ---------- beveiliging (Row Level Security) ----------
alter table public.profiles enable row level security;
alter table public.runs enable row level security;
alter table public.splits enable row level security;
alter table public.friends enable row level security;

drop policy if exists "profielen zichtbaar" on public.profiles;
create policy "profielen zichtbaar" on public.profiles for select to anon, authenticated using (true);
drop policy if exists "eigen profiel wijzigen" on public.profiles;
create policy "eigen profiel wijzigen" on public.profiles for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists "runs zichtbaar" on public.runs;
create policy "runs zichtbaar" on public.runs for select to anon, authenticated using (true);
drop policy if exists "eigen runs toevoegen" on public.runs;
create policy "eigen runs toevoegen" on public.runs for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "eigen runs verwijderen" on public.runs;
create policy "eigen runs verwijderen" on public.runs for delete to authenticated using (user_id = auth.uid());

drop policy if exists "splits zichtbaar" on public.splits;
create policy "splits zichtbaar" on public.splits for select to anon, authenticated using (true);
drop policy if exists "eigen splits toevoegen" on public.splits;
create policy "eigen splits toevoegen" on public.splits for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "eigen vriendenlijst" on public.friends;
create policy "eigen vriendenlijst" on public.friends for select to authenticated using (user_id = auth.uid());
drop policy if exists "vriend toevoegen" on public.friends;
create policy "vriend toevoegen" on public.friends for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "vriend verwijderen" on public.friends;
create policy "vriend verwijderen" on public.friends for delete to authenticated using (user_id = auth.uid());

-- Tabelrechten voor de app (nieuwe Supabase-projecten geven die niet meer automatisch).
-- Wat iemand precies mag, bepalen daarna de RLS-regels hierboven.
grant usage on schema public to anon, authenticated;
grant select on public.profiles, public.runs, public.splits to anon, authenticated;
grant update (username) on public.profiles to authenticated;
grant insert, delete on public.runs to authenticated;
grant insert on public.splits to authenticated;
grant select, insert, delete on public.friends to authenticated;
grant select on public.best_times, public.best_times_class, public.best_brakes, public.top_speeds, public.top_speeds_class to anon, authenticated;
grant insert on public.reports to authenticated;
grant insert on public.client_errors to anon, authenticated;
revoke all on function public.delete_me() from public, anon;
grant execute on function public.delete_me() to authenticated;
grant execute on function public.username_available(text) to anon, authenticated;
