import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/*
 * Supabase project settings:
 * Supabase Dashboard > Project Settings > API
 * Use the Project URL and anon/public key only.
 * Never put the service_role key in this file.
 */
const SUPABASE_URL = "YOUR_SUPABASE_URL";
const SUPABASE_ANON_KEY = "YOUR_SUPABASE_ANON_KEY";

const configured = !SUPABASE_URL.includes("YOUR_") && !SUPABASE_ANON_KEY.includes("YOUR_");
const supabase = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const $ = (id) => document.getElementById(id);
const state = { session: null, profile: null, role: "member", threads: [], activeThread: null, authMode: "login", view: "threads" };

function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  setTimeout(() => el.classList.remove("show"), 2600);
}
function message(id, text, type = "") {
  const el = $(id); el.textContent = text; el.className = `message ${type}`;
}
function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function initials(name = "?") { return [...name.trim()].slice(0,1).join("").toUpperCase() || "?"; }
function formatDate(value) {
  return new Intl.DateTimeFormat("ja-JP", { dateStyle:"medium", timeStyle:"short" }).format(new Date(value));
}
function requireConfig() {
  if (!configured) {
    $("auth-view").classList.remove("hidden");
    message("auth-message", "app.js の SUPABASE_URL と SUPABASE_ANON_KEY を設定してください。", "error");
    return false;
  }
  return true;
}

function setAuthMode(mode) {
  state.authMode = mode;
  $("login-tab").classList.toggle("active", mode === "login");
  $("signup-tab").classList.toggle("active", mode === "signup");
  $("invite-field").classList.toggle("hidden", mode !== "signup");
  $("auth-submit").textContent = mode === "login" ? "ログイン" : "招待コードを使って登録";
  $("password").autocomplete = mode === "login" ? "current-password" : "new-password";
  message("auth-message", "");
}

