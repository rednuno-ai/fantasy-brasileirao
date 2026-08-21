#!/usr/bin/env node
/**
 * Import de estatísticas oficiais -> Supabase.
 *
 * Fonte primária: CBF (cbf.com.br), consultada toda quarta-feira, tal como
 * definido pela liga. A CBF só publica TOTAIS ACUMULADOS por atleta (partidas,
 * gols, cartões) — não por partida, nem assistências. Por isso comparamos
 * com o snapshot da rodada anterior para saber o que aconteceu "nesta rodada".
 *
 * Fallback: se a CBF falhar para um jogador (erro de rede, layout mudou,
 * atleta sem página), ou para preencher assistências (que a CBF nunca
 * publica), tentamos o zerozero.pt — que ao contrário da CBF tem estatística
 * jogo-a-jogo por rodada (gols, assistências, cartões, minutos). Último
 * recurso: SofaScore (sem API pública documentada — implementação best-effort,
 * ver aviso na função correspondente).
 *
 * Dois modos:
 *   1) Semanal (por omissão): processa UMA rodada (a "em_andamento", ou
 *      GAMEWEEK_NUMBER=N). Pensado para o cron de toda quarta-feira.
 *   2) Backfill: BACKFILL=1 FROM_ROUND=1 TO_ROUND=23 — reconstrói o histórico
 *      de rodadas já disputadas a partir do zerozero.pt (só ele tem dados
 *      por rodada; a CBF sozinha não permite isto, só dá o total de hoje).
 *      Cria as rodadas em falta automaticamente.
 *
 * As páginas são renderizadas em JavaScript (SPA) — os seletores/regex abaixo
 * foram desenhados a partir de amostras das páginas; corre com DEBUG=1 para
 * imprimir o texto bruto extraído e ajustar se o layout tiver mudado.
 *
 * Uso:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-cbf-stats.mjs
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... GAMEWEEK_NUMBER=5 node scripts/import-cbf-stats.mjs
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... BACKFILL=1 FROM_ROUND=1 TO_ROUND=23 node scripts/import-cbf-stats.mjs
 *
 * Requer: npm i playwright @supabase/supabase-js
 */

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GAMEWEEK_NUMBER = process.env.GAMEWEEK_NUMBER ? Number(process.env.GAMEWEEK_NUMBER) : null;
const DEBUG = process.env.DEBUG === "1";
const BACKFILL = process.env.BACKFILL === "1";
const FROM_ROUND = process.env.FROM_ROUND ? Number(process.env.FROM_ROUND) : 1;
const TO_ROUND = process.env.TO_ROUND ? Number(process.env.TO_ROUND) : null;
// ID interno da "época" no zerozero.pt (a mesma página de exemplo, temporada 2026 do
// Brasileirão, usava epoca_id=155) — confirma/ajusta se os jogos não aparecerem.
const ZEROZERO_EPOCA_ID = process.env.ZEROZERO_EPOCA_ID || "155";

const CBF_SEASON_URL = "https://www.cbf.com.br/futebol-brasileiro/tabelas/campeonato-brasileiro/serie-a/2026";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Define SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY antes de correr este script.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

// ============================================================
// Fonte 1 (primária): CBF — totais acumulados por atleta
// ============================================================

function parseAthleteStatsFromText(text) {
  const num = (re) => {
    const m = text.match(re);
    return m ? parseInt(m[1], 10) : 0;
  };
  return {
    cumulative_matches: num(/Partidas?\s*[:\-]?\s*(\d+)/i),
    cumulative_goals: num(/Gols?\s*[:\-]?\s*(\d+)/i),
    cumulative_yellow_cards: num(/Cart[õo]es?\s*Amarelos?\s*[:\-]?\s*(\d+)/i),
    cumulative_red_cards: num(/Cart[õo]es?\s*Vermelhos?\s*[:\-]?\s*(\d+)/i),
  };
}

