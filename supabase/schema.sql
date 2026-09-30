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
create index if not exists runs_peak on public.runs (peak_kmh desc);

-- ---------- splittijden ----------
-- metric: 'S:kmh:0-100', 'S:mph:60-130', 'D:1/4', ...
create table if not exists public.splits (
  run_id uuid not null references public.runs (id) on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  metric text not null check (metric ~ '^(S:(kmh|mph):[0-9]{1,3}-[0-9]{1,3}|D:(60ft|100m|1/8|1000ft|1/4|1/2|1km|1mi))$'),
  time_s real not null check (time_s > 0 and time_s <= 120),
  primary key (run_id, metric)
);
create index if not exists splits_metric_time on public.splits (metric, time_s);

-- Fysieke ondergrens: gemiddeld meer dan 1,7 g is voor geen enkele auto haalbaar.
create or replace function public.min_split_time(metric text) returns real
language plpgsql immutable as $$
declare kind text := split_part(metric, ':', 1); a real; b real; f real; d real;
begin
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

create or replace function public.check_split() returns trigger language plpgsql as $$
begin
  if new.time_s < public.min_split_time(new.metric) then
    raise exception 'Onrealistische tijd voor % (% s)', new.metric, round(new.time_s::numeric, 3) using errcode = '22023';
  end if;
  if not exists (select 1 from public.runs r where r.id = new.run_id and r.user_id = new.user_id) then
    raise exception 'Run hoort niet bij deze gebruiker' using errcode = '42501';
  end if;
  return new;
end $$;
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
-- Beste tijd per gebruiker per onderdeel. Runs met meer dan 1% helling tellen niet mee.
create or replace view public.best_times with (security_invoker = true) as
select distinct on (s.user_id, s.metric)
  s.metric, s.time_s, s.user_id, p.username, r.car_name, r.car_make, r.car_hp, r.verified, r.hz, r.run_at
from public.splits s
join public.runs r on r.id = s.run_id
join public.profiles p on p.id = s.user_id
where r.slope is null or abs(r.slope) <= 1
order by s.user_id, s.metric, s.time_s, r.run_at;

-- Hoogste gemeten snelheid per gebruiker (ook hier telt bergaf niet mee).
create or replace view public.top_speeds with (security_invoker = true) as
select distinct on (r.user_id)
  r.user_id, p.username, r.peak_kmh, r.car_name, r.car_make, r.car_hp, r.verified, r.hz, r.run_at
from public.runs r
join public.profiles p on p.id = r.user_id
where r.slope is null or abs(r.slope) <= 1
order by r.user_id, r.peak_kmh desc, r.run_at;

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
grant select on public.best_times, public.top_speeds to anon, authenticated;
revoke all on function public.delete_me() from public, anon;
grant execute on function public.delete_me() to authenticated;
grant execute on function public.username_available(text) to anon, authenticated;
