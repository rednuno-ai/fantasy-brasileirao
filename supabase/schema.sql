-- Fantasy Brasileirão — schema completo (Supabase / Postgres)
-- Corre isto uma vez em SQL Editor → New query → Run.
-- Seguro de rodar mais de uma vez (usa "if not exists" / "on conflict do nothing").

-- ============================================================
-- 0. TIPOS
-- ============================================================
do $$ begin
  create type public.player_position as enum ('GOL', 'ZAG', 'LAT', 'MEI', 'ATA');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.player_status as enum ('disponivel', 'lesionado', 'suspenso', 'duvida', 'emprestado');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.gameweek_status as enum ('agendada', 'mercado_aberto', 'mercado_fechado', 'em_andamento', 'finalizada');
exception when duplicate_object then null; end $$;

do $$ begin
  create type public.fixture_status as enum ('agendado', 'em_andamento', 'finalizado', 'adiado');
exception when duplicate_object then null; end $$;

-- ============================================================
-- 1. PROFILES (perfil público de cada utilizador)
-- ============================================================
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  team_name text not null default 'Meu Time',
  avatar_url text,
  role text not null default 'user' check (role in ('user', 'admin')),
  created_at timestamptz not null default now()
);

alter table public.profiles enable row level security;

drop policy if exists "profiles: leitura pública" on public.profiles;
create policy "profiles: leitura pública" on public.profiles for select using (true);

drop policy if exists "profiles: utilizador edita o próprio perfil" on public.profiles;
create policy "profiles: utilizador edita o próprio perfil" on public.profiles for update using (auth.uid() = id);

drop policy if exists "profiles: utilizador cria o próprio perfil" on public.profiles;
create policy "profiles: utilizador cria o próprio perfil" on public.profiles for insert with check (auth.uid() = id);

create or replace function public.fb_handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, username, team_name)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'craque_' || substr(new.id::text, 1, 8)),
    coalesce(new.raw_user_meta_data->>'team_name', 'Meu Time')
  )
  on conflict (id) do nothing;
  return new;
end;
$$ language plpgsql security definer set search_path = public;

drop trigger if exists fb_on_auth_user_created on auth.users;
create trigger fb_on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.fb_handle_new_user();

-- função auxiliar: é admin?
create or replace function public.fb_is_admin()
returns boolean as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$ language sql security definer stable set search_path = public;

-- ============================================================
-- 2. CLUBS (os 20 clubes da Série A)
-- ============================================================
create table if not exists public.clubs (
  id serial primary key,
  name text not null unique,
  short_name text not null,
  slug text not null unique,
  city text not null,
  state text not null,
  primary_color text not null,
  secondary_color text not null,
  crest_url text,
  cbf_club_id text,
  created_at timestamptz not null default now()
);

alter table public.clubs enable row level security;

drop policy if exists "clubs: leitura pública" on public.clubs;
create policy "clubs: leitura pública" on public.clubs for select using (true);

drop policy if exists "clubs: só admin escreve" on public.clubs;
create policy "clubs: só admin escreve" on public.clubs for all using (public.fb_is_admin()) with check (public.fb_is_admin());

-- ============================================================
-- 3. SEASONS & GAMEWEEKS (temporadas e rodadas)
-- ============================================================
create table if not exists public.seasons (
  id serial primary key,
  year integer not null unique,
  name text not null,
  is_active boolean not null default false,
  budget_brl numeric(14,2) not null default 150000000,
  created_at timestamptz not null default now()
);

alter table public.seasons enable row level security;
drop policy if exists "seasons: leitura pública" on public.seasons;
create policy "seasons: leitura pública" on public.seasons for select using (true);
drop policy if exists "seasons: só admin escreve" on public.seasons;
create policy "seasons: só admin escreve" on public.seasons for all using (public.fb_is_admin()) with check (public.fb_is_admin());

create table if not exists public.gameweeks (
  id serial primary key,
  season_id integer not null references public.seasons(id) on delete cascade,
  number integer not null,
  name text not null,
  deadline_at timestamptz not null,
  status public.gameweek_status not null default 'agendada',
  is_special_market boolean not null default false,
  created_at timestamptz not null default now(),
  unique (season_id, number)
);