async function fetchCbfAthleteSnapshot(page, cbfAthleteId) {
  const url = `https://www.cbf.com.br/futebol-brasileiro/atletas/campeonato-brasileiro/serie-a/2026/${cbfAthleteId}`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  const text = await page.locator("body").innerText();
  if (DEBUG) console.log(`--- DEBUG CBF atleta ${cbfAthleteId} ---\n${text.slice(0, 800)}\n---`);
  return parseAthleteStatsFromText(text);
}

// Lê os resultados da rodada (nomes dos clubes + placar) a partir da página de tabelas/jogos da CBF
async function fetchCbfFixturesForGameweek(page, gwNumber) {
  await page.goto(CBF_SEASON_URL, { waitUntil: "networkidle", timeout: 30000 });

  const roundSelector = 'select[name*="rodada" i], select[id*="rodada" i]';
  const hasSelector = await page.locator(roundSelector).count();
  if (hasSelector) {
    await page.selectOption(roundSelector, { label: String(gwNumber) }).catch(() => null);
    await page.waitForTimeout(1500);
  }

  const text = await page.locator("body").innerText();
  if (DEBUG) console.log(`--- DEBUG CBF rodada ${gwNumber} ---\n${text.slice(0, 1500)}\n---`);

  const matches = [...text.matchAll(/([A-Za-zÀ-ÿ .'-]{3,30})\s+(\d+)\s*x\s*(\d+)\s+([A-Za-zÀ-ÿ .'-]{3,30})/gi)];
  return matches.map((m) => ({
    home_name: m[1].trim(),
    home_score: parseInt(m[2], 10),
    away_score: parseInt(m[3], 10),
    away_name: m[4].trim(),
  }));
}

// ============================================================
// Fonte 2 (fallback): zerozero.pt — estatística jogo-a-jogo por rodada
// ============================================================

/**
 * players.zerozero_id deve ser guardado como "slug-do-jogador/id-numerico"
 * (o próprio caminho do URL, ex: "pedro/481359") — mais simples do que tentar
 * adivinhar o slug a partir do nome.
 */
async function fetchZeroZeroAllRounds(page, zerozeroId) {
  const url = `https://www.zerozero.pt/jogador/${zerozeroId}/jogos?epoca_id=${ZEROZERO_EPOCA_ID}`;
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
  const text = await page.locator("body").innerText();
  if (DEBUG) console.log(`--- DEBUG zerozero ${zerozeroId} ---\n${text.slice(0, 2000)}\n---`);

  // Isola só os jogos de "Brasileirão" (o jogador pode ter jogos de Libertadores, Copa do
  // Brasil, etc. na mesma listagem) e captura um bloco de texto à volta de cada "rodada N".
  const rounds = [];
  const roundRegex = /rodada[,\s]+(\d{1,2})/gi;
  let match;
  while ((match = roundRegex.exec(text)) !== null) {
    const roundNumber = parseInt(match[1], 10);
    const windowStart = Math.max(0, match.index - 200);
    const windowEnd = Math.min(text.length, match.index + 400);
    const block = text.slice(windowStart, windowEnd);
    if (!/brasileir[ãa]o/i.test(block)) continue; // ignora rodadas de outras competições (ex: Libertadores)

    const teamsMatch = block.match(/([A-Za-zÀ-ÿ .'-]{3,25})\s+(?:vs|x|-)\s+([A-Za-zÀ-ÿ .'-]{3,25})/i);
    const scoreMatch = block.match(/(\d+)\s*-\s*(\d+)/);
    const minutesMatch = block.match(/(\d{1,3})\s*min/i);
    const goalsMatch = block.match(/(\d+)\s*gol/i);
    const assistsMatch = block.match(/(\d+)\s*assist/i);
    const yellow = /amarel/i.test(block);
    const red = /vermelh/i.test(block);

    rounds.push({
      round: roundNumber,
      home_name: teamsMatch?.[1]?.trim() || null,
      away_name: teamsMatch?.[2]?.trim() || null,
      home_score: scoreMatch ? parseInt(scoreMatch[1], 10) : null,
      away_score: scoreMatch ? parseInt(scoreMatch[2], 10) : null,
      minutes_played: minutesMatch ? parseInt(minutesMatch[1], 10) : 90,
      goals: goalsMatch ? parseInt(goalsMatch[1], 10) : 0,
      assists: assistsMatch ? parseInt(assistsMatch[1], 10) : 0,
      yellow_cards: yellow ? 1 : 0,
      red_cards: red ? 1 : 0,
    });
  }
  return rounds;
}

