// Página Mercado — lista os jogadores com filtro/busca/ordenação client-side.
// Nota sobre fotos: não usamos fotos de imprensa de jogadores reais (risco de direitos
// de autor mesmo sem o escudo do clube visível). Cada jogador recebe um avatar genérico
// com a cor do clube e a posição — o campo `photo_url` fica pronto no schema para quando
// houver uma fonte de imagens licenciada.

const FB_POSITION_LABEL = { GOL: "Goleiro", ZAG: "Zagueiro", LAT: "Lateral", MEI: "Meia", ATA: "Atacante" };
const FB_STATUS_BADGE = {
  lesionado: '<span class="fb-status-dot fb-status-dot--out" title="Lesionado">🔴 Lesionado</span>',
  suspenso: '<span class="fb-status-dot fb-status-dot--out" title="Suspenso">🔴 Suspenso</span>',
  duvida: '<span class="fb-status-dot fb-status-dot--doubt" title="Dúvida para a próxima rodada">🟡 Dúvida</span>',
  emprestado: '<span class="fb-status-dot fb-status-dot--doubt" title="Emprestado a outro clube">🔵 Emprestado</span>',
};

let fbAllPlayers = [];
let fbAllClubs = [];
let fbOwnershipByPlayerId = {};
let fbCurrentPage = 1;
const FB_PAGE_SIZE = 25;

async function fbLoadMarket() {
  const tbody = document.querySelector("[data-fb-players-tbody]");
  const clubSelect = document.querySelector("[data-fb-filter-club]");

  const [{ data: clubs, error: clubsErr }, { data: players, error: playersErr }, { data: ownership }] = await Promise.all([
    fbSupabase.from("clubs").select("id, name, short_name, primary_color").order("name"),
    fbSupabase
      .from("players")
      .select("id, name, position, photo_url, market_value_brl, club_id, season_goals, season_yellow_cards, season_red_cards, status, clubs(name, short_name, primary_color)")
      .eq("is_active", true)
      .order("market_value_brl", { ascending: false }),
    fbSupabase.from("player_ownership").select("player_id, ownership_pct"),
  ]);

  if (clubsErr || playersErr || !clubs || !players) {
    tbody.innerHTML = `<tr><td colspan="7" class="fb-text-muted">
      Não foi possível carregar o mercado. Confirma que o Supabase está configurado em <code>js/config.js</code>,
      que correste <code>supabase/schema.sql</code> + <code>supabase/seed_clubs.sql</code>, e que já importaste
      os jogadores (ver <code>SETUP.md</code>).</td></tr>`;
    return;
  }

  fbAllClubs = clubs;
  fbAllPlayers = players;
  fbOwnershipByPlayerId = Object.fromEntries((ownership || []).map((o) => [o.player_id, o.ownership_pct]));

  clubSelect.innerHTML = '<option value="">Todos os clubes</option>' +
    clubs.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");

  if (!players.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="fb-empty">Ainda não há jogadores importados.
      Um admin precisa correr o import de elenco/valores (ver <code>SETUP.md</code>).</td></tr>`;
    return;
  }

  fbRenderMarket();
}

function fbRenderMarket() {
  const search = document.querySelector("[data-fb-filter-search]").value.trim().toLowerCase();
  const clubId = document.querySelector("[data-fb-filter-club]").value;
  const position = document.querySelector("[data-fb-filter-position]").value;
  const sort = document.querySelector("[data-fb-filter-sort]").value;

  let list = fbAllPlayers.filter((p) => {
    if (search && !p.name.toLowerCase().includes(search)) return false;
    if (clubId && String(p.club_id) !== clubId) return false;
    if (position && p.position !== position) return false;
    return true;
  });

  list.sort((a, b) => {
    if (sort === "value_asc") return (a.market_value_brl ?? 0) - (b.market_value_brl ?? 0);
    if (sort === "name_asc") return a.name.localeCompare(b.name);
    return (b.market_value_brl ?? 0) - (a.market_value_brl ?? 0);
  });

  const totalPages = Math.max(1, Math.ceil(list.length / FB_PAGE_SIZE));
  fbCurrentPage = Math.min(fbCurrentPage, totalPages);
  const pageItems = list.slice((fbCurrentPage - 1) * FB_PAGE_SIZE, fbCurrentPage * FB_PAGE_SIZE);

  const tbody = document.querySelector("[data-fb-players-tbody]");
  if (!pageItems.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="fb-empty">Nenhum jogador encontrado com esses filtros.</td></tr>`;
  } else {
    tbody.innerHTML = pageItems.map((p) => {
      const club = p.clubs;
      const color = club?.primary_color || "#009c3b";
      const initials = p.name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase();
      return `
        <tr>
          <td>
            <div class="fb-player-cell">
              <span class="fb-player-avatar" style="background:${color}">${initials}</span>
              <span>${p.name}${p.status && p.status !== "disponivel" ? `<br>${FB_STATUS_BADGE[p.status] || ""}` : ""}</span>
            </div>
          </td>
          <td>
            <div class="fb-club-cell">
              <span class="fb-club-dot" style="background:${color}"></span>
              ${club?.short_name ?? "—"}
            </div>
          </td>
          <td><span class="fb-tag fb-tag--pos-${p.position}">${FB_POSITION_LABEL[p.position] ?? p.position}</span></td>
          <td><strong>${fbFormatBRLCompact(p.market_value_brl)}</strong></td>
          <td>${p.season_goals ?? 0}</td>
          <td>${p.season_yellow_cards ?? 0}${p.season_red_cards ? ` / ${p.season_red_cards}🟥` : ""}</td>
          <td>${(fbOwnershipByPlayerId[p.id] ?? 0)}%</td>
        </tr>`;
    }).join("");
  }

  const pagination = document.querySelector("[data-fb-pagination]");
  if (totalPages <= 1) {
    pagination.innerHTML = "";
  } else {
    let buttons = "";
    for (let i = 1; i <= totalPages; i++) {
      buttons += `<button class="fb-btn fb-btn--sm ${i === fbCurrentPage ? "fb-btn--primary" : "fb-btn--ghost"}" data-fb-page="${i}" aria-label="Página ${i}" ${i === fbCurrentPage ? 'aria-current="page"' : ""}>${i}</button>`;
    }
    pagination.innerHTML = buttons;
    pagination.querySelectorAll("[data-fb-page]").forEach((btn) => {
      btn.addEventListener("click", () => {
        fbCurrentPage = Number(btn.dataset.fbPage);
        fbRenderMarket();
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });
  }
}

document.addEventListener("DOMContentLoaded", () => {
  fbLoadMarket();
  ["[data-fb-filter-search]", "[data-fb-filter-club]", "[data-fb-filter-position]", "[data-fb-filter-sort]"].forEach((sel) => {
    document.querySelector(sel).addEventListener("input", () => { fbCurrentPage = 1; fbRenderMarket(); });
  });
});
