// Painel de administração — só visível para profiles.role = 'admin' (RLS também bloqueia
// as escritas no servidor, isto é só para a experiência de UI).

let fbAdminSeason = null;
const FB_GW_STATUS_LABEL = {
  agendada: "Agendada", mercado_aberto: "Mercado aberto", mercado_fechado: "Mercado fechado",
  em_andamento: "Em andamento", finalizada: "Finalizada",
};

async function fbAdminInit() {
  const session = await fbRequireAuth();
  if (!session) return;
  const profile = await fbGetProfile();
  const guard = document.querySelector("[data-fb-admin-guard]");
  const content = document.querySelector("[data-fb-admin-content]");

  if (profile?.role !== "admin") {
    guard.innerHTML = `<p class="fb-empty">Esta área é só para administradores da liga.
      Pede a alguém com acesso ao Supabase para mudar a tua <code>role</code> para <code>admin</code>
      na tabela <code>profiles</code> (ver SETUP.md).</p>`;
    return;
  }

  guard.style.display = "none";
  content.style.display = "block";

  const { data: season } = await fbSupabase.from("seasons").select("*").eq("is_active", true).limit(1).maybeSingle();
  fbAdminSeason = season;

  await Promise.all([fbLoadGameweeks(), fbLoadRules(), fbLoadFixturesAndPlayersForStats()]);

  document.querySelector("[data-fb-gameweek-form]").addEventListener("submit", fbCreateGameweek);
  document.querySelector("[data-fb-stats-lookup-form]").addEventListener("submit", fbLoadStatsRow);
}