alter table public.gameweeks enable row level security;
drop policy if exists "gameweeks: leitura pública" on public.gameweeks;
create policy "gameweeks: leitura pública" on public.gameweeks for select using (true);
drop policy if exists "gameweeks: só admin escreve" on public.gameweeks;
create policy "gameweeks: só admin escreve" on public.gameweeks for all using (public.fb_is_admin()) with check (public.fb_is_admin());

-- ============================================================
-- 4. FIXTURES (jogos de cada rodada)
-- ============================================================
create table if not exists public.fixtures (
  id serial primary key,
  gameweek_id integer not null references public.gameweeks(id) on delete cascade,
  home_club_id integer not null references public.clubs(id),
  away_club_id integer not null references public.clubs(id),
  kickoff_at timestamptz not null,
  home_score integer,
  away_score integer,
  status public.fixture_status not null default 'agendado',
  created_at timestamptz not null default now(),
  unique (gameweek_id, home_club_id, away_club_id)
);

alter table public.fixtures enable row level security;
drop policy if exists "fixtures: leitura pública" on public.fixtures;
create policy "fixtures: leitura pública" on public.fixtures for select using (true);
drop policy if exists "fixtures: só admin escreve" on public.fixtures;
create policy "fixtures: só admin escreve" on public.fixtures for all using (public.fb_is_admin()) with check (public.fb_is_admin());

