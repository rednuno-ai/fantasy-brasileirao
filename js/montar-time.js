// Montar Time — construção do elenco de 23 jogadores dentro do orçamento,
// escolha dos titulares da rodada e do capitão. Escreve direto no Supabase
// a cada ação (sem botão "guardar" separado, para nunca perder progresso).

const FB_QUOTA = { GOL: 3, DEF: 8, MEI: 8, ATA: 4 };
const FB_POSITION_LABEL = { GOL: "Goleiro", ZAG: "Zagueiro", LAT: "Lateral", MEI: "Meia", ATA: "Atacante" };
const FB_GROUP_ORDER = ["GOL", "ZAG", "LAT", "MEI", "ATA"];
const FB_STATUS_BADGE = {
  lesionado: '<span class="fb-status-dot fb-status-dot--out" title="Lesionado">🔴</span>',
  suspenso: '<span class="fb-status-dot fb-status-dot--out" title="Suspenso">🔴</span>',
  duvida: '<span class="fb-status-dot fb-status-dot--doubt" title="Dúvida para a próxima rodada">🟡</span>',
  emprestado: '<span class="fb-status-dot fb-status-dot--doubt" title="Emprestado a outro clube">🔵</span>',
};

function fbBucket(position) {
  return position === "ZAG" || position === "LAT" ? "DEF" : position;
}

const FB_TRANSFER_PENALTY = -4; // pontos perdidos por troca extra além da grátis, mesma convenção do FPL

let fbState = {
  session: null,
  season: null,
  team: null,
  squad: [], // { id, player_id, is_starting, purchase_price_brl, players: {...} }
  allPlayers: [],
  gameweek: null,
  chipUses: [], // chips já usados pelo time (qualquer rodada/metade)
  hasPlayedBefore: false, // já teve pelo menos uma rodada pontuada? (define se trocas contam)
  transfersThisGameweek: 0,
};

const FB_CHIPS = [
  { key: "triple_captain", label: "Capitão Triplo", icon: "👑", description: "O capitão pontua 3x em vez de 2x nesta rodada." },
  { key: "bench_boost", label: "Banco Reforçado", icon: "🚀", description: "Os pontos dos 4 reservas também contam nesta rodada." },
];

function fbShowError(msg) {
  const box = document.querySelector("[data-fb-alert-error]");
  box.textContent = msg;
  box.classList.add("is-visible");
  setTimeout(() => box.classList.remove("is-visible"), 4000);
}

function fbShowSuccess(msg) {
  const box = document.querySelector("[data-fb-alert-success]");
  box.textContent = msg;
  box.classList.add("is-visible");
  setTimeout(() => box.classList.remove("is-visible"), 2500);
}

async function fbInit() {
  const session = await fbRequireAuth();
  if (!session) return;
  fbState.session = session;

  const { data: season } = await fbSupabase.from("seasons").select("*").eq("is_active", true).limit(1).maybeSingle();
  if (!season) {
    document.querySelector("[data-fb-squad-groups]").innerHTML =
      '<p class="fb-empty">Nenhuma temporada ativa configurada ainda. Um admin precisa ativar uma em <code>seasons</code>.</p>';
    return;
  }
  fbState.season = season;

  let { data: team } = await fbSupabase
    .from("fantasy_teams")
    .select("*")
    .eq("user_id", session.user.id)
    .eq("season_id", season.id)
    .maybeSingle();

  if (!team) {
    const { data: newTeam, error } = await fbSupabase
      .from("fantasy_teams")
      .insert({ user_id: session.user.id, season_id: season.id })
      .select("*")
      .single();
    if (error) { fbShowError("Não foi possível criar o teu time: " + error.message); return; }
    team = newTeam;
  }
  fbState.team = team;

  const { data: gameweek } = await fbSupabase
    .from("gameweeks")
    .select("*")
    .eq("season_id", season.id)
    .in("status", ["mercado_aberto", "em_andamento"])
    .order("number", { ascending: true })
    .limit(1)
    .maybeSingle();
  fbState.gameweek = gameweek;

  const profile = await fbGetProfile();
  document.querySelector("[data-fb-team-title]").textContent = profile?.team_name || "Montar Time";

  const { count: scoredGameweeks } = await fbSupabase
    .from("fantasy_team_gameweek_score")
    .select("id", { count: "exact", head: true })
    .eq("fantasy_team_id", team.id);
  fbState.hasPlayedBefore = (scoredGameweeks || 0) > 0;

  if (gameweek) {
    const { count: transfersUsed } = await fbSupabase
      .from("transfers")
      .select("id", { count: "exact", head: true })
      .eq("fantasy_team_id", team.id)
      .eq("gameweek_id", gameweek.id);
    fbState.transfersThisGameweek = transfersUsed || 0;
  }

  await fbLoadSquad();
  await fbLoadAllPlayers();
  await fbLoadChips();
  fbRenderAll();
  fbRenderDeadline();
  setInterval(fbRenderDeadline, 60000);

  document.querySelector("[data-fb-picker-search]").addEventListener("input", fbRenderPicker);
  document.querySelector("[data-fb-picker-position]").addEventListener("change", fbRenderPicker);
}