// ---------- Rodadas ----------
async function fbLoadGameweeks() {
  const tbody = document.querySelector("[data-fb-gameweeks-tbody]");
  if (!fbAdminSeason) { tbody.innerHTML = '<tr><td colspan="5" class="fb-text-muted">Sem temporada ativa.</td></tr>'; return; }
  const { data, error } = await fbSupabase.from("gameweeks").select("*").eq("season_id", fbAdminSeason.id).order("number");
  if (error || !data) { tbody.innerHTML = `<tr><td colspan="5" class="fb-text-muted">Erro: ${error?.message}</td></tr>`; return; }
  if (!data.length) { tbody.innerHTML = '<tr><td colspan="5" class="fb-text-muted">Nenhuma rodada criada ainda.</td></tr>'; return; }

  tbody.innerHTML = data.map((gw) => `
    <tr>
      <td>${gw.number}</td>
      <td>${gw.name}</td>
      <td>${new Date(gw.deadline_at).toLocaleString("pt-BR")}</td>
      <td><span class="fb-status-pill">${FB_GW_STATUS_LABEL[gw.status] || gw.status}</span></td>
      <td>
        <select data-fb-gw-status="${gw.id}" style="font-size:0.78rem;">
          ${Object.entries(FB_GW_STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${gw.status === k ? "selected" : ""}>${v}</option>`).join("")}
        </select>
        <button class="fb-btn fb-btn--ghost fb-btn--sm" data-fb-gw-close="${gw.id}" title="Soma a pontuação de todos os times nesta rodada (titulares, capitão em dobro) e marca como finalizada">Fechar e pontuar</button>
      </td>
    </tr>`).join("");

  tbody.querySelectorAll("[data-fb-gw-status]").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const { error } = await fbSupabase.from("gameweeks").update({ status: sel.value }).eq("id", sel.dataset.fbGwStatus);
      if (error) alert("Erro ao atualizar status: " + error.message);
    });
  });

  tbody.querySelectorAll("[data-fb-gw-close]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      if (!confirm("Fechar esta rodada e calcular a pontuação de todos os times? Isto marca a rodada como finalizada.")) return;
      btn.disabled = true;
      btn.textContent = "A calcular...";
      const { error } = await fbSupabase.rpc("fb_close_gameweek", { p_gameweek_id: Number(btn.dataset.fbGwClose) });
      if (error) { alert("Erro ao fechar rodada: " + error.message); btn.disabled = false; btn.textContent = "Fechar e pontuar"; return; }
      btn.textContent = "Pontuado ✓";
      fbLoadGameweeks();
    });
  });
}

async function fbCreateGameweek(e) {
  e.preventDefault();
  if (!fbAdminSeason) return alert("Sem temporada ativa.");
  const form = e.target;
  const number = Number(form.querySelector('[data-fb-field="number"]').value);
  const name = form.querySelector('[data-fb-field="name"]').value.trim();
  const deadline_at = form.querySelector('[data-fb-field="deadline_at"]').value;

  const { error } = await fbSupabase.from("gameweeks").insert({
    season_id: fbAdminSeason.id, number, name, deadline_at: new Date(deadline_at).toISOString(),
  });
  if (error) return alert("Erro ao criar rodada: " + error.message);
  form.reset();
  fbLoadGameweeks();
}

// ---------- Regras de pontuação ----------
async function fbLoadRules() {
  const tbody = document.querySelector("[data-fb-rules-tbody]");
  const { data, error } = await fbSupabase.from("scoring_rules").select("*").order("points", { ascending: false });
  if (error || !data) { tbody.innerHTML = `<tr><td colspan="4" class="fb-text-muted">Erro: ${error?.message}</td></tr>`; return; }

  tbody.innerHTML = data.map((r) => `
    <tr>
      <td>${r.label}</td>
      <td><input class="fb-points-input" type="number" step="0.1" value="${r.points}" data-fb-rule-points="${r.event_key}"></td>
      <td>${r.auto_computed ? "Automático (CBF)" : "Manual"}</td>
      <td><button class="fb-btn fb-btn--ghost fb-btn--sm" data-fb-rule-save="${r.event_key}">Guardar</button></td>
    </tr>`).join("");

  tbody.querySelectorAll("[data-fb-rule-save]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const key = btn.dataset.fbRuleSave;
      const input = tbody.querySelector(`[data-fb-rule-points="${key}"]`);
      const { error } = await fbSupabase.from("scoring_rules").update({ points: Number(input.value) }).eq("event_key", key);
      if (error) return alert("Erro ao guardar: " + error.message);
      btn.textContent = "Guardado ✓";
      setTimeout(() => (btn.textContent = "Guardar"), 1500);
    });
  });
}

// ---------- Estatísticas manuais ----------
async function fbLoadFixturesAndPlayersForStats() {
  const fixtureSelect = document.querySelector('[data-fb-stats-lookup-form] [data-fb-field="fixture_id"]');
  const playerSelect = document.querySelector('[data-fb-stats-lookup-form] [data-fb-field="player_id"]');

  const { data: fixtures } = await fbSupabase
    .from("fixtures")
    .select("id, kickoff_at, home_club_id, away_club_id, home_score, away_score, clubs_home:home_club_id(short_name), clubs_away:away_club_id(short_name)")
    .order("kickoff_at", { ascending: false })
    .limit(60);
  fixtureSelect.innerHTML = (fixtures || []).map((f) =>
    `<option value="${f.id}">${f.clubs_home?.short_name ?? "?"} ${f.home_score ?? "-"} x ${f.away_score ?? "-"} ${f.clubs_away?.short_name ?? "?"} (${new Date(f.kickoff_at).toLocaleDateString("pt-BR")})</option>`
  ).join("") || '<option value="">Nenhuma partida cadastrada</option>';

  const { data: players } = await fbSupabase.from("players").select("id, name, position").order("name").limit(1000);
  playerSelect.innerHTML = (players || []).map((p) => `<option value="${p.id}">${p.name} (${p.position})</option>`).join("");
}

async function fbLoadStatsRow(e) {
  e.preventDefault();
  const fixture_id = document.querySelector('[data-fb-field="fixture_id"]').value;
  const player_id = document.querySelector('[data-fb-field="player_id"]').value;
  if (!fixture_id || !player_id) return;

  let { data: row } = await fbSupabase.from("player_stats").select("*").eq("fixture_id", fixture_id).eq("player_id", player_id).maybeSingle();
  if (!row) {
    const { data: created, error } = await fbSupabase.from("player_stats").insert({ fixture_id, player_id }).select("*").single();
    if (error) return alert("Erro ao criar linha: " + error.message);
    row = created;
  }
  fbRenderStatsEditor(row);
}

const FB_STAT_FIELDS = [
  ["minutes_played", "Minutos jogados"], ["goals", "Gols"], ["assists", "Assistências"],
  ["yellow_cards", "Cartões amarelos"], ["red_cards", "Cartões vermelhos"], ["own_goals", "Gols contra"],
  ["penalties_missed", "Pênaltis perdidos"], ["penalties_committed", "Pênaltis cometidos"],
  ["penalties_won", "Pênaltis sofridos"], ["penalties_saved", "Pênaltis defendidos"],
  ["difficult_saves", "Defesas difíceis"], ["goals_conceded", "Gols sofridos"],
  ["shots_woodwork", "Bola na trave"], ["tackles", "Desarmes"],
  ["fouls_suffered", "Faltas sofridas"], ["fouls_committed", "Faltas cometidas"], ["offsides", "Impedimentos"],
];

function fbRenderStatsEditor(row) {
  const container = document.querySelector("[data-fb-stats-editor]");
  container.innerHTML = `
    <div class="fb-inline-form" style="margin-top:12px;">
      ${FB_STAT_FIELDS.map(([key, label]) => `
        <div class="fb-field" style="min-width:120px;">
          <label style="font-size:0.75rem;">${label}</label>
          <input type="number" step="1" value="${row[key] ?? 0}" data-fb-stat="${key}" class="fb-points-input" style="width:100%;">
        </div>`).join("")}
      <div class="fb-field" style="min-width:120px;">
        <label style="font-size:0.75rem;">Resultado</label>
        <select data-fb-stat="result" class="fb-points-input" style="width:100%;">
          <option value="" ${!row.result ? "selected" : ""}>—</option>
          <option value="vitoria" ${row.result === "vitoria" ? "selected" : ""}>Vitória</option>
          <option value="empate" ${row.result === "empate" ? "selected" : ""}>Empate</option>
          <option value="derrota" ${row.result === "derrota" ? "selected" : ""}>Derrota</option>
        </select>
      </div>
      <div class="fb-field" style="min-width:120px;">
        <label style="font-size:0.75rem;">Sem sofrer gol</label>
        <select data-fb-stat="clean_sheet" class="fb-points-input" style="width:100%;">
          <option value="false" ${!row.clean_sheet ? "selected" : ""}>Não</option>
          <option value="true" ${row.clean_sheet ? "selected" : ""}>Sim</option>
        </select>
      </div>
    </div>
    <div class="fb-flex fb-gap-12" style="margin-top:10px;">
      <button class="fb-btn fb-btn--primary fb-btn--sm" data-fb-stats-save>Guardar estatísticas</button>
      <span class="fb-text-muted" style="font-size:0.85rem;">Pontuação calculada: <strong data-fb-stats-points>${row.fantasy_points ?? 0}</strong></span>
    </div>`;

  container.querySelector("[data-fb-stats-save]").addEventListener("click", async () => {
    const payload = {};
    FB_STAT_FIELDS.forEach(([key]) => { payload[key] = Number(container.querySelector(`[data-fb-stat="${key}"]`).value) || 0; });
    payload.result = container.querySelector('[data-fb-stat="result"]').value || null;
    payload.clean_sheet = container.querySelector('[data-fb-stat="clean_sheet"]').value === "true";

    const { data, error } = await fbSupabase.from("player_stats").update(payload).eq("id", row.id).select("*").single();
    if (error) return alert("Erro ao guardar: " + error.message);
    container.querySelector("[data-fb-stats-points]").textContent = data.fantasy_points;
  });
}

document.addEventListener("DOMContentLoaded", fbAdminInit);
