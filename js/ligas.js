// Ligas privadas — criar, entrar por código, listar as minhas, e ver o ranking de uma liga.

let fbSession = null;
let fbSeason = null;

function fbShowErr(msg) {
  const box = document.querySelector("[data-fb-alert-error]");
  box.textContent = msg;
  box.classList.add("is-visible");
  setTimeout(() => box.classList.remove("is-visible"), 4000);
}
function fbShowOk(msg) {
  const box = document.querySelector("[data-fb-alert-success]");
  box.textContent = msg;
  box.classList.add("is-visible");
  setTimeout(() => box.classList.remove("is-visible"), 3000);
}

function fbRandomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sem O/0/I/1 para evitar confusão
  let code = "";
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

async function fbInitLigas() {
  fbSession = await fbRequireAuth();
  if (!fbSession) return;

  const { data: season } = await fbSupabase.from("seasons").select("*").eq("is_active", true).limit(1).maybeSingle();
  fbSeason = season;
  if (!season) { fbShowErr("Nenhuma temporada ativa configurada."); return; }

  await fbLoadMyLeagues();

  document.querySelector("[data-fb-create-form]").addEventListener("submit", fbCreateLeague);
  document.querySelector("[data-fb-join-form]").addEventListener("submit", fbJoinLeague);
}

async function fbLoadMyLeagues() {
  const container = document.querySelector("[data-fb-my-leagues]");

  const { data: memberships, error } = await fbSupabase
    .from("private_league_members")
    .select("private_leagues(id, name, invite_code, owner_id, season_id)")
    .eq("user_id", fbSession.user.id);

  if (error) { container.innerHTML = `<p class="fb-text-muted">Erro ao carregar: ${error.message}</p>`; return; }
  if (!memberships?.length) {
    container.innerHTML = '<p class="fb-empty">Ainda não fazes parte de nenhuma liga privada — cria uma ou entra com um código.</p>';
    return;
  }

  container.innerHTML = memberships.map(({ private_leagues: liga }) => `
    <div class="fb-liga-card">
      <div>
        <strong>${liga.name}</strong>
        <div class="fb-text-muted" style="font-size:0.82rem;">Código: <span class="fb-liga-code">${liga.invite_code}</span></div>
      </div>
      <button class="fb-btn fb-btn--ghost fb-btn--sm" data-fb-view-league="${liga.id}" data-fb-view-name="${liga.name}">Ver classificação</button>
    </div>
  `).join("");

  container.querySelectorAll("[data-fb-view-league]").forEach((btn) => {
    btn.addEventListener("click", () => fbShowLeagueDetail(btn.dataset.fbViewLeague, btn.dataset.fbViewName));
  });
}

async function fbCreateLeague(e) {
  e.preventDefault();
  const name = document.getElementById("liga_name").value.trim();
  if (!name) return;

  let created = null;
  for (let attempt = 0; attempt < 5 && !created; attempt++) {
    const code = fbRandomCode();
    const { data, error } = await fbSupabase.from("private_leagues").insert({
      name, invite_code: code, owner_id: fbSession.user.id, season_id: fbSeason.id,
    }).select("*").single();
    if (!error) created = data;
    else if (!error.message.includes("duplicate")) { fbShowErr("Erro ao criar liga: " + error.message); return; }
  }
  if (!created) { fbShowErr("Não foi possível gerar um código único, tenta novamente."); return; }

  await fbSupabase.from("private_league_members").insert({ private_league_id: created.id, user_id: fbSession.user.id });
  document.getElementById("liga_name").value = "";
  fbShowOk(`Liga "${created.name}" criada! Código: ${created.invite_code}`);
  fbLoadMyLeagues();
}

async function fbJoinLeague(e) {
  e.preventDefault();
  const code = document.getElementById("invite_code").value.trim().toUpperCase();
  if (!code) return;

  const { data: liga, error } = await fbSupabase.from("private_leagues").select("*").eq("invite_code", code).maybeSingle();
  if (error || !liga) { fbShowErr("Código não encontrado. Confirma com quem te convidou."); return; }

  const { error: joinError } = await fbSupabase.from("private_league_members").insert({ private_league_id: liga.id, user_id: fbSession.user.id });
  if (joinError) {
    if (joinError.message.includes("duplicate")) fbShowErr("Já fazes parte desta liga.");
    else fbShowErr("Erro ao entrar: " + joinError.message);
    return;
  }
  document.getElementById("invite_code").value = "";
  fbShowOk(`Entraste na liga "${liga.name}"!`);
  fbLoadMyLeagues();
}

async function fbShowLeagueDetail(leagueId, leagueName) {
  const container = document.querySelector("[data-fb-league-detail]");
  container.innerHTML = `<div class="fb-skeleton" style="height:120px;"></div>`;
  container.scrollIntoView({ behavior: "smooth", block: "nearest" });

  const { data: members, error } = await fbSupabase
    .from("private_league_members")
    .select("user_id")
    .eq("private_league_id", leagueId);
  if (error || !members?.length) { container.innerHTML = '<p class="fb-empty">Sem membros ainda.</p>'; return; }

  const userIds = members.map((m) => m.user_id);
  const { data: rows } = await fbSupabase
    .from("leaderboard")
    .select("*")
    .eq("season_id", fbSeason.id)
    .in("user_id", userIds)
    .order("total_points", { ascending: false });

  container.innerHTML = `
    <h2 style="margin-bottom:14px;">${leagueName}</h2>
    <div class="fb-table-wrap">
      <table class="fb-table">
        <thead><tr><th>#</th><th>Time</th><th>Treinador</th><th>Pontos</th></tr></thead>
        <tbody>
          ${(rows || []).map((r, i) => `
            <tr>
              <td>${i + 1}</td>
              <td><strong>${r.team_name}</strong></td>
              <td class="fb-text-muted">@${r.username}</td>
              <td><strong>${Number(r.total_points).toFixed(1)}</strong></td>
            </tr>`).join("") || '<tr><td colspan="4" class="fb-empty">Ainda sem pontuação.</td></tr>'}
        </tbody>
      </table>
    </div>`;
}

document.addEventListener("DOMContentLoaded", fbInitLigas);
