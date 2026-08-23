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
let fbPlayersById = {};
let fbCompareIds = [];
const FB_COMPARE_MAX = 3;

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
    tbody.innerHTML = `<tr><td colspan="9" class="fb-text-muted">
      Não foi possível carregar o mercado. Confirma que o Supabase está configurado em <code>js/config.js</code>,
      que correste <code>supabase/schema.sql</code> + <code>supabase/seed_clubs.sql</code>, e que já importaste
      os jogadores (ver <code>SETUP.md</code>).</td></tr>`;
    return;
  }

  fbAllClubs = clubs;
  fbAllPlayers = players;
  fbPlayersById = Object.fromEntries(players.map((p) => [p.id, p]));
  fbOwnershipByPlayerId = Object.fromEntries((ownership || []).map((o) => [o.player_id, o.ownership_pct]));

  clubSelect.innerHTML = '<option value="">Todos os clubes</option>' +
    clubs.map((c) => `<option value="${c.id}">${c.name}</option>`).join("");

  if (!players.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="fb-empty">Ainda não há jogadores importados.
      Um admin precisa correr o import de elenco/valores (ver <code>SETUP.md</code>).</td></tr>`;
    return;
  }

  fbRenderMarketStats();
  fbRenderMarket();
}

function fbRenderMarketStats() {
  const el = document.querySelector("[data-fb-market-stats]");
  if (!el || !fbAllPlayers.length) return;
  const priciest = fbAllPlayers.reduce((a, b) => ((b.market_value_brl ?? 0) > (a.market_value_brl ?? 0) ? b : a));
  const totalValue = fbAllPlayers.reduce((sum, p) => sum + (p.market_value_brl ?? 0), 0);
  const avgValue = totalValue / fbAllPlayers.length;
  el.innerHTML = `
    <div class="fb-modal__stat"><strong>${fbAllPlayers.length}</strong><span>Jogadores no mercado</span></div>
    <div class="fb-modal__stat"><strong>${fbFormatBRLCompact(priciest.market_value_brl)}</strong><span>${priciest.name}</span></div>
    <div class="fb-modal__stat"><strong>${fbFormatBRLCompact(avgValue)}</strong><span>Valor médio</span></div>
    <div class="fb-modal__stat"><strong>${fbGetWatchlist().size}</strong><span>Na tua watchlist</span></div>`;
}

function fbRenderMarket() {
  const search = document.querySelector("[data-fb-filter-search]").value.trim().toLowerCase();
  const clubId = document.querySelector("[data-fb-filter-club]").value;
  const position = document.querySelector("[data-fb-filter-position]").value;
  const sort = document.querySelector("[data-fb-filter-sort]").value;
  const onlyWatchlist = document.querySelector("[data-fb-filter-watchlist]")?.checked;
  const watchlist = fbGetWatchlist();

  let list = fbAllPlayers.filter((p) => {
    if (search && !p.name.toLowerCase().includes(search)) return false;
    if (clubId && String(p.club_id) !== clubId) return false;
    if (position && p.position !== position) return false;
    if (onlyWatchlist && !watchlist.has(p.id)) return false;
    return true;
  });

  list.sort((a, b) => {
    if (sort === "value_asc") return (a.market_value_brl ?? 0) - (b.market_value_brl ?? 0);
    if (sort === "name_asc") return a.name.localeCompare(b.name);
    if (sort === "ownership_desc") return (fbOwnershipByPlayerId[b.id] ?? 0) - (fbOwnershipByPlayerId[a.id] ?? 0);
    return (b.market_value_brl ?? 0) - (a.market_value_brl ?? 0);
  });

  const totalPages = Math.max(1, Math.ceil(list.length / FB_PAGE_SIZE));
  fbCurrentPage = Math.min(fbCurrentPage, totalPages);
  const pageItems = list.slice((fbCurrentPage - 1) * FB_PAGE_SIZE, fbCurrentPage * FB_PAGE_SIZE);

  const countEl = document.querySelector("[data-fb-result-count]");
  if (countEl) countEl.textContent = `${list.length} jogador${list.length === 1 ? "" : "es"}`;

  const tbody = document.querySelector("[data-fb-players-tbody]");
  if (!pageItems.length) {
    tbody.innerHTML = `<tr><td colspan="9" class="fb-empty">Nenhum jogador encontrado com esses filtros.</td></tr>`;
  } else {
    tbody.innerHTML = pageItems.map((p) => {
      const club = p.clubs;
      const color = club?.primary_color || "#009c3b";
      const isStarred = watchlist.has(p.id);
      const isComparing = fbCompareIds.includes(p.id);
      return `
        <tr data-fb-player-row="${p.id}">
          <td>
            <button class="fb-star-btn ${isStarred ? "is-active" : ""}" data-fb-star="${p.id}"
              aria-label="${isStarred ? "Remover da" : "Adicionar à"} watchlist" title="Watchlist"></button>
          </td>
          <td>
            <input type="checkbox" data-fb-compare="${p.id}" ${isComparing ? "checked" : ""}
              title="Comparar (até ${FB_COMPARE_MAX})" aria-label="Selecionar ${p.name} para comparar"
              ${!isComparing && fbCompareIds.length >= FB_COMPARE_MAX ? "disabled" : ""}>
          </td>
          <td>
            <div class="fb-player-cell" data-fb-open-player="${p.id}" style="cursor:pointer;">
              ${fbAvatarHTML(p.name, color, p.position, 34)}
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

    tbody.querySelectorAll("[data-fb-star]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = Number(btn.dataset.fbStar);
        const active = fbToggleWatchlist(id);
        btn.classList.toggle("is-active", active);
        btn.setAttribute("aria-label", active ? "Remover da watchlist" : "Adicionar à watchlist");
        fbRenderMarketStats();
        if (onlyWatchlist && !active) fbRenderMarket();
      });
    });
    tbody.querySelectorAll("[data-fb-open-player]").forEach((cell) => {
      cell.addEventListener("click", () => fbOpenPlayerModal(Number(cell.dataset.fbOpenPlayer)));
    });
    tbody.querySelectorAll("[data-fb-compare]").forEach((cb) => {
      cb.addEventListener("change", (e) => {
        e.stopPropagation();
        const id = Number(cb.dataset.fbCompare);
        if (cb.checked) {
          if (fbCompareIds.length >= FB_COMPARE_MAX) { cb.checked = false; return; }
          fbCompareIds.push(id);
        } else {
          fbCompareIds = fbCompareIds.filter((x) => x !== id);
        }
        fbRenderCompareBar();
        fbRenderMarket();
      });
      cb.addEventListener("click", (e) => e.stopPropagation());
    });
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

