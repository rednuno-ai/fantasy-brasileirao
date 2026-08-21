# Fantasy Brasileirão — Setup

Site completo em `/fantasy-brasileirao`: páginas estáticas (HTML/CSS/JS) + Supabase (contas, base de dados, RLS). Segue o mesmo padrão dos outros projetos deste repositório (ver `/treinadores/SETUP.md`).

## ✅ O que já está pronto (feito sem precisares de mexer em nada)

- Todo o código: 10 páginas, design system, schema completo (RLS, pontuação, chips, ligas privadas), scripts de import, workflow do GitHub Actions.
- Os 20 clubes da Série A 2026 confirmados (Wikipédia) e prontos em `supabase/seed_clubs.sql`.
- Os 20 IDs de clube no Transfermarkt confirmados em [`data/transfermarkt-clubs.json`](data/transfermarkt-clubs.json) — já podes correr o import assim que ligares o Supabase.

## 🔴 O que só tu podes fazer (não posso criar contas em teu nome)

Isto é literalmente o único bloqueio — 3 passos, uns 5 minutos, zero código:

1. Cria conta grátis em [supabase.com](https://supabase.com) e um projeto novo.
2. **SQL Editor → New query** → cola e corre `supabase/schema.sql`, depois `supabase/seed_clubs.sql`.
3. **Project Settings → API** → copia `Project URL` e `anon public key` para [`js/config.js`](js/config.js) (2 linhas).

A partir daqui, tudo o resto (testar o site, promover-te a admin, correr os imports) posso fazer contigo ou sozinho — é só me dizeres quando tiveres feito estes 3 passos e as chaves estiverem no `config.js`.

## 1. Criar o projeto Supabase

1. [supabase.com](https://supabase.com) → novo projeto (plano gratuito chega para começar).
2. **SQL Editor → New query** → cola e corre, por esta ordem:
   1. `supabase/schema.sql` (tabelas, RLS, função de pontuação, trigger)
   2. `supabase/seed_clubs.sql` (os 20 clubes da Série A 2026 + temporada ativa)

## 2. Ligar as chaves ao site

**Project Settings → API** → copia `Project URL` e `anon public key` para [`js/config.js`](js/config.js):

```js
window.FB_CONFIG = {
  SUPABASE_URL: "https://xxxxxxxxxxxx.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOi...",
};
```

A `anon key` é pública por natureza — a segurança vem das políticas RLS já definidas no `schema.sql` (cada utilizador só edita o próprio time; só admins escrevem em clubes/jogadores/regras).

## 3. Criar o teu utilizador admin

1. Regista uma conta normal em `/fantasy-brasileirao/registo.html`.
2. No Supabase, **Table Editor → profiles**, muda a tua linha: `role` → `admin`.
3. Entra e abre `/fantasy-brasileirao/admin.html` — já tens acesso ao painel (rodadas, pontuação, estatísticas).

## 4. Popular jogadores (elenco + valor de mercado)

Isto **não corre no browser** — é um script Node (`scripts/import-transfermarkt.mjs`) porque precisa da `service_role key` (nunca deve ir para o cliente) e faz scraping de página completa.

```bash
cd fantasy-brasileirao/scripts
npm install
npx playwright install chromium
```

Antes de correr: abre [`data/transfermarkt-clubs.json`](data/transfermarkt-clubs.json) e preenche o ID Transfermarkt de cada clube (só o Flamengo já vem preenchido, `614`, confirmado). Para cada clube: abre a página dele em `transfermarkt.com.br`, o ID é o número no fim do URL do elenco.

```bash
SUPABASE_URL=https://xxxx.supabase.co SUPABASE_SERVICE_ROLE_KEY=eyJ... node import-transfermarkt.mjs
```

O script:
- lê o elenco de cada clube (nome, posição, valor de mercado em €, foto, ID Transfermarkt);
- converte € → R$ pela **cotação oficial do Banco Central (PTAX)** do dia, e guarda a taxa usada;
- grava tudo em `players`, com histórico em `market_value_history`.

Corre-o uma vez no início da temporada, e sempre que quiseres atualizar valores (ex: depois da janela de transferências). Não o deixes a correr em contínuo — a Transfermarkt não disponibiliza os dados como API pública para consumo em massa; este script é pensado para uso pontual/anual, não como pipeline 24/7.

### Sobre as fotos dos jogadores

O `photo_url` capturado pelo import vem do Transfermarkt tal como está publicado — isto é referência/uso editorial pontual, não uma licença de imagem. Não construímos aqui nenhum processo para recortar/anonimizar fotos de forma a esconder a origem — isso não reduz o risco de direitos de autor, só dificulta a atribuição, o que é pior do ponto de vista legal, não melhor. Por omissão, as páginas do site (mercado, montar time) já mostram um **avatar genérico por posição/cor do clube** em vez da foto, exatamente para não depender disto. Se um dia tiveres uma fonte de fotos licenciada, basta preencher `photo_url` manualmente por jogador — o resto do site já está pronto para as mostrar.

## 5. Pontuação semanal (dados oficiais da CBF)

Fonte oficial definida pela liga: [tabela da CBF](https://www.cbf.com.br/futebol-brasileiro/tabelas/campeonato-brasileiro/serie-a/2026), consultada toda quarta-feira. Ver detalhe técnico no topo de [`scripts/import-cbf-stats.mjs`](scripts/import-cbf-stats.mjs): a CBF só publica totais acumulados por atleta (não por partida nem assistências), por isso o script guarda um "snapshot" semanal e calcula a diferença face à semana anterior.

**Antes da primeira corrida:** cada jogador precisa do campo `cbf_athlete_id` preenchido (o número no fim do URL do perfil dele em cbf.com.br/.../atletas/.../2026/**922690**). Não há import automático disto ainda — preenche manualmente na Table Editor para os jogadores que fazem parte de algum time, ou pede-me para construir esse importador também.

**Agendamento automático:** já está criado [`/.github/workflows/fantasy-brasileirao-cbf-import.yml`](../.github/workflows/fantasy-brasileirao-cbf-import.yml), que corre toda quarta-feira às 12:00 UTC. Precisas de:
1. No GitHub do repositório: **Settings → Secrets and variables → Actions**, criar `FB_SUPABASE_URL` e `FB_SUPABASE_SERVICE_ROLE_KEY`.
2. Antes de cada rodada fechar, marca-a como **"em andamento"** no admin (`admin.html` → Rodadas) — é essa que o import vai preencher.

**Importante — verifica antes de confiar no automático:** a página da CBF é uma SPA (conteúdo carregado via JavaScript). Os seletores/regex no script foram desenhados a partir de uma amostra da página, mas a estrutura real só se confirma a correr. Na primeira vez, corre localmente com `DEBUG=1` para veres o texto extraído e ajustares o regex se preciso:

```bash
DEBUG=1 GAMEWEEK_NUMBER=1 SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node import-cbf-stats.mjs
```

### Fallback: zerozero.pt e SofaScore

Se a CBF falhar para um jogador (erro, layout mudou) ou para preencher **assistências** (que a CBF nunca publica), o script tenta o **zerozero.pt**, que ao contrário da CBF tem estatística jogo-a-jogo por rodada. Preenche `players.zerozero_id` como `"slug-do-jogador/id-numerico"` — é o próprio caminho do URL do jogador no zerozero (ex: para `zerozero.pt/jogador/pedro/481359`, usa `pedro/481359`). Confirma também `ZEROZERO_EPOCA_ID` (env var, por omissão `155`) — é o ID interno da época 2026 no zerozero; se os jogos não aparecerem, corre com `DEBUG=1` para ver o texto e ajustar.

**SofaScore fica como último recurso, mas não está implementado de forma fiável** — a SofaScore não tem API pública documentada, só endpoints internos sem SLA. A função existe como ponto de extensão (`fetchSofaScoreMatchStats`); pede-me para a construir a sério se precisares mesmo dela.

### Reconstruir o histórico da época (rodadas já disputadas)

A CBF **não permite isto sozinha** — só publica o total de hoje, sem separar por rodada. Já o zerozero.pt tem, por isso o backfill usa-o como fonte:

```bash
BACKFILL=1 FROM_ROUND=1 TO_ROUND=23 SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node import-cbf-stats.mjs
```

Isto cria as rodadas em falta, os jogos (`fixtures`) e as estatísticas por jogador de cada rodada, para todos os jogadores com `zerozero_id` preenchido. Importante: isto dá-te o **histórico de desempenho dos jogadores**, não pontos de fantasy retroativos para nenhum utilizador — ninguém tinha time montado antes de a liga abrir, por isso não existe "pontuação da rodada 5" de um time que não existia. Serve para o Mercado mostrar quem está em boa fase e para referência.

### O que fica automático vs. manual

| | Automático (CBF, fallback zerozero) | Manual (admin, por partida) |
|---|---|---|
| Gol, gol de goleiro | ✅ | |
| Cartão amarelo/vermelho | ✅ | |
| Vitória/empate/derrota | ✅ | |
| Jogo sem sofrer gol, gol sofrido | ✅ | |
| Bônus hat-trick | ✅ | |
| Assistência | ✅ via zerozero (CBF nunca publica) | fallback se zerozero também falhar |
| Pênaltis, defesas, desarmes, faltas, impedimento | | ✅ (`admin.html` → Estatísticas manuais) |

Isto está documentado também na página `/regras.html`, coluna "Fonte" da tabela de pontuação.

## 6. Testar o fluxo completo

1. Cria uma conta normal, vai a `montar-time.html`, monta um elenco de 23 jogadores.
2. Marca 11 titulares + capitão.
3. Como admin, cria uma rodada, marca-a "em andamento", corre o import da CBF (ou preenche `player_stats` manualmente).
4. No admin (`admin.html` → Rodadas), clica **"Fechar e pontuar"** — chama a função `fb_close_gameweek`, que soma os pontos dos titulares (capitão em dobro, chips aplicados) e marca a rodada como finalizada. Automático, não precisas de calcular nada à mão.
5. Confirma em `classificacao.html`.

## Notas de arquitetura

- **Sem prémios**: por pedido explícito, o site não tem nenhuma secção de prémios/recompensas — só ranking e ligas privadas entre amigos.
- **Moeda**: tudo em Reais (R$), incluindo o orçamento e os valores de mercado (convertidos de € via PTAX no import).
- **Cores**: paleta inspirada nas cores do Brasil (verde/amarelo/azul), tema claro e escuro automático (`prefers-color-scheme`), em `css/styles.css`.
- **SEO**: cada página tem `<title>`/`meta description`/`canonical` próprios, favicon incluído; as páginas públicas (início, regras, mercado, classificação) já estão no `sitemap.xml` da raiz do site.
