-- Fantasy Brasileirão — seed dos 20 clubes da Série A 2026
-- Corre depois do schema.sql. Seguro de rodar mais de uma vez (upsert por slug).
-- cbf_club_id fica null — preenche depois pela página do clube em cbf.com.br
-- (usa o importador scripts/import-cbf-stats.mjs, ou edita à mão no admin).

insert into public.clubs (name, short_name, slug, city, state, primary_color, secondary_color) values
  ('Athletico Paranaense', 'Athletico-PR', 'athletico-pr', 'Curitiba', 'PR', '#E4002B', '#000000'),
  ('Atlético Mineiro',     'Atlético-MG', 'atletico-mg', 'Belo Horizonte', 'MG', '#000000', '#FFFFFF'),
  ('Bahia',                'Bahia',       'bahia', 'Salvador', 'BA', '#0057A8', '#E31B23'),
  ('Botafogo',             'Botafogo',    'botafogo', 'Rio de Janeiro', 'RJ', '#000000', '#FFFFFF'),
  ('Chapecoense',          'Chapecoense', 'chapecoense', 'Chapecó', 'SC', '#0B6E3A', '#FFFFFF'),
  ('Corinthians',          'Corinthians', 'corinthians', 'São Paulo', 'SP', '#000000', '#FFFFFF'),
  ('Coritiba',             'Coritiba',    'coritiba', 'Curitiba', 'PR', '#0B7A3B', '#000000'),
  ('Cruzeiro',             'Cruzeiro',    'cruzeiro', 'Belo Horizonte', 'MG', '#003DA5', '#FFFFFF'),
  ('Flamengo',             'Flamengo',    'flamengo', 'Rio de Janeiro', 'RJ', '#E8102E', '#000000'),
  ('Fluminense',           'Fluminense',  'fluminense', 'Rio de Janeiro', 'RJ', '#7A1E30', '#006A3D'),
  ('Grêmio',               'Grêmio',      'gremio', 'Porto Alegre', 'RS', '#0F3C78', '#000000'),
  ('Internacional',        'Internacional', 'internacional', 'Porto Alegre', 'RS', '#D2122E', '#FFFFFF'),
  ('Mirassol',             'Mirassol',    'mirassol', 'Mirassol', 'SP', '#FFD400', '#0B7A3B'),
  ('Palmeiras',            'Palmeiras',   'palmeiras', 'São Paulo', 'SP', '#006437', '#FFFFFF'),
  ('Red Bull Bragantino',  'Bragantino',  'bragantino', 'Bragança Paulista', 'SP', '#E2001A', '#FFFFFF'),
  ('Remo',                 'Remo',        'remo', 'Belém', 'PA', '#0B4EA2', '#C1121C'),
  ('Santos',               'Santos',      'santos', 'Santos', 'SP', '#000000', '#FFFFFF'),
  ('São Paulo',            'São Paulo',   'sao-paulo', 'São Paulo', 'SP', '#C1121C', '#000000'),
  ('Vasco da Gama',        'Vasco',       'vasco', 'Rio de Janeiro', 'RJ', '#000000', '#FFFFFF'),
  ('Vitória',              'Vitória',     'vitoria', 'Salvador', 'BA', '#C1121C', '#000000')
on conflict (slug) do update set
  name = excluded.name,
  short_name = excluded.short_name,
  city = excluded.city,
  state = excluded.state,
  primary_color = excluded.primary_color,
  secondary_color = excluded.secondary_color;

-- Temporada e rodada inicial (ajusta o ano/datas conforme o calendário oficial)
insert into public.seasons (year, name, is_active, budget_brl) values
  (2026, 'Brasileirão Série A 2026', true, 150000000)
on conflict (year) do nothing;