-- ============================================================
-- 5. PLAYERS (elenco oficial, ligado ao clube atual)
-- ============================================================
create table if not exists public.players (
  id serial primary key,
  club_id integer not null references public.clubs(id) on delete cascade,
  name text not null,
  full_name text,
  position public.player_position not null,
  shirt_number integer,
  birth_date date,
  nationality text,
  photo_url text,
  status public.player_status not null default 'disponivel',
  market_value_eur numeric(14,2),
  market_value_brl numeric(14,2) not null default 0,
  exchange_rate_used numeric(10,4),
  value_updated_at timestamptz,
  transfermarkt_id text,
  cbf_athlete_id text,
  zerozero_id text,
  sofascore_id text,
  season_matches integer not null default 0,
  season_goals integer not null default 0,
  season_yellow_cards integer not null default 0,
  season_red_cards integer not null default 0,
  season_stats_updated_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists players_club_idx on public.players(club_id);
create index if not exists players_position_idx on public.players(position);
create unique index if not exists players_transfermarkt_id_idx on public.players(transfermarkt_id) where transfermarkt_id is not null;
create unique index if not exists players_cbf_athlete_id_idx on public.players(cbf_athlete_id) where cbf_athlete_id is not null;
create unique index if not exists players_zerozero_id_idx on public.players(zerozero_id) where zerozero_id is not null;

alter table public.players enable row level security;
drop policy if exists "players: leitura pública" on public.players;
create policy "players: leitura pública" on public.players for select using (true);
drop policy if exists "players: só admin escreve" on public.players;
create policy "players: só admin escreve" on public.players for all using (public.fb_is_admin()) with check (public.fb_is_admin());

-- histórico de valores de mercado (para gráfico de evolução e auditoria do import anual)
create table if not exists public.market_value_history (
  id bigserial primary key,
  player_id integer not null references public.players(id) on delete cascade,
  market_value_eur numeric(14,2),
  market_value_brl numeric(14,2) not null,
  exchange_rate_used numeric(10,4),
  source text not null default 'transfermarkt',
  recorded_at timestamptz not null default now()
);

alter table public.market_value_history enable row level security;
drop policy if exists "market_value_history: leitura pública" on public.market_value_history;
create policy "market_value_history: leitura pública" on public.market_value_history for select using (true);
drop policy if exists "market_value_history: só admin escreve" on public.market_value_history;
create policy "market_value_history: só admin escreve" on public.market_value_history for all using (public.fb_is_admin()) with check (public.fb_is_admin());

-- ============================================================
-- 6. SCORING RULES (pontuação configurável pelo admin)
-- ============================================================
create table if not exists public.scoring_rules (
  event_key text primary key,
  label text not null,
  points numeric(6,2) not null,
  position_scope public.player_position[], -- null = todas as posições
  description text,
  auto_computed boolean not null default false -- true = alimentado automaticamente pelo import semanal da CBF; false = só por edição manual do admin
);

alter table public.scoring_rules enable row level security;
drop policy if exists "scoring_rules: leitura pública" on public.scoring_rules;
create policy "scoring_rules: leitura pública" on public.scoring_rules for select using (true);
drop policy if exists "scoring_rules: só admin escreve" on public.scoring_rules;
create policy "scoring_rules: só admin escreve" on public.scoring_rules for all using (public.fb_is_admin()) with check (public.fb_is_admin());

-- auto_computed = true: alimentado toda quarta-feira pelo import automático dos dados oficiais da CBF
-- (gols, cartões e resultado por partida são o que a CBF publica por atleta). O resto fica disponível
-- para o admin ajustar manualmente por partida, para ligas que queiram mais detalhe.
insert into public.scoring_rules (event_key, label, points, position_scope, description, auto_computed) values
  ('gol',              'Gol',                             8.0, array['ZAG','LAT','MEI','ATA']::public.player_position[], 'Cada gol marcado por jogador de linha', true),
  ('gol_goleiro',      'Gol de goleiro',                  10.0, array['GOL']::public.player_position[], 'Gol raro marcado pelo goleiro', true),
  ('hat_trick_bonus',  'Bônus hat-trick (3+ gols)',        5.0, null, 'Bônus extra ao marcar 3 ou mais gols na mesma partida', true),
  ('vitoria',          'Vitória do clube (em campo)',      3.0, null, 'Jogador que atuou e o clube venceu', true),
  ('empate',           'Empate do clube (em campo)',       1.0, null, 'Jogador que atuou e o clube empatou', true),
  ('derrota',          'Derrota do clube (em campo)',     -2.0, null, 'Jogador que atuou e o clube perdeu', true),
  ('cartao_amarelo',   'Cartão amarelo',                  -1.0, null, null, true),
  ('cartao_vermelho',  'Cartão vermelho',                 -3.0, null, null, true),
  ('jogo_sem_sofrer',  'Jogo sem sofrer gol (SG)',          5.0, array['GOL','ZAG','LAT']::public.player_position[], 'Clean sheet, clube não sofreu gol na partida', true),
  ('gol_sofrido',      'Gol sofrido',                     -1.0, array['GOL','ZAG','LAT']::public.player_position[], 'Por gol sofrido pelo clube, jogador em campo', true),
  ('assistencia',      'Assistência',                      5.0, null, 'Passe imediatamente anterior ao gol (não publicado pela CBF; preenchido via zerozero.pt quando disponível, senão manual)', false),
  ('gol_contra',       'Gol contra',                      -3.0, null, 'Manual — não distinguido pela CBF nas estatísticas do atleta', false),
  ('penalti_perdido',  'Pênalti perdido',                 -4.0, null, 'Manual', false),
  ('penalti_cometido', 'Pênalti cometido',                -1.0, null, 'Manual', false),
  ('penalti_sofrido',  'Pênalti sofrido',                  1.0, null, 'Manual', false),
  ('penalti_defendido','Pênalti defendido (goleiro)',      7.0, array['GOL']::public.player_position[], 'Manual', false),
  ('defesa_dificil',   'Defesa difícil (goleiro)',         1.5, array['GOL']::public.player_position[], 'Manual, por defesa', false),
  ('atacante_apagado', 'Atacante sem participar de gol',  -1.0, array['ATA']::public.player_position[], 'Manual — atacante que joga 75+ minutos sem gol nem assistência', false),
  ('finalizacao_trave','Bola na trave',                    3.0, null, 'Manual', false),
  ('desarme',          'Desarme',                          1.0, null, 'Manual', false),
  ('falta_sofrida',    'Falta sofrida',                    0.3, null, 'Manual', false),
  ('falta_cometida',   'Falta cometida',                  -0.3, null, 'Manual', false),
  ('impedimento',      'Impedimento',                     -0.2, null, 'Manual', false)
on conflict (event_key) do nothing;

-- ============================================================
-- 6b. CBF SNAPSHOTS (totais acumulados oficiais, capturados toda quarta-feira)
-- A CBF só publica totais acumulados da temporada por atleta (jogos, gols, cartões),
-- não estatísticas isoladas por partida. Guardamos aqui uma foto semanal e calculamos
-- a diferença em relação à semana anterior para saber o que aconteceu "nesta rodada".
-- ============================================================
create table if not exists public.player_cbf_snapshots (
  id bigserial primary key,
  player_id integer not null references public.players(id) on delete cascade,
  gameweek_id integer not null references public.gameweeks(id) on delete cascade,
  cumulative_matches integer not null default 0,
  cumulative_goals integer not null default 0,
  cumulative_yellow_cards integer not null default 0,
  cumulative_red_cards integer not null default 0,
  snapshotted_at timestamptz not null default now(),
  unique (player_id, gameweek_id)
);

alter table public.player_cbf_snapshots enable row level security;
drop policy if exists "player_cbf_snapshots: leitura pública" on public.player_cbf_snapshots;
create policy "player_cbf_snapshots: leitura pública" on public.player_cbf_snapshots for select using (true);
drop policy if exists "player_cbf_snapshots: só admin escreve" on public.player_cbf_snapshots;
create policy "player_cbf_snapshots: só admin escreve" on public.player_cbf_snapshots for all using (public.fb_is_admin()) with check (public.fb_is_admin());

-- ============================================================
-- 7. PLAYER STATS (estatísticas por jogador por partida — alimenta a pontuação)
-- ============================================================
create table if not exists public.player_stats (
  id bigserial primary key,
  fixture_id integer not null references public.fixtures(id) on delete cascade,
  player_id integer not null references public.players(id) on delete cascade,
  minutes_played integer not null default 0,
  goals integer not null default 0,
  goals_goalkeeper integer not null default 0,
  assists integer not null default 0,
  yellow_cards integer not null default 0,
  red_cards integer not null default 0,
  own_goals integer not null default 0,
  penalties_missed integer not null default 0,
  penalties_committed integer not null default 0,
  penalties_won integer not null default 0,
  penalties_saved integer not null default 0,
  difficult_saves integer not null default 0,
  goals_conceded integer not null default 0,
  clean_sheet boolean not null default false,
  shots_woodwork integer not null default 0,
  tackles integer not null default 0,
  fouls_suffered integer not null default 0,
  fouls_committed integer not null default 0,
  offsides integer not null default 0,
  result text check (result in ('vitoria', 'empate', 'derrota')),
  fantasy_points numeric(8,2) not null default 0,
  source text not null default 'manual',
  updated_at timestamptz not null default now(),
  unique (fixture_id, player_id)
);

create index if not exists player_stats_fixture_idx on public.player_stats(fixture_id);
create index if not exists player_stats_player_idx on public.player_stats(player_id);

alter table public.player_stats enable row level security;
drop policy if exists "player_stats: leitura pública" on public.player_stats;
create policy "player_stats: leitura pública" on public.player_stats for select using (true);
drop policy if exists "player_stats: só admin escreve" on public.player_stats;
create policy "player_stats: só admin escreve" on public.player_stats for all using (public.fb_is_admin()) with check (public.fb_is_admin());

-- calcula fantasy_points de uma linha de player_stats a partir das scoring_rules
create or replace function public.fb_calculate_points(s public.player_stats)
returns numeric as $$
declare
  pts numeric := 0;
  pos public.player_position;
  rule record;
begin
  select position into pos from public.players where id = s.player_id;

  for rule in select * from public.scoring_rules loop
    if rule.position_scope is not null and not (pos = any(rule.position_scope)) then
      continue;
    end if;

    pts := pts + case rule.event_key
      when 'gol' then s.goals * rule.points
      when 'gol_goleiro' then s.goals_goalkeeper * rule.points
      when 'assistencia' then s.assists * rule.points
      when 'hat_trick_bonus' then (case when s.goals >= 3 then rule.points else 0 end)
      when 'vitoria' then (case when s.result = 'vitoria' and s.minutes_played > 0 then rule.points else 0 end)
      when 'empate' then (case when s.result = 'empate' and s.minutes_played > 0 then rule.points else 0 end)
      when 'derrota' then (case when s.result = 'derrota' and s.minutes_played > 0 then rule.points else 0 end)
      when 'cartao_amarelo' then s.yellow_cards * rule.points
      when 'cartao_vermelho' then s.red_cards * rule.points
      when 'gol_contra' then s.own_goals * rule.points
      when 'penalti_perdido' then s.penalties_missed * rule.points
      when 'penalti_cometido' then s.penalties_committed * rule.points
      when 'penalti_sofrido' then s.penalties_won * rule.points
      when 'penalti_defendido' then s.penalties_saved * rule.points
      when 'defesa_dificil' then s.difficult_saves * rule.points
      when 'jogo_sem_sofrer' then (case when s.clean_sheet and s.minutes_played >= 60 then rule.points else 0 end)
      when 'gol_sofrido' then s.goals_conceded * rule.points
      when 'atacante_apagado' then (case when s.minutes_played >= 75 and s.goals = 0 and s.assists = 0 then rule.points else 0 end)
      when 'finalizacao_trave' then s.shots_woodwork * rule.points
      when 'desarme' then s.tackles * rule.points
      when 'falta_sofrida' then s.fouls_suffered * rule.points
      when 'falta_cometida' then s.fouls_committed * rule.points
      when 'impedimento' then s.offsides * rule.points
      else 0
    end;
  end loop;

  return round(pts, 2);
end;
$$ language plpgsql stable;

create or replace function public.fb_player_stats_set_points()
returns trigger as $$
begin
  new.fantasy_points := public.fb_calculate_points(new);
  new.updated_at := now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists fb_player_stats_before_write on public.player_stats;
create trigger fb_player_stats_before_write
  before insert or update on public.player_stats
  for each row execute procedure public.fb_player_stats_set_points();

-- ============================================================
-- 8. FANTASY TEAMS (o time de cada utilizador)
-- ============================================================
create table if not exists public.fantasy_teams (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  season_id integer not null references public.seasons(id) on delete cascade,
  formation text not null default '4-3-3',
  captain_player_id integer references public.players(id),
  budget_spent_brl numeric(14,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, season_id)
);

alter table public.fantasy_teams enable row level security;
drop policy if exists "fantasy_teams: leitura pública" on public.fantasy_teams;
create policy "fantasy_teams: leitura pública" on public.fantasy_teams for select using (true);
drop policy if exists "fantasy_teams: dono gere o próprio time" on public.fantasy_teams;
create policy "fantasy_teams: dono gere o próprio time" on public.fantasy_teams for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

create table if not exists public.fantasy_team_players (
  id bigserial primary key,
  fantasy_team_id uuid not null references public.fantasy_teams(id) on delete cascade,
  player_id integer not null references public.players(id),
  is_starting boolean not null default true,
  purchase_price_brl numeric(14,2) not null,
  added_at timestamptz not null default now(),
  unique (fantasy_team_id, player_id)
);

alter table public.fantasy_team_players enable row level security;
drop policy if exists "fantasy_team_players: leitura pública" on public.fantasy_team_players;
create policy "fantasy_team_players: leitura pública" on public.fantasy_team_players for select using (true);
drop policy if exists "fantasy_team_players: dono gere o próprio elenco" on public.fantasy_team_players;
create policy "fantasy_team_players: dono gere o próprio elenco" on public.fantasy_team_players for all using (
  exists (select 1 from public.fantasy_teams t where t.id = fantasy_team_id and t.user_id = auth.uid())
) with check (
  exists (select 1 from public.fantasy_teams t where t.id = fantasy_team_id and t.user_id = auth.uid())
);

-- transferências por rodada (para aplicar a regra de "1 troca livre por rodada")
create table if not exists public.transfers (
  id bigserial primary key,
  fantasy_team_id uuid not null references public.fantasy_teams(id) on delete cascade,
  gameweek_id integer not null references public.gameweeks(id),
  player_out_id integer references public.players(id),
  player_in_id integer references public.players(id),
  was_free boolean not null default true,
  point_penalty numeric(6,2) not null default 0,
  created_at timestamptz not null default now()
);

alter table public.transfers enable row level security;
drop policy if exists "transfers: dono vê/gere as próprias trocas" on public.transfers;
create policy "transfers: dono vê/gere as próprias trocas" on public.transfers for all using (
  exists (select 1 from public.fantasy_teams t where t.id = fantasy_team_id and t.user_id = auth.uid())
) with check (
  exists (select 1 from public.fantasy_teams t where t.id = fantasy_team_id and t.user_id = auth.uid())
);

-- pontuação do time por rodada (snapshot, calculado no fecho da rodada)
create table if not exists public.fantasy_team_gameweek_score (
  id bigserial primary key,
  fantasy_team_id uuid not null references public.fantasy_teams(id) on delete cascade,
  gameweek_id integer not null references public.gameweeks(id) on delete cascade,
  points numeric(8,2) not null default 0,
  rank integer,
  created_at timestamptz not null default now(),
  unique (fantasy_team_id, gameweek_id)
);

alter table public.fantasy_team_gameweek_score enable row level security;
drop policy if exists "fantasy_team_gameweek_score: leitura pública" on public.fantasy_team_gameweek_score;
create policy "fantasy_team_gameweek_score: leitura pública" on public.fantasy_team_gameweek_score for select using (true);
drop policy if exists "fantasy_team_gameweek_score: só admin escreve" on public.fantasy_team_gameweek_score;
create policy "fantasy_team_gameweek_score: só admin escreve" on public.fantasy_team_gameweek_score for all using (public.fb_is_admin()) with check (public.fb_is_admin());

-- ============================================================
-- 8b. LEADERBOARD (view pronta para a página de Classificação)
-- ============================================================
create or replace view public.leaderboard as
select
  t.id as fantasy_team_id,
  t.user_id,
  t.season_id,
  p.team_name,
  p.username,
  coalesce(sum(s.points), 0) as total_points,
  count(s.id) as gameweeks_scored
from public.fantasy_teams t
join public.profiles p on p.id = t.user_id
left join public.fantasy_team_gameweek_score s on s.fantasy_team_id = t.id
group by t.id, t.user_id, t.season_id, p.team_name, p.username;

-- ============================================================
-- 8b2. CHIPS (ideia trazida do Fantasy Premier League: Capitão Triplo e Banco
-- Reforçado, um uso por metade da época cada — 38 rodadas / 2 = corte na 19).
-- Wildcard e Free Hit ficam para depois (dependem de um sistema de limite de
-- transferências que ainda não existe).
-- ============================================================
create table if not exists public.fantasy_team_chip_uses (
  id bigserial primary key,
  fantasy_team_id uuid not null references public.fantasy_teams(id) on delete cascade,
  chip_key text not null check (chip_key in ('bench_boost', 'triple_captain')),
  season_half smallint not null check (season_half in (1, 2)),
  gameweek_id integer not null references public.gameweeks(id) on delete cascade,
  used_at timestamptz not null default now(),
  unique (fantasy_team_id, chip_key, season_half)
);

alter table public.fantasy_team_chip_uses enable row level security;
drop policy if exists "chip_uses: leitura pública" on public.fantasy_team_chip_uses;
create policy "chip_uses: leitura pública" on public.fantasy_team_chip_uses for select using (true);
drop policy if exists "chip_uses: dono ativa os próprios chips" on public.fantasy_team_chip_uses;
create policy "chip_uses: dono ativa os próprios chips" on public.fantasy_team_chip_uses for insert with check (
  exists (select 1 from public.fantasy_teams t where t.id = fantasy_team_id and t.user_id = auth.uid())
);
drop policy if exists "chip_uses: dono cancela antes do prazo" on public.fantasy_team_chip_uses;
create policy "chip_uses: dono cancela antes do prazo" on public.fantasy_team_chip_uses for delete using (
  exists (
    select 1 from public.fantasy_teams t
    join public.gameweeks g on g.id = fantasy_team_chip_uses.gameweek_id
    where t.id = fantasy_team_chip_uses.fantasy_team_id and t.user_id = auth.uid() and g.deadline_at > now()
  )
);

-- ============================================================
-- 8c. FECHAR RODADA (soma a pontuação de cada time: titulares, capitão em dobro)
-- Chamado pelo admin (admin.html) via RPC quando a rodada termina.
-- ============================================================
create or replace function public.fb_close_gameweek(p_gameweek_id integer)
returns void as $$
begin
  if not public.fb_is_admin() then
    raise exception 'Só administradores podem fechar rodadas.';
  end if;

  update public.gameweeks set status = 'finalizada' where id = p_gameweek_id;

  with team_points as (
    select
      ftp.fantasy_team_id,
      sum(
        coalesce(ps.fantasy_points, 0) *
        case
          when t.captain_player_id = ftp.player_id and exists (
            select 1 from public.fantasy_team_chip_uses cu
            where cu.fantasy_team_id = t.id and cu.gameweek_id = p_gameweek_id and cu.chip_key = 'triple_captain'
          ) then 3
          when t.captain_player_id = ftp.player_id then 2
          else 1
        end
      ) as points
    from public.fantasy_team_players ftp
    join public.fantasy_teams t on t.id = ftp.fantasy_team_id
    join public.players p on p.id = ftp.player_id
    left join public.fixtures fx on fx.gameweek_id = p_gameweek_id
      and (fx.home_club_id = p.club_id or fx.away_club_id = p.club_id)
    left join public.player_stats ps on ps.fixture_id = fx.id and ps.player_id = ftp.player_id
    where ftp.is_starting = true
       or exists (
         select 1 from public.fantasy_team_chip_uses cu
         where cu.fantasy_team_id = t.id and cu.gameweek_id = p_gameweek_id and cu.chip_key = 'bench_boost'
       )
    group by ftp.fantasy_team_id
  ), transfer_penalties as (
    select fantasy_team_id, sum(point_penalty) as penalty
    from public.transfers
    where gameweek_id = p_gameweek_id
    group by fantasy_team_id
  )
  insert into public.fantasy_team_gameweek_score (fantasy_team_id, gameweek_id, points)
  select tp.fantasy_team_id, p_gameweek_id, coalesce(tp.points, 0) + coalesce(pen.penalty, 0)
  from team_points tp
  left join transfer_penalties pen on pen.fantasy_team_id = tp.fantasy_team_id
  on conflict (fantasy_team_id, gameweek_id) do update set points = excluded.points;

  with ranked as (
    select id, rank() over (order by points desc) as rnk
    from public.fantasy_team_gameweek_score
    where gameweek_id = p_gameweek_id
  )
  update public.fantasy_team_gameweek_score s
  set rank = r.rnk
  from ranked r
  where s.id = r.id;
end;
$$ language plpgsql security definer set search_path = public;

grant execute on function public.fb_close_gameweek(integer) to authenticated;

-- ============================================================
-- 8d. OWNERSHIP (ideia do Fantasy Premier League: % de times que escalaram
-- cada jogador — ajuda a decidir entre aposta segura e diferenciada)
-- ============================================================
create or replace view public.player_ownership as
select
  p.id as player_id,
  count(ftp.id) as owned_by_teams,
  (select greatest(count(*), 1) from public.fantasy_teams) as total_teams,
  round(100.0 * count(ftp.id) / (select greatest(count(*), 1) from public.fantasy_teams), 1) as ownership_pct
from public.players p
left join public.fantasy_team_players ftp on ftp.player_id = p.id
group by p.id;

-- ============================================================
-- 9. LIGAS PRIVADAS (grupos de amigos)
-- ============================================================
create table if not exists public.private_leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  invite_code text not null unique,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  season_id integer not null references public.seasons(id) on delete cascade,
  created_at timestamptz not null default now()
);

alter table public.private_leagues enable row level security;
drop policy if exists "private_leagues: leitura pública" on public.private_leagues;
create policy "private_leagues: leitura pública" on public.private_leagues for select using (true);
drop policy if exists "private_leagues: dono gere a liga" on public.private_leagues;
create policy "private_leagues: dono gere a liga" on public.private_leagues for all using (auth.uid() = owner_id) with check (auth.uid() = owner_id);

create table if not exists public.private_league_members (
  private_league_id uuid not null references public.private_leagues(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (private_league_id, user_id)
);

alter table public.private_league_members enable row level security;
drop policy if exists "private_league_members: leitura pública" on public.private_league_members;
create policy "private_league_members: leitura pública" on public.private_league_members for select using (true);
drop policy if exists "private_league_members: utilizador entra/sai sozinho" on public.private_league_members;
create policy "private_league_members: utilizador entra/sai sozinho" on public.private_league_members for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ============================================================
-- FIM
-- ============================================================