function fbOpenPlayerModal(playerId) {
  const p = fbPlayersById[playerId];
  if (!p) return;
  const backdrop = document.querySelector("[data-fb-player-modal]");
  const club = p.clubs;
  const color = club?.primary_color || "#009c3b";
  const ownership = fbOwnershipByPlayerId[p.id] ?? 0;
  const isStarred = fbIsWatchlisted(p.id);
  backdrop.querySelector("[data-fb-modal-body]").style.maxWidth = "";

  backdrop.querySelector("[data-fb-modal-body]").innerHTML = `
    <button class="fb-modal__close" data-fb-modal-close aria-label="Fechar">✕</button>
    <div class="fb-modal__head">
      ${fbAvatarHTML(p.name, color, p.position, 60)}
      <div>
        <h3>${p.name}</h3>
        <div class="fb-flex fb-gap-8" style="flex-wrap:wrap;">
          <span class="fb-tag fb-tag--pos-${p.position}">${FB_POSITION_LABEL[p.position] ?? p.position}</span>
          <span class="fb-club-cell"><span class="fb-club-dot" style="background:${color}"></span>${club?.name ?? "—"}</span>
        </div>
      </div>
    </div>
    ${p.status && p.status !== "disponivel" ? `<div style="margin-bottom:14px;">${FB_STATUS_BADGE[p.status] || ""}</div>` : ""}
    <div class="fb-modal__stats">
      <div class="fb-modal__stat"><strong>${fbFormatBRLCompact(p.market_value_brl)}</strong><span>Valor de mercado</span></div>
      <div class="fb-modal__stat"><strong>${ownership}%</strong><span>Escalado por</span></div>
      <div class="fb-modal__stat"><strong>${p.season_goals ?? 0}</strong><span>Gols · época</span></div>
      <div class="fb-modal__stat"><strong>${p.season_yellow_cards ?? 0} 🟨 / ${p.season_red_cards ?? 0} 🟥</strong><span>Cartões · época</span></div>
    </div>
    <button class="fb-btn ${isStarred ? "fb-btn--primary" : "fb-btn--ghost"} fb-btn--full" data-fb-modal-star="${p.id}">
      ${isStarred ? "★ Na watchlist" : "☆ Adicionar à watchlist"}
    </button>`;

  backdrop.querySelector("[data-fb-modal-close]").addEventListener("click", fbClosePlayerModal);
  backdrop.querySelector("[data-fb-modal-star]").addEventListener("click", (e) => {
    const active = fbToggleWatchlist(p.id);
    e.target.textContent = active ? "★ Na watchlist" : "☆ Adicionar à watchlist";
    e.target.classList.toggle("fb-btn--primary", active);
    e.target.classList.toggle("fb-btn--ghost", !active);
    fbRenderMarketStats();
    fbRenderMarket();
  });
  backdrop.classList.add("is-open");
}

