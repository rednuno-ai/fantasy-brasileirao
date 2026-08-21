#!/usr/bin/env node
/**
 * Import anual de elenco + valor de mercado (Transfermarkt -> Supabase).
 *
 * Corre manualmente no início de cada temporada (ou quando quiseres atualizar
 * os valores). Não corre sozinho em produção — é um script Node, não código
 * de browser, porque:
 *   1. precisa da service_role key do Supabase (nunca deve ir para o browser);
 *   2. faz scraping de página completa (Playwright), o que a Transfermarkt não
 *      disponibiliza como API pública — corre isto com moderação, um clube de
 *      cada vez com pausa entre pedidos (já incluído abaixo), nunca em massa
 *      contínua. Ver a nota de risco de Termos de Uso no SETUP.md.
 *
 * Uso:
 *   SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-transfermarkt.mjs
 *
 * Requer: npm i playwright @supabase/supabase-js
 */

import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Define SUPABASE_URL e SUPABASE_SERVICE_ROLE_KEY antes de correr este script.");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const clubsConfig = JSON.parse(readFileSync(path.join(__dirname, "..", "data", "transfermarkt-clubs.json"), "utf-8"));

const POSITION_MAP = {
  "goleiro": "GOL",
  "zagueiro": "ZAG",
  "lateral-direito": "LAT",
  "lateral-esquerdo": "LAT",
  "lateral": "LAT",
  "volante": "MEI",
  "meio-campo": "MEI",
  "meia": "MEI",
  "meia-atacante": "MEI",
  "meio-campista": "MEI",
  "ponta-direita": "ATA",
  "ponta-esquerda": "ATA",
  "segundo-atacante": "ATA",
  "centroavante": "ATA",
  "atacante": "ATA",
};

function mapPosition(rawLabel) {
  const key = rawLabel.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, "-");
  return POSITION_MAP[key] || null;
}

// Converte um texto de valor de mercado da Transfermarkt ("€ 8,00 mi.", "€ 950 mil") em número de euros
function parseMarketValueEur(text) {
  if (!text) return null;
  const cleaned = text.replace(/[€\s]/g, "").replace(",", ".");
  const isMillion = /mi/i.test(cleaned);
  const isThousand = /mil/i.test(cleaned);
  const number = parseFloat(cleaned.replace(/[a-zA-Z.]+$/i, "").replace(/mi\.?|mil\.?/i, ""));
  if (Number.isNaN(number)) return null;
  if (isMillion) return number * 1_000_000;
  if (isThousand) return number * 1_000;
  return number;
}

// Taxa de câmbio EUR -> BRL oficial (PTAX, Banco Central do Brasil), dia útil mais recente
async function fetchEurToBrlRate() {
  for (let daysBack = 0; daysBack < 6; daysBack++) {
    const d = new Date();
    d.setDate(d.getDate() - daysBack);
    const mmddyyyy = `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}-${d.getFullYear()}`;
    const url = `https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoMoedaDia(moeda=@moeda,dataCotacao=@dataCotacao)?@moeda='EUR'&@dataCotacao='${mmddyyyy}'&$format=json`;
    try {
      const res = await fetch(url);
      const json = await res.json();
      const rate = json?.value?.[0]?.cotacaoVenda;
      if (rate) return { rate, date: mmddyyyy };
    } catch (e) {
      // tenta o dia anterior
    }
  }
  throw new Error("Não foi possível obter a cotação EUR/BRL do Banco Central. Define a taxa manualmente se necessário.");
}

async function scrapeClubSquad(page, clubSlug, tmClubId) {
  const url = `https://www.transfermarkt.com.br/x/startseite/verein/${tmClubId}`;
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector("table.items tbody tr", { timeout: 15000 }).catch(() => null);

  return page.$$eval("table.items > tbody > tr", (rows) =>
    rows.map((row) => {
      const nameEl = row.querySelector("td.posrela .hauptlink a");
      const positionEl = row.querySelector("td.posrela table tr:nth-child(2) td");
      const valueEl = row.querySelector("td.rechts.hauptlink a, td.rechts.hauptlink");
      const photoEl = row.querySelector("img.bilderrahmen-fixed");
      const linkHref = nameEl?.getAttribute("href") || "";
      const idMatch = linkHref.match(/spieler\/(\d+)/);
      return {
        name: nameEl?.textContent?.trim() || null,
        transfermarkt_id: idMatch ? idMatch[1] : null,
        position_raw: positionEl?.textContent?.trim() || null,
        market_value_text: valueEl?.textContent?.trim() || null,
        photo_url: photoEl?.getAttribute("data-src") || photoEl?.getAttribute("src") || null,
      };
    }).filter((p) => p.name)
  );
}

async function main() {
  console.log("A obter cotação EUR/BRL (Banco Central)...");
  const { rate, date } = await fetchEurToBrlRate();
  console.log(`Cotação EUR/BRL do dia ${date}: ${rate}`);

  const { data: clubs, error: clubsErr } = await supabase.from("clubs").select("id, slug, name");
  if (clubsErr) throw clubsErr;
  const clubBySlug = Object.fromEntries(clubs.map((c) => [c.slug, c]));

  const browser = await chromium.launch();
  const page = await browser.newPage({ userAgent: "Mozilla/5.0 (compatible; FantasyBrasileiraoImport/1.0)" });

  let totalImported = 0;
  for (const [slug, tmClubId] of Object.entries(clubsConfig.clubs)) {
    if (!tmClubId) { console.warn(`⚠ Sem ID Transfermarkt para "${slug}" — edita data/transfermarkt-clubs.json. A saltar.`); continue; }
    const club = clubBySlug[slug];
    if (!club) { console.warn(`⚠ Clube "${slug}" não existe na base (corre supabase/seed_clubs.sql). A saltar.`); continue; }

    console.log(`A importar elenco: ${club.name}...`);
    let squad;
    try {
      squad = await scrapeClubSquad(page, slug, tmClubId);
    } catch (e) {
      console.error(`Erro ao ler elenco de ${club.name}: ${e.message}`);
      continue;
    }

    for (const p of squad) {
      const position = mapPosition(p.position_raw || "");
      const eur = parseMarketValueEur(p.market_value_text);
      if (!position || eur === null) continue;

      const row = {
        club_id: club.id,
        name: p.name,
        position,
        market_value_eur: eur,
        market_value_brl: Math.round(eur * rate),
        exchange_rate_used: rate,
        value_updated_at: new Date().toISOString(),
        transfermarkt_id: p.transfermarkt_id,
        photo_url: p.photo_url,
        is_active: true,
      };

      const { data: upserted, error } = await supabase
        .from("players")
        .upsert(row, { onConflict: "transfermarkt_id" })
        .select("id")
        .single();

      if (error) { console.error(`  Erro ao gravar ${p.name}: ${error.message}`); continue; }

      await supabase.from("market_value_history").insert({
        player_id: upserted.id,
        market_value_eur: eur,
        market_value_brl: row.market_value_brl,
        exchange_rate_used: rate,
        source: "transfermarkt",
      });

      totalImported++;
    }

    // pausa entre clubes — não martelar o servidor da Transfermarkt
    await page.waitForTimeout(3000);
  }

  await browser.close();
  console.log(`Concluído. ${totalImported} jogadores importados/atualizados.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