async function fbLoadSquad() {
  const { data, error } = await fbSupabase
    .from("fantasy_team_players")
    .select("id, player_id, is_starting, purchase_price_brl, players(id, name, position, club_id, status, clubs(name, short_name, primary_color))")
    .eq("fantasy_team_id", fbState.team.id);
  if (error) { fbShowError("Erro ao carregar elenco: " + error.message); return; }
  fbState.squad = data || [];
}

async function fbLoadAllPlayers() {
  const { data, error } = await fbSupabase
    .from("players")
    .select("id, name, position, club_id, market_value_brl, status, clubs(name, short_name, primary_color)")
    .eq("is_active", true)
    .order("market_value_brl", { ascending: false });
  if (error) { fbShowError("Erro ao carregar mercado: " + error.message); return; }
  fbState.allPlayers = data || [];
}

async function fbLoadChips() {
  const { data, error } = await fbSupabase
    .from("fantasy_team_chip_uses")
    .select("*")
    .eq("fantasy_team_id", fbState.team.id);
  if (error) { fbShowError("Erro ao carregar chips: " + error.message); return; }
  fbState.chipUses = data || [];
}

function fbSeasonHalf(gameweekNumber) {
  return gameweekNumber <= 19 ? 1 : 2;
}

function fbRenderDeadline() {
  const el = document.querySelector("[data-fb-deadline]");
  if (!el) return;

  if (!fbState.gameweek) {
    el.textContent = "Sem rodada com mercado aberto no momento.";
    el.style.color = "var(--fb-text-muted)";
    return;
  }

  const diffMs = new Date(fbState.gameweek.deadline_at) - new Date();
  if (diffMs <= 0) {
    el.textContent = `Mercado da ${fbState.gameweek.name} fechado.`;
    el.style.color = "var(--fb-negative)";
    return;
  }

  const totalMinutes = Math.floor(diffMs / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [days ? `${days}d` : null, (days || hours) ? `${hours}h` : null, `${minutes}min`].filter(Boolean);

  el.textContent = `⏱ ${fbState.gameweek.name}: mercado fecha em ${parts.join(" ")}`;
  el.style.color = totalMinutes < 120 ? "var(--fb-negative)" : "var(--fb-brand-strong)";
}

function fbBudgetSpent() {
  return fbState.squad.reduce((sum, s) => sum + Number(s.purchase_price_brl || 0), 0);
}

function fbStartersCount() {
  return fbState.squad.filter((s) => s.is_starting).length;
}

function fbRenderAll() {
  fbRenderBudget();
  fbRenderSquad();
  fbRenderPicker();
  fbRenderChips();
}

function fbRenderChips() {
  const container = document.querySelector("[data-fb-chips]");
  if (!container) return;

  if (!fbState.gameweek) {
    container.innerHTML = '<p class="fb-text-muted" style="font-size:0.86rem;">Sem rodada com mercado aberto no momento — os chips ativam-se quando houver uma.</p>';
    return;
  }

  const half = fbSeasonHalf(fbState.gameweek.number);
  container.innerHTML = FB_CHIPS.map((chip) => {
    const usedThisHalf = fbState.chipUses.find((c) => c.chip_key === chip.key && c.season_half === half);
    const activeThisWeek = usedThisHalf && usedThisHalf.gameweek_id === fbState.gameweek.id;
    const usedElsewhere = usedThisHalf && !activeThisWeek;

    let action;
    if (activeThisWeek) action = `<button class="fb-btn fb-btn--accent fb-btn--sm" data-fb-cancel-chip="${usedThisHalf.id}">Ativo — cancelar</button>`;
    else if (usedElsewhere) action = `<span class="fb-status-pill">Já usado (${half === 1 ? "1ª" : "2ª"} metade)</span>`;
    else action = `<button class="fb-btn fb-btn--ghost fb-btn--sm" data-fb-use-chip="${chip.key}">Ativar nesta rodada</button>`;

    return `
      <div class="fb-liga-card" style="margin-bottom:8px;">
        <div>
          <strong>${chip.icon} ${chip.label}</strong>
          <div class="fb-text-muted" style="font-size:0.82rem;">${chip.description}</div>
        </div>
        ${action}
      </div>`;
  }).join("");

  container.querySelectorAll("[data-fb-use-chip]").forEach((btn) =>
    btn.addEventListener("click", () => fbUseChip(btn.dataset.fbUseChip))
  );
  container.querySelectorAll("[data-fb-cancel-chip]").forEach((btn) =>
    btn.addEventListener("click", () => fbCancelChip(Number(btn.dataset.fbCancelChip)))
  );
}

async function fbUseChip(chipKey) {
  if (!fbState.gameweek) return;
  const half = fbSeasonHalf(fbState.gameweek.number);
  const { data, error } = await fbSupabase.from("fantasy_team_chip_uses").insert({
    fantasy_team_id: fbState.team.id, chip_key: chipKey, season_half: half, gameweek_id: fbState.gameweek.id,
  }).select("*").single();
  if (error) return fbShowError("Não foi possível ativar o chip: " + error.message);
  fbState.chipUses.push(data);
  fbRenderChips();
  fbShowSuccess("Chip ativado para esta rodada!");
}

async function fbCancelChip(id) {
  const { error } = await fbSupabase.from("fantasy_team_chip_uses").delete().eq("id", id);
  if (error) return fbShowError("Não foi possível cancelar (o prazo da rodada já passou?): " + error.message);
  fbState.chipUses = fbState.chipUses.filter((c) => c.id !== id);
  fbRenderChips();
}

function fbRenderBudget() {
  const total = Number(fbState.season.budget_brl);
  const spent = fbBudgetSpent();
  const pct = Math.min(100, (spent / total) * 100);
  document.querySelector("[data-fb-budget-total]").textContent = fbFormatBRL(total);
  document.querySelector("[data-fb-budget-spent]").textContent = fbFormatBRL(spent);
  document.querySelector("[data-fb-budget-fill]").style.width = pct + "%";
  document.querySelector("[data-fb-squad-count]").textContent = `${fbState.squad.length} / 23 jogadores · ${fbStartersCount()} / 11 titulares`;

  const transferInfo = document.querySelector("[data-fb-transfer-info]");
  if (transferInfo) {
    if (!fbState.hasPlayedBefore) {
      transferInfo.textContent = "Ainda a montar o elenco inicial — trocas livres até à 1ª rodada.";
    } else if (!fbState.gameweek) {
      transferInfo.textContent = "Sem rodada com mercado aberto no momento.";
    } else if (fbState.transfersThisGameweek === 0) {
      transferInfo.textContent = "1 troca grátis disponível nesta rodada.";
    } else {
      transferInfo.textContent = `${fbState.transfersThisGameweek} troca(s) usada(s) nesta rodada — a próxima custa ${FB_TRANSFER_PENALTY} pontos.`;
    }
  }
}

function fbRenderSquad() {
  const container = document.querySelector("[data-fb-squad-groups]");
  const byPosition = {};
  FB_GROUP_ORDER.forEach((p) => (byPosition[p] = []));
  fbState.squad.forEach((s) => byPosition[s.players.position]?.push(s));

  container.innerHTML = FB_GROUP_ORDER.map((pos) => {
    const bucket = fbBucket(pos);
    const bucketFilled = fbState.squad.filter((s) => fbBucket(s.players.position) === bucket).length;
    const bucketQuota = FB_QUOTA[bucket];
    const items = byPosition[pos];
    const cards = items.length
      ? items.map((s) => fbSquadCardHTML(s)).join("")
      : `<div class="fb-empty-slot">Nenhum ${FB_POSITION_LABEL[pos].toLowerCase()} escalado ainda.</div>`;
    return `
      <div class="fb-pos-group">
        <h3>${FB_POSITION_LABEL[pos]}s <span class="fb-count">${bucketFilled}/${bucketQuota} da vaga (${pos === "ZAG" || pos === "LAT" ? "defensores combinados" : "posição"})</span></h3>
        <div class="fb-squad-list">${cards}</div>
      </div>`;
  }).join("");

  container.querySelectorAll("[data-fb-remove]").forEach((btn) =>
    btn.addEventListener("click", () => fbRemovePlayer(Number(btn.dataset.fbRemove)))
  );
  container.querySelectorAll("[data-fb-toggle-starter]").forEach((btn) =>
    btn.addEventListener("click", () => fbToggleStarter(Number(btn.dataset.fbToggleStarter)))
  );
  container.querySelectorAll("[data-fb-toggle-captain]").forEach((btn) =>
    btn.addEventListener("click", () => fbToggleCaptain(Number(btn.dataset.fbToggleCaptain)))
  );
}

function fbSquadCardHTML(s) {
  const club = s.players.clubs;
  const color = club?.primary_color || "#009c3b";
  const isCaptain = fbState.team.captain_player_id === s.player_id;
  const statusBadge = FB_STATUS_BADGE[s.players.status] || "";
  return `
    <div class="fb-squad-card">
      <span class="fb-player-avatar" style="background:${color}">${s.players.position}</span>
      <div class="fb-squad-card__info">
        <div class="fb-squad-card__name">${s.players.name} ${statusBadge}</div>
        <div class="fb-squad-card__meta">${club?.short_name ?? "—"} · ${fbFormatBRLCompact(s.purchase_price_brl)}</div>
      </div>
      <div class="fb-squad-card__actions">
        <button class="fb-icon-btn ${s.is_starting ? "is-active" : ""}" title="Titular da rodada" aria-label="Marcar ${s.players.name} como titular da rodada" aria-pressed="${s.is_starting}" data-fb-toggle-starter="${s.id}">T</button>
        <button class="fb-icon-btn ${isCaptain ? "is-active" : ""}" title="Capitão (pontua em dobro)" aria-label="Marcar ${s.players.name} como capitão" aria-pressed="${isCaptain}" data-fb-toggle-captain="${s.player_id}" ${s.is_starting ? "" : "disabled"}>★</button>
        <button class="fb-icon-btn" title="Remover do elenco" aria-label="Remover ${s.players.name} do elenco" data-fb-remove="${s.id}">✕</button>
      </div>
    </div>`;
}

function fbRenderPicker() {
  const search = document.querySelector("[data-fb-picker-search]").value.trim().toLowerCase();
  const position = document.querySelector("[data-fb-picker-position]").value;
  const squadIds = new Set(fbState.squad.map((s) => s.player_id));
  const total = Number(fbState.season.budget_brl);
  const remaining = total - fbBudgetSpent();

  let list = fbState.allPlayers.filter((p) => {
    if (squadIds.has(p.id)) return false;
    if (search && !p.name.toLowerCase().includes(search)) return false;
    if (position && p.position !== position) return false;
    return true;
  }).slice(0, 60);

  const listEl = document.querySelector("[data-fb-picker-list]");
  if (!list.length) {
    listEl.innerHTML = '<p class="fb-empty" style="padding:20px 0;">Nenhum jogador encontrado.</p>';
    return;
  }

  listEl.innerHTML = list.map((p) => {
    const club = p.clubs;
    const color = club?.primary_color || "#009c3b";
    const bucket = fbBucket(p.position);
    const bucketFilled = fbState.squad.filter((s) => fbBucket(s.players.position) === bucket).length;
    const quotaFull = bucketFilled >= FB_QUOTA[bucket];
    const tooExpensive = Number(p.market_value_brl) > remaining;
    const disabled = quotaFull || tooExpensive;
    const reason = quotaFull ? "Vaga da posição cheia" : tooExpensive ? "Orçamento insuficiente" : "";
    return `
      <div class="fb-squad-card">
        <span class="fb-player-avatar" style="background:${color}">${p.position}</span>
        <div class="fb-squad-card__info">
          <div class="fb-squad-card__name">${p.name} ${FB_STATUS_BADGE[p.status] || ""}</div>
          <div class="fb-squad-card__meta">${club?.short_name ?? "—"} · ${fbFormatBRLCompact(p.market_value_brl)}</div>
        </div>
        <button class="fb-icon-btn" style="width:auto;padding:0 10px;border-radius:8px;" data-fb-add="${p.id}" ${disabled ? "disabled" : ""} title="${reason}" aria-label="Adicionar ${p.name} ao elenco${reason ? " (" + reason + ")" : ""}">+</button>
      </div>`;
  }).join("");

  listEl.querySelectorAll("[data-fb-add]").forEach((btn) =>
    btn.addEventListener("click", () => fbAddPlayer(Number(btn.dataset.fbAdd)))
  );
}

async function fbAddPlayer(playerId) {
  const player = fbState.allPlayers.find((p) => p.id === playerId);
  if (!player) return;
  const bucket = fbBucket(player.position);
  const bucketFilled = fbState.squad.filter((s) => fbBucket(s.players.position) === bucket).length;
  if (bucketFilled >= FB_QUOTA[bucket]) return fbShowError(`Vaga de ${FB_POSITION_LABEL[player.position]} já está cheia.`);

  const remaining = Number(fbState.season.budget_brl) - fbBudgetSpent();
  if (Number(player.market_value_brl) > remaining) return fbShowError("Orçamento insuficiente para este jogador.");

  const { data, error } = await fbSupabase
    .from("fantasy_team_players")
    .insert({
      fantasy_team_id: fbState.team.id,
      player_id: playerId,
      purchase_price_brl: player.market_value_brl,
      is_starting: fbStartersCount() < 11,
    })
    .select("id, player_id, is_starting, purchase_price_brl, players(id, name, position, club_id, status, clubs(name, short_name, primary_color))")
    .single();

  if (error) return fbShowError("Não foi possível adicionar: " + error.message);
  fbState.squad.push(data);
  fbRenderAll();
  fbShowSuccess(`${player.name} adicionado ao elenco.`);
}

async function fbRemovePlayer(rowId) {
  const entry = fbState.squad.find((s) => s.id === rowId);
  if (!entry) return;

  // Só conta como "troca" (com limite de 1 grátis/rodada) depois de já teres disputado
  // pelo menos uma rodada — a montagem inicial do elenco é livre.
  const willCostPoints = fbState.hasPlayedBefore && fbState.gameweek && fbState.transfersThisGameweek >= 1;
  if (willCostPoints) {
    const ok = confirm(`Já usaste a tua troca grátis desta rodada. Remover ${entry.players.name} agora custa ${FB_TRANSFER_PENALTY} pontos na pontuação da rodada. Continuar?`);
    if (!ok) return;
  }

  const { error } = await fbSupabase.from("fantasy_team_players").delete().eq("id", rowId);
  if (error) return fbShowError("Não foi possível remover: " + error.message);
  fbState.squad = fbState.squad.filter((s) => s.id !== rowId);

  if (fbState.hasPlayedBefore && fbState.gameweek) {
    const isFree = fbState.transfersThisGameweek === 0;
    const { error: trErr } = await fbSupabase.from("transfers").insert({
      fantasy_team_id: fbState.team.id,
      gameweek_id: fbState.gameweek.id,
      player_out_id: entry.player_id,
      was_free: isFree,
      point_penalty: isFree ? 0 : FB_TRANSFER_PENALTY,
    });
    if (!trErr) fbState.transfersThisGameweek++;
  }

  if (fbState.team.captain_player_id === entry.player_id) {
    await fbSupabase.from("fantasy_teams").update({ captain_player_id: null }).eq("id", fbState.team.id);
    fbState.team.captain_player_id = null;
  }
  fbRenderAll();
}

async function fbToggleStarter(rowId) {
  const entry = fbState.squad.find((s) => s.id === rowId);
  if (!entry) return;

  if (!entry.is_starting && fbStartersCount() >= 11) {
    return fbShowError("Já tens 11 titulares escalados — desmarca outro primeiro.");
  }

  const nextValue = !entry.is_starting;

  // só pode haver 1 goleiro titular: desmarca o anterior automaticamente
  if (nextValue && entry.players.position === "GOL") {
    const otherGK = fbState.squad.find((s) => s.players.position === "GOL" && s.is_starting && s.id !== rowId);
    if (otherGK) {
      await fbSupabase.from("fantasy_team_players").update({ is_starting: false }).eq("id", otherGK.id);
      otherGK.is_starting = false;
    }
  }

  const { error } = await fbSupabase.from("fantasy_team_players").update({ is_starting: nextValue }).eq("id", rowId);
  if (error) return fbShowError("Não foi possível atualizar: " + error.message);
  entry.is_starting = nextValue;

  if (!nextValue && fbState.team.captain_player_id === entry.player_id) {
    await fbSupabase.from("fantasy_teams").update({ captain_player_id: null }).eq("id", fbState.team.id);
    fbState.team.captain_player_id = null;
  }
  fbRenderAll();
}

async function fbToggleCaptain(playerId) {
  const entry = fbState.squad.find((s) => s.player_id === playerId);
  if (!entry || !entry.is_starting) return;
  const nextCaptain = fbState.team.captain_player_id === playerId ? null : playerId;
  const { error } = await fbSupabase.from("fantasy_teams").update({ captain_player_id: nextCaptain }).eq("id", fbState.team.id);
  if (error) return fbShowError("Não foi possível definir capitão: " + error.message);
  fbState.team.captain_player_id = nextCaptain;
  fbRenderSquad();
}

document.addEventListener("DOMContentLoaded", fbInit);