// ============================================================
// Fonte 3 (último recurso): SofaScore
// ============================================================
// AVISO: a SofaScore não tem API pública documentada — o que existe são
// endpoints internos não oficiais, sem SLA, que podem mudar ou bloquear sem
// aviso (ver nota de risco no SETUP.md). Isto fica aqui só como ponto de
// extensão; não confies nele em produção sem testar/reforçar primeiro.
async function fetchSofaScoreMatchStats(_page, _playerName, _gwNumber) {
  console.warn("  ⚠ Fallback SofaScore ainda não está implementado de forma fiável — a saltar.");
  return null;
}

// ============================================================
// Helpers partilhados
// ============================================================

function findClubByName(clubs, name) {
  if (!name) return null;
  const normalized = name.toLowerCase().trim();
  return clubs.find((c) =>
    c.name.toLowerCase() === normalized ||
    c.short_name.toLowerCase() === normalized ||
    normalized.includes(c.short_name.toLowerCase())
  );
}

async function getOrCreateGameweek(seasonId, number) {
  const { data: existing } = await supabase.from("gameweeks").select("*").eq("season_id", seasonId).eq("number", number).maybeSingle();
  if (existing) return existing;
  const { data: created, error } = await supabase.from("gameweeks").insert({
    season_id: seasonId,
    number,
    name: `Rodada ${number}`,
    deadline_at: new Date().toISOString(),
    status: "finalizada",
  }).select("*").single();
  if (error) throw error;
  return created;
}

async function upsertFixtureAndScore(gameweekId, clubs, homeName, awayName, homeScore, awayScore) {
  const home = findClubByName(clubs, homeName);
  const away = findClubByName(clubs, awayName);
  if (!home || !away || homeScore === null || awayScore === null) return null;

  const { data: fixture, error } = await supabase.from("fixtures").upsert(
    { gameweek_id: gameweekId, home_club_id: home.id, away_club_id: away.id, home_score: homeScore, away_score: awayScore, status: "finalizado", kickoff_at: new Date().toISOString() },
    { onConflict: "gameweek_id,home_club_id,away_club_id" }
  ).select("*").single();
  if (error) { console.error(`  Erro ao gravar jogo ${homeName} x ${awayName}: ${error.message}`); return null; }

  return {
    [home.id]: { fixture, conceded: awayScore, result: homeScore > awayScore ? "vitoria" : homeScore === awayScore ? "empate" : "derrota" },
    [away.id]: { fixture, conceded: homeScore, result: awayScore > homeScore ? "vitoria" : awayScore === homeScore ? "empate" : "derrota" },
  };
}

async function writePlayerStats(player, fixtureId, { minutes_played, goals, assists, yellow_cards, red_cards, conceded, result }, source) {
  const isGK = player.position === "GOL";
  const isDef = player.position === "ZAG" || player.position === "LAT";
  const row = {
    fixture_id: fixtureId,
    player_id: player.id,
    minutes_played,
    goals: isGK ? 0 : goals,
    goals_goalkeeper: isGK ? goals : 0,
    assists: assists || 0,
    yellow_cards,
    red_cards,
    goals_conceded: (isGK || isDef) ? conceded : 0,
    clean_sheet: (isGK || isDef) && conceded === 0,
    result,
    source,
  };
  const { error } = await supabase.from("player_stats").upsert(row, { onConflict: "fixture_id,player_id" });
  if (error) console.error(`  Erro ao gravar stats do jogador ${player.id}: ${error.message}`);
  return !error;
}

