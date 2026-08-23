// Cliente Supabase partilhado + helpers de autenticação/sessão
// Requer que config.js tenha sido carregado antes deste ficheiro,
// e a lib supabase-js (via CDN) antes de ambos.

window.fbSupabase = window.supabase.createClient(
  window.FB_CONFIG.SUPABASE_URL,
  window.FB_CONFIG.SUPABASE_ANON_KEY
);

const fbSupabase = window.fbSupabase;

async function fbGetSession() {
  const { data } = await fbSupabase.auth.getSession();
  return data.session;
}

async function fbGetProfile() {
  const session = await fbGetSession();
  if (!session) return null;
  const { data, error } = await fbSupabase
    .from("profiles")
    .select("*")
    .eq("id", session.user.id)
    .single();
  if (error) return null;
  return data;
}

async function fbRequireAuth(redirectTo = "/login.html") {
  const session = await fbGetSession();
  if (!session) {
    window.location.href = redirectTo;
    return null;
  }
  return session;
}

async function fbSignOut() {
  await fbSupabase.auth.signOut();
  window.location.href = "/index.html";
}

// Formata um valor numérico em R$ (Real brasileiro), aceitando milhões abreviados na UI
function fbFormatBRL(value) {
  if (value === null || value === undefined) return "R$ 0";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
    maximumFractionDigits: 0,
  }).format(value);
}

function fbFormatBRLCompact(value) {
  if (value === null || value === undefined) return "R$ 0";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return "R$ " + (value / 1_000_000).toFixed(1).replace(".0", "") + "M";
  if (abs >= 1_000) return "R$ " + (value / 1_000).toFixed(0) + "mil";
  return fbFormatBRL(value);
}

// Preenche o cabeçalho comum (nav) com o estado de sessão (logado/deslogado)
async function fbInitHeader() {
  const session = await fbGetSession();
  const authArea = document.querySelector("[data-fb-auth-area]");
  if (!authArea) return;

  if (session) {
    const profile = await fbGetProfile();
    authArea.innerHTML = `
      <div class="fb-nav-user">
        <a href="/perfil.html" class="fb-nav-user__name">${profile?.team_name ?? "Meu Time"}</a>
        ${profile?.role === "admin" ? '<a href="/admin.html" class="fb-btn fb-btn--ghost fb-btn--sm">Admin</a>' : ""}
        <button class="fb-btn fb-btn--ghost fb-btn--sm" data-fb-signout>Sair</button>
      </div>`;
    authArea.querySelector("[data-fb-signout]")?.addEventListener("click", fbSignOut);
  } else {
    authArea.innerHTML = `
      <a href="/login.html" class="fb-btn fb-btn--ghost fb-btn--sm">Entrar</a>
      <a href="/registo.html" class="fb-btn fb-btn--primary fb-btn--sm">Criar time grátis</a>`;
  }
}

function fbInitMobileNav() {
  const toggle = document.querySelector("[data-fb-nav-toggle]");
  const links = document.querySelector(".fb-nav__links");
  if (!toggle || !links) return;
  toggle.addEventListener("click", () => {
    const isOpen = links.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", String(isOpen));
    toggle.textContent = isOpen ? "✕" : "☰";
  });
  links.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => {
    links.classList.remove("is-open");
    toggle.setAttribute("aria-expanded", "false");
    toggle.textContent = "☰";
  }));
}

// ---------- Avatar genérico (cor do clube + iniciais) ----------
// Sem fotos de imprensa de jogadores (ver nota em mercado.js) — o avatar usa
// as cores do clube num gradiente com as iniciais do jogador, e um selo de
// posição no canto, para dar identidade visual sem usar imagens reais.
const FB_POSITION_META = {
  GOL: { label: "Goleiro", short: "GOL", color: "#c47a00" },
  ZAG: { label: "Zagueiro", short: "ZAG", color: "#1a4fa0" },
  LAT: { label: "Lateral", short: "LAT", color: "#1a4fa0" },
  MEI: { label: "Meia", short: "MEI", color: "#147a3a" },
  ATA: { label: "Atacante", short: "ATA", color: "#b8232e" },
};

function fbShade(hex, amt) {
  const c = (hex || "#009c3b").replace("#", "");
  const num = parseInt(c.length === 3 ? c.split("").map((x) => x + x).join("") : c, 16);
  let r = (num >> 16) + amt, g = ((num >> 8) & 0xff) + amt, b = (num & 0xff) + amt;
  r = Math.max(0, Math.min(255, r)); g = Math.max(0, Math.min(255, g)); b = Math.max(0, Math.min(255, b));
  return "#" + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

function fbInitials(name) {
  return (name || "?").split(" ").filter(Boolean).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

function fbAvatarHTML(name, clubColor, position, size) {
  size = size || 34;
  const color = clubColor || "#009c3b";
  const dark = fbShade(color, -40);
  const pos = FB_POSITION_META[position];
  const badge = pos
    ? `<span class="fb-avatar__pos" style="background:${pos.color}" title="${pos.label}">${pos.short[0]}</span>`
    : "";
  const fontSize = Math.round(size * 0.36);
  return `<span class="fb-avatar" style="width:${size}px;height:${size}px;font-size:${fontSize}px;background:linear-gradient(150deg, ${color}, ${dark})">
    ${fbInitials(name)}${badge}
  </span>`;
}

// ---------- Watchlist (favoritos) — guardado localmente no browser ----------
const FB_WATCHLIST_KEY = "fb_watchlist";

function fbGetWatchlist() {
  try {
    return new Set(JSON.parse(localStorage.getItem(FB_WATCHLIST_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function fbIsWatchlisted(playerId) {
  return fbGetWatchlist().has(playerId);
}

function fbToggleWatchlist(playerId) {
  const set = fbGetWatchlist();
  if (set.has(playerId)) set.delete(playerId);
  else set.add(playerId);
  localStorage.setItem(FB_WATCHLIST_KEY, JSON.stringify([...set]));
  return set.has(playerId);
}

document.addEventListener("DOMContentLoaded", () => { fbInitHeader(); fbInitMobileNav(); });