async function refreshSession() {
  if (!requireConfig()) return;
  const { data: { session } } = await supabase.auth.getSession();
  state.session = session;
  if (!session) { showAuth(); return; }
  const { data: profile, error } = await supabase.from("profiles").select("*").eq("id", session.user.id).maybeSingle();
  if (error) { console.error(error); toast("プロフィールを読み込めませんでした"); return; }
  state.profile = profile;
  const { data: membership, error: membershipError } = await supabase.from("memberships").select("role").eq("user_id", session.user.id).maybeSingle();
  if (membershipError || !membership) {
    await supabase.auth.signOut();
    showAuth();
    message("auth-message", "このアカウントは掲示板のメンバーではありません。招待コードを確認してください。", "error");
    return;
  }
  state.role = membership.role;
  showBoard();
  await loadThreads();
}
function showAuth() {
  $("auth-view").classList.remove("hidden"); $("board-view").classList.add("hidden");
  $("logout-button").classList.add("hidden"); $("current-user").textContent = "";
}
function showBoard() {
  $("auth-view").classList.add("hidden"); $("board-view").classList.remove("hidden");
  $("logout-button").classList.remove("hidden");
  const name = state.profile?.display_name || state.session.user.email.split("@")[0];
  $("current-user").textContent = name;
  $("my-name").textContent = name; $("my-avatar").textContent = initials(name);
  $("my-role").textContent = state.role === "admin" ? "管理者" : "メンバー";
  $("settings-email").textContent = state.session.user.email;
  $("display-name-input").value = state.profile?.display_name || "";
  $("invite-admin").classList.toggle("hidden", state.role !== "admin");
}
function switchView(view) {
  state.view = view;
  $("threads-view").classList.toggle("hidden", view !== "threads");
  $("detail-view").classList.add("hidden");
  $("members-view").classList.toggle("hidden", view !== "members");
  $("settings-view").classList.toggle("hidden", view !== "settings");
  document.querySelectorAll(".nav-item[data-view]").forEach(el => el.classList.toggle("active", el.dataset.view === view));
  if (view === "members") loadMembers();
}
async function loadThreads() {
  const { data, error } = await supabase.from("threads")
    .select("id,title,body,created_at,author_id,profiles!threads_author_id_fkey(display_name),posts(count)")
    .order("created_at", { ascending:false });
  if (error) { console.error(error); toast("スレッドを読み込めませんでした"); return; }
  state.threads = data || [];
  renderThreads();
}
function renderThreads() {
  const query = $("search-input").value.trim().toLocaleLowerCase();
  const sort = $("sort-select").value;
  let rows = state.threads.filter(t => `${t.title} ${t.body}`.toLocaleLowerCase().includes(query));
  if (sort === "replies") rows.sort((a,b) => (b.posts?.[0]?.count || 0) - (a.posts?.[0]?.count || 0));
  $("thread-list").innerHTML = rows.length ? rows.map(t => {
    const name = t.profiles?.display_name || "メンバー";
    const count = t.posts?.[0]?.count || 0;
    return `<article class="thread-card" data-thread="${t.id}">
      <h3>${escapeHtml(t.title)}</h3><div class="thread-excerpt">${escapeHtml(t.body)}</div>
      <div class="thread-meta"><strong>${escapeHtml(name)}</strong><span>${formatDate(t.created_at)}</span><span>返信 ${count}件</span></div>
    </article>`;
  }).join("") : `<div class="empty-state">スレッドはまだありません。最初のスレッドを作成してください。</div>`;
  document.querySelectorAll(".thread-card").forEach(el => el.addEventListener("click", () => openThread(el.dataset.thread)));
}
async function openThread(id) {
  const { data, error } = await supabase.from("threads")
    .select("id,title,body,created_at,author_id,profiles!threads_author_id_fkey(display_name)")
    .eq("id", id).single();
  if (error) { toast("スレッドを開けませんでした"); return; }
  state.activeThread = data;
  $("threads-view").classList.add("hidden"); $("detail-view").classList.remove("hidden");
  await renderThreadDetail();
}
async function renderThreadDetail() {
  const t = state.activeThread;
  const isOwner = t.author_id === state.session.user.id;
  const canManage = isOwner || state.role === "admin";
  $("thread-detail").innerHTML = `
    <article class="detail-card">
      <p class="eyebrow">THREAD</p><h1>${escapeHtml(t.title)}</h1>
      <div class="thread-meta"><strong>${escapeHtml(t.profiles?.display_name || "メンバー")}</strong><span>${formatDate(t.created_at)}</span></div>
      <div class="detail-body">${escapeHtml(t.body)}</div>
      ${canManage ? `<div class="detail-actions"><button class="text-button" id="delete-thread">スレッドを削除</button></div>` : ""}
    </article>
    <div class="reply-bar"><h2>返信</h2><button class="button button-primary" id="reply-button">返信する</button></div>
    <div id="post-list" class="post-list"></div>`;
  if (canManage) $("delete-thread").addEventListener("click", deleteThread);
  $("reply-button").addEventListener("click", () => $("reply-dialog").showModal());
  const { data: posts, error } = await supabase.from("posts")
    .select("id,body,created_at,author_id,parent_post_id,profiles!posts_author_id_fkey(display_name)")
    .eq("thread_id", t.id).order("created_at", { ascending:true });
  if (error) { toast("返信を読み込めませんでした"); return; }
  $("post-list").innerHTML = posts.length ? posts.map(p => {
    const owner = p.author_id === state.session.user.id || state.role === "admin";
    return `<article class="post-card"><div class="post-head"><strong>${escapeHtml(p.profiles?.display_name || "メンバー")}</strong><span>${formatDate(p.created_at)}</span></div>
      <div class="post-body">${escapeHtml(p.body)}</div>
      ${owner ? `<div class="post-actions"><button class="text-button" data-delete-post="${p.id}">削除</button></div>` : ""}
    </article>`;
  }).join("") : `<div class="empty-state">まだ返信はありません。</div>`;
  document.querySelectorAll("[data-delete-post]").forEach(el => el.addEventListener("click", () => deletePost(el.dataset.deletePost)));
}
async function deleteThread() {
  if (!confirm("このスレッドと返信を削除しますか？")) return;
  const { error } = await supabase.from("threads").delete().eq("id", state.activeThread.id);
  if (error) { toast("削除できませんでした"); return; }
  state.activeThread = null; $("detail-view").classList.add("hidden"); $("threads-view").classList.remove("hidden");
  await loadThreads(); toast("スレッドを削除しました");
}
async function deletePost(id) {
  if (!confirm("この返信を削除しますか？")) return;
  const { error } = await supabase.from("posts").delete().eq("id", id);
  if (error) { toast("削除できませんでした"); return; }
  await renderThreadDetail(); toast("返信を削除しました");
}
async function loadMembers() {
  const { data, error } = await supabase.from("memberships")
    .select("role,created_at,profiles!memberships_user_id_fkey(display_name)")
    .order("created_at", { ascending:true });
  if (error) { console.error(error); toast("メンバーを読み込めませんでした"); return; }
  $("member-list").innerHTML = data.length ? data.map(m => {
    const name = m.profiles?.display_name || "メンバー";
    return `<div class="member-card"><span class="avatar">${initials(name)}</span><div><b>${escapeHtml(name)}</b><small>${m.role === "admin" ? "管理者" : "メンバー"} ・ ${formatDate(m.created_at)}</small></div></div>`;
  }).join("") : `<div class="empty-state">メンバー情報がありません。</div>`;
}
async function createInvite() {
  const { data, error } = await supabase.rpc("create_invitation");
  if (error) { message("invite-result", error.message, "error"); return; }
  message("invite-result", `招待コード：${data}（この画面を閉じる前にコピーしてください）`, "success");
  try { await navigator.clipboard.writeText(data); toast("招待コードをコピーしました"); } catch {}
}
async function handleAuthSubmit(event) {
  event.preventDefault();
  if (!configured) return;
  const email = $("email").value.trim(), password = $("password").value;
  const code = $("invite-code").value.trim();
  message("auth-message", "処理中です…");
  if (state.authMode === "login") {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { message("auth-message", error.message, "error"); return; }
    await refreshSession();
  } else {
    if (!code) { message("auth-message", "招待コードを入力してください。", "error"); return; }
    const { data, error } = await supabase.auth.signUp({ email, password, options:{ data:{ display_name: email.split("@")[0] } } });
    if (error) { message("auth-message", error.message, "error"); return; }
    sessionStorage.setItem("friends_board_invite", code);
    if (data.session) {
      const { error: redeemError } = await supabase.rpc("redeem_invitation", { p_code:code });
      if (redeemError) { message("auth-message", redeemError.message, "error"); return; }
      sessionStorage.removeItem("friends_board_invite");
      await refreshSession();
    } else {
      message("auth-message", "確認メールを送信しました。メール内のリンクから認証した後、ログインしてください。招待コードはこのブラウザのセッション中に保持されます。", "success");
    }
  }
}
async function redeemPendingInvite() {
  const code = sessionStorage.getItem("friends_board_invite");
  if (!code || !state.session) return;
  const { error } = await supabase.rpc("redeem_invitation", { p_code:code });
  if (error) { message("auth-message", `招待コードの登録に失敗しました：${error.message}`, "error"); return; }
  sessionStorage.removeItem("friends_board_invite");
}
async function init() {
  $("login-tab").addEventListener("click", () => setAuthMode("login"));
  $("signup-tab").addEventListener("click", () => setAuthMode("signup"));
  $("auth-form").addEventListener("submit", handleAuthSubmit);
  $("logout-button").addEventListener("click", async () => { await supabase.auth.signOut(); state.session = null; showAuth(); });
  $("new-thread-button").addEventListener("click", () => { $("thread-form").reset(); message("thread-form-message",""); $("thread-dialog").showModal(); });
  $("thread-form").addEventListener("submit", async e => {
    e.preventDefault();
    const { error } = await supabase.from("threads").insert({ title:$("thread-title").value.trim(), body:$("thread-body").value.trim(), author_id:state.session.user.id });
    if (error) { message("thread-form-message", error.message, "error"); return; }
    $("thread-dialog").close(); await loadThreads(); toast("スレッドを作成しました");
  });
  $("reply-form").addEventListener("submit", async e => {
    e.preventDefault();
    const { error } = await supabase.from("posts").insert({ thread_id:state.activeThread.id, body:$("reply-body").value.trim(), author_id:state.session.user.id });
    if (error) { message("reply-form-message", error.message, "error"); return; }
    $("reply-dialog").close(); $("reply-form").reset(); await renderThreadDetail(); toast("返信を投稿しました");
  });
  document.querySelectorAll("[data-close]").forEach(el => el.addEventListener("click", () => $(el.dataset.close).close()));
  document.querySelectorAll(".nav-item[data-view]").forEach(el => el.addEventListener("click", () => switchView(el.dataset.view)));
  $("back-to-threads").addEventListener("click", () => { state.activeThread = null; $("detail-view").classList.add("hidden"); $("threads-view").classList.remove("hidden"); });
  $("search-input").addEventListener("input", renderThreads);
  $("sort-select").addEventListener("change", renderThreads);
  $("create-invite-button").addEventListener("click", createInvite);
  $("profile-form").addEventListener("submit", async e => {
    e.preventDefault();
    const display_name = $("display-name-input").value.trim();
    if (!display_name) { message("profile-message", "表示名を入力してください。", "error"); return; }
    const { error } = await supabase.from("profiles").update({ display_name }).eq("id", state.session.user.id);
    if (error) { message("profile-message", error.message, "error"); return; }
    state.profile.display_name = display_name; showBoard(); message("profile-message", "保存しました。", "success");
  });
  $("brand-home").addEventListener("click", e => { e.preventDefault(); if (state.session) switchView("threads"); });
  if (!requireConfig()) return;
  await refreshSession();
  supabase.auth.onAuthStateChange(async (_event, session) => {
    state.session = session;
    if (session) {
      await redeemPendingInvite();
      await refreshSession();
    } else showAuth();
  });
}
init();