// ============================================================
// Modo 1: semanal — CBF com fallback zerozero/sofascore
// ============================================================

async function runWeekly(page) {
  const { data: season } = await supabase.from("seasons").select("*").eq("is_active", true).single();
  if (!season) throw new Error("Nenhuma temporada ativa.");

  let query = supabase.from("gameweeks").select("*").eq("season_id", season.id);
  query = GAMEWEEK_NUMBER ? query.eq("number", GAMEWEEK_NUMBER) : query.eq("status", "em_andamento");
  const { data: gameweek } = await query.limit(1).maybeSingle();
  if (!gameweek) throw new Error("Rodada não encontrada. Define GAMEWEEK_NUMBER= ou marca uma rodada como 'em_andamento' no admin.");

  console.log(`Importando estatísticas para: ${gameweek.name} (temporada ${season.name})`);

  const { data: clubs } = await supabase.from("clubs").select("*");
  const { data: players } = await supabase.from("players").select("id, club_id, position, cbf_athlete_id, zerozero_id").not("cbf_athlete_id", "is", null);
  if (!players?.length) { console.warn("Nenhum jogador tem cbf_athlete_id preenchido ainda."); return; }

  console.log("A ler resultados da rodada (CBF)...");
  const fixturesRaw = await fetchCbfFixturesForGameweek(page, gameweek.number);
  let fixtureByClubId = {};
  for (const f of fixturesRaw) {
    const result = await upsertFixtureAndScore(gameweek.id, clubs, f.home_name, f.away_name, f.home_score, f.away_score);
    if (result) fixtureByClubId = { ...fixtureByClubId, ...result };
  }
  console.log(`  ${fixturesRaw.length} jogos lidos da CBF.`);

  let cbfCount = 0, zerozeroCount = 0, skipped = 0;
  for (const player of players) {
    const clubFixture = fixtureByClubId[player.club_id];
    if (!clubFixture) continue;

    let current = null;
    try {
      current = await fetchCbfAthleteSnapshot(page, player.cbf_athlete_id);
    } catch (e) {
      console.error(`  ⚠ CBF falhou para o jogador ${player.id}: ${e.message}`);
    }

    let statsFromCbf = null;
    if (current) {
      await supabase.from("player_cbf_snapshots").upsert({ player_id: player.id, gameweek_id: gameweek.id, ...current }, { onConflict: "player_id,gameweek_id" });
      await supabase.from("players").update({
        season_matches: current.cumulative_matches, season_goals: current.cumulative_goals,
        season_yellow_cards: current.cumulative_yellow_cards, season_red_cards: current.cumulative_red_cards,
        season_stats_updated_at: new Date().toISOString(),
      }).eq("id", player.id);

      const { data: previous } = await supabase.from("player_cbf_snapshots").select("*").eq("player_id", player.id).lt("gameweek_id", gameweek.id).order("gameweek_id", { ascending: false }).limit(1).maybeSingle();

      if (!previous) {
        console.log(`  ${player.id}: baseline definida — sem pontos gerados nesta rodada.`);
        continue; // ver nota no topo do ficheiro sobre baseline mid-season
      }
      if (current.cumulative_matches > previous.cumulative_matches) {
        statsFromCbf = {
          minutes_played: 90, // a CBF não publica minutos por partida
          goals: Math.max(0, current.cumulative_goals - previous.cumulative_goals),
          assists: 0, // CBF nunca publica isto — tentamos enriquecer via zerozero abaixo
          yellow_cards: Math.max(0, current.cumulative_yellow_cards - previous.cumulative_yellow_cards),
          red_cards: Math.max(0, current.cumulative_red_cards - previous.cumulative_red_cards),
          conceded: clubFixture.conceded,
          result: clubFixture.result,
        };
      }
    }

    if (statsFromCbf) {
      // Sucesso via CBF — ainda assim tenta encontrar a assistência via zerozero (bónus,
      // não bloqueia se falhar).
      if (player.zerozero_id) {
        try {
          const rounds = await fetchZeroZeroAllRounds(page, player.zerozero_id);
          const thisRound = rounds.find((r) => r.round === gameweek.number);
          if (thisRound) statsFromCbf.assists = thisRound.assists;
        } catch (e) { /* não crítico, ignora */ }
      }
      await writePlayerStats(player, clubFixture.fixture.id, statsFromCbf, "cbf_auto");
      cbfCount++;
      continue;
    }

    // Fallback zerozero
    if (player.zerozero_id) {
      try {
        const rounds = await fetchZeroZeroAllRounds(page, player.zerozero_id);
        const thisRound = rounds.find((r) => r.round === gameweek.number);
        if (thisRound) {
          await writePlayerStats(player, clubFixture.fixture.id, { ...thisRound, conceded: clubFixture.conceded, result: clubFixture.result }, "zerozero_auto");
          zerozeroCount++;
          continue;
        }
      } catch (e) {
        console.error(`  ⚠ zerozero também falhou para o jogador ${player.id}: ${e.message}`);
      }
    }

    // Último recurso
    const sofa = await fetchSofaScoreMatchStats(page, player.id, gameweek.number);
    if (sofa) { await writePlayerStats(player, clubFixture.fixture.id, sofa, "sofascore_auto"); continue; }

    skipped++;
  }

  console.log(`Concluído. CBF: ${cbfCount} · zerozero (fallback): ${zerozeroCount} · sem dados: ${skipped}.`);
}