function fbClosePlayerModal() {
  document.querySelector("[data-fb-player-modal]")?.classList.remove("is-open");
}

function fbRenderCompareBar() {
  const bar = document.querySelector("[data-fb-compare-bar]");
  if (!bar) return;
  if (!fbCompareIds.length) { bar.classList.remove("is-open"); return; }
  bar.classList.add("is-open");
  const chips = fbCompareIds.map((id) => {
    const p = fbPlayersById[id];
    if (!p) return "";
    return `<span class="fb-compare-chip">${fbAvatarHTML(p.name, p.clubs?.primary_color, p.position, 24)} ${p.name}
      <button data-fb-compare-remove="${id}" aria-label="Remover ${p.name} da comparação">✕</button></span>`;
  }).join("");
  bar.innerHTML = `
    <div class="fb-compare-bar__chips">${chips}</div>
    <div class="fb-flex fb-gap-8">
      <button class="fb-btn fb-btn--ghost fb-btn--sm" data-fb-compare-clear>Limpar</button>
      <button class="fb-btn fb-btn--primary fb-btn--sm" data-fb-compare-open ${fbCompareIds.length < 2 ? "disabled" : ""}>Comparar (${fbCompareIds.length})</button>
    </div>`;
  bar.querySelectorAll("[data-fb-compare-remove]").forEach((btn) => {
    btn.addEventListener("click", () => {
      fbCompareIds = fbCompareIds.filter((x) => x !== Number(btn.dataset.fbCompareRemove));
      fbRenderCompareBar();
      fbRenderMarket();
    });
  });
  bar.querySelector("[data-fb-compare-clear]")?.addEventListener("click", () => {
    fbCompareIds = [];
    fbRenderCompareBar();
    fbRenderMarket();
  });
  bar.querySelector("[data-fb-compare-open]")?.addEventListener("click", fbOpenCompareModal);
}

function fbOpenCompareModal() {
  if (fbCompareIds.length < 2) return;
  const players = fbCompareIds.map((id) => fbPlayersById[id]).filter(Boolean);
  const rows = [
    ["Clube", (p) => p.clubs?.short_name ?? "—"],
    ["Posição", (p) => FB_POSITION_LABEL[p.position] ?? p.position],
    ["Valor de mercado", (p) => fbFormatBRLCompact(p.market_value_brl)],
    ["Escalado por", (p) => `${fbOwnershipByPlayerId[p.id] ?? 0}%`],
    ["Gols · época", (p) => p.season_goals ?? 0],
    ["Cartões · época", (p) => `${p.season_yellow_cards ?? 0}🟨 / ${p.season_red_cards ?? 0}🟥`],
  ];
  const backdrop = document.querySelector("[data-fb-player-modal]");
  backdrop.querySelector("[data-fb-modal-body]").style.maxWidth = "640px";
  backdrop.querySelector("[data-fb-modal-body]").innerHTML = `
    <button class="fb-modal__close" data-fb-modal-close aria-label="Fechar">✕</button>
    <h3 style="margin-bottom:16px;">Comparar jogadores</h3>
    <div class="fb-compare-table">
      <div class="fb-compare-table__row fb-compare-table__row--head">
        <div></div>
        ${players.map((p) => `<div>${fbAvatarHTML(p.name, p.clubs?.primary_color, p.position, 40)}<div style="font-weight:700;font-size:0.82rem;margin-top:6px;">${p.name}</div></div>`).join("")}
      </div>
      ${rows.map(([label, fn]) => `
        <div class="fb-compare-table__row">
          <div class="fb-text-soft">${label}</div>
          ${players.map((p) => `<div>${fn(p)}</div>`).join("")}
        </div>`).join("")}
    </div>`;
  backdrop.querySelector("[data-fb-modal-close]").addEventListener("click", fbClosePlayerModal);
  backdrop.classList.add("is-open");
}

document.addEventListener("DOMContentLoaded", () => {
  fbLoadMarket();
  ["[data-fb-filter-search]", "[data-fb-filter-club]", "[data-fb-filter-position]", "[data-fb-filter-sort]"].forEach((sel) => {
    document.querySelector(sel).addEventListener("input", () => { fbCurrentPage = 1; fbRenderMarket(); });
  });
  document.querySelector("[data-fb-filter-watchlist]")?.addEventListener("change", () => { fbCurrentPage = 1; fbRenderMarket(); });

  const backdrop = document.querySelector("[data-fb-player-modal]");
  if (backdrop) {
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) fbClosePlayerModal(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") fbClosePlayerModal(); });
  }
});