// ============================================================
// Modo 2: backfill histórico via zerozero.pt (a CBF não suporta isto —
// só publica o total de hoje, sem quebra por rodada)
// ============================================================

async function runBackfill(page) {
  const { data: season } = await supabase.from("seasons").select("*").eq("is_active", true).single();
  if (!season) throw new Error("Nenhuma temporada ativa.");

  const { data: clubs } = await supabase.from("clubs").select("*");
  const { data: players } = await supabase.from("players").select("id, club_id, position, zerozero_id").not("zerozero_id", "is", null);
  if (!players?.length) { console.warn("Nenhum jogador tem zerozero_id preenchido — nada para reconstruir."); return; }

  const toRound = TO_ROUND || 38;
  console.log(`Backfill via zerozero.pt: rodadas ${FROM_ROUND} a ${toRound}, ${players.length} jogadores mapeados.`);

  const gameweekCache = {};
  let written = 0;

  for (const player of players) {
    let rounds;
    try {
      rounds = await fetchZeroZeroAllRounds(page, player.zerozero_id);
    } catch (e) {
      console.error(`  ⚠ Erro a ler zerozero do jogador ${player.id}: ${e.message}`);
      continue;
    }

    for (const r of rounds) {
      if (r.round < FROM_ROUND || r.round > toRound) continue;
      if (!gameweekCache[r.round]) gameweekCache[r.round] = await getOrCreateGameweek(season.id, r.round);
      const gameweek = gameweekCache[r.round];

      const clubMap = await upsertFixtureAndScore(gameweek.id, clubs, r.home_name, r.away_name, r.home_score, r.away_score);
      if (!clubMap) continue;
      const clubFixture = clubMap[player.club_id];
      if (!clubFixture) continue; // este jogo não era do clube do jogador (ex: confundiu o nome) — salta

      const ok = await writePlayerStats(player, clubFixture.fixture.id, { ...r, conceded: clubFixture.conceded, result: clubFixture.result }, "zerozero_backfill");
      if (ok) written++;
    }
  }

  console.log(`Backfill concluído. ${written} linhas de estatística gravadas.`);
}

// ============================================================

async function main() {
  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "Mozilla/5.0 (compatible; FantasyBrasileiraoImport/1.0)" });

  if (BACKFILL) await runBackfill(page);
  else await runWeekly(page);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
