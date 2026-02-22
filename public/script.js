/* =========================================================
   GSRP Portal - public/script.js
   Fixes:
   - Multi-select/checkbox values collapse into ONE line
   - Admin Command Dashboard now matches server.js responses:
       /api/admin/logs/summary -> { ok, rows }
       /api/admin/logs/user/:id -> { ok, logs } with fieldsJson
   ========================================================= */

let currentUser = null;

function showLoginOverlay() {
  document.getElementById("loginOverlay")?.classList.remove("hidden");
}
function hideLoginOverlay() {
  document.getElementById("loginOverlay")?.classList.add("hidden");
}

// Discord no longer uses discriminators for most accounts.
// This helper prevents showing "#undefined" in the UI.
function getUserHandle(user) {
  if (!user) return "";
  if (
    user.discriminator &&
    String(user.discriminator).trim() &&
    String(user.discriminator) !== "0"
  ) {
    return user.username + "#" + user.discriminator;
  }
  return user.tag || user.username;
}

function setLoggedInUI(user) {
  currentUser = user;
  hideLoginOverlay();

  const label = user.displayName || user.username;

  const sideName = document.getElementById("sidebarUserName");
  const sideRank = document.getElementById("sidebarUserRank");
  const topName = document.getElementById("topbarUserName");
  const topRank = document.getElementById("topbarUserRank");

  if (sideName) sideName.textContent = label;
  if (sideRank) sideRank.textContent = getUserHandle(user);
  if (topName) topName.textContent = label;
  if (topRank) topRank.textContent = getUserHandle(user);
}

async function checkAuth() {
  try {
    const res = await fetch("/api/me", { credentials: "include" });
    if (!res.ok) {
      showLoginOverlay();
      return;
    }
    const data = await res.json();
    if (data.ok && data.user) setLoggedInUI(data.user);
    else showLoginOverlay();
  } catch (e) {
    console.error(e);
    showLoginOverlay();
  }
}

/* =========================================================
   Discord ID formatting (no pings) -> "[Nickname] - (ID)"
   ========================================================= */

const __discordMemberCache = new Map();

function extractDiscordIds(raw) {
  if (!raw) return [];
  const str = String(raw);
  const matches = str.match(/\d{15,20}/g);
  return matches ? Array.from(new Set(matches)) : [];
}

async function fetchMemberDisplayName(id) {
  if (__discordMemberCache.has(id)) return __discordMemberCache.get(id);

  try {
    const res = await fetch(`/api/discord/member/${encodeURIComponent(id)}`, {
      credentials: "include",
    });
    const data = await res.json().catch(() => ({}));
    const name =
      data && data.ok && data.displayName ? String(data.displayName) : "";
    __discordMemberCache.set(id, name);
    return name;
  } catch (e) {
    __discordMemberCache.set(id, "");
    return "";
  }
}

function wrapNameForLog(name) {
  const n = String(name || "").trim();
  if (!n) return "";
  // Many names already start with a callsign in brackets, e.g. "[T-411] Quinoa"
  return n.startsWith("[") ? n : `[${n}]`;
}

function looksLikeDiscordIdField(fieldKey) {
  const k = String(fieldKey || "").toLowerCase();
  return (
    (k.includes("discord") && k.includes("id")) ||
    k.includes("discord_id") ||
    k.includes("discordid")
  );
}

async function formatDiscordIdsInValue(label, value) {
  if (!value) return value;
  if (!looksLikeDiscordIdField(label)) return value;

  const ids = extractDiscordIds(value);
  if (!ids.length) return value;

  let out = String(value);

  for (const id of ids) {
    const nickRaw = await fetchMemberDisplayName(id);
    const nick = wrapNameForLog(nickRaw) || "(Unknown User)";
    const replacement = `${nick} - (${id}) <@${id}>`;

    out = out.replace(new RegExp(`\\b${id}\\b`, "g"), replacement);
    out = out.replace(new RegExp(`<@!?${id}>`, "g"), replacement);
  }

  return out;
}

/* =========================================================
   MULTI-SELECT FIX:
   Collapse duplicate keys into a single entry, comma-separated
   Example: RTO: North, South, Highways
   ========================================================= */

function collapseMultiValueFields(entries) {
  const order = [];
  const map = new Map();

  for (const [k, v] of entries) {
    if (!map.has(k)) {
      map.set(k, []);
      order.push(k);
    }
    map.get(k).push(v);
  }

  return order.map((k) => {
    const vals = (map.get(k) || [])
      .map((x) => (x == null ? "" : String(x).trim()))
      .filter(Boolean);

    const joined = vals.length > 1 ? vals.join(", ") : vals[0] || "";
    return [k, joined];
  });
}

/* =========================================================
   DISCORD WEBHOOK SEND + STORE TO DB
   ========================================================= */

async function sendToDiscord(formName, fields, user, webhook) {
  const blocks = await Promise.all(
    fields.map(async ([k, v]) => {
      const formatted = await formatDiscordIdsInValue(k, v || "");
      const val = (formatted || "").trim() || "*n/a*";
      return `**${k}:**\n${val}`;
    })
  );

  const description = ["Georgia State Roleplay. Cuz We Can.", "", ...blocks].join(
    "\n\n"
  );

  const dn = (user.displayName || "").trim();
  const submitNick =
    dn && dn !== user.username ? (dn.startsWith("[") ? ` ${dn}` : ` [${dn}]`) : "";

  const footerText = `Submitted by ${getUserHandle(user)}${submitNick} | ID: ${user.id}`;

  const payload = {
    username: "Portal Logs",
    allowed_mentions: { parse: [] }, // prevents ALL pings
    embeds: [
      {
        title: formName || "Portal Submission",
        description,
        color: 0xf97316,
        footer: { text: footerText },
        timestamp: new Date().toISOString(),
      },
    ],
  };

  // 1) Send to Discord webhook
  const res = await fetch(webhook, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error("Webhook returned " + res.status);

  // 2) Store in backend for Command Dashboard
  try {
    await fetch("/api/logs/store", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ formType: formName, fields }),
    });
  } catch (e) {
    console.warn("Failed to store log", e);
  }
}

function attachFormHandlers() {
  document
    .querySelectorAll("form[data-log-to-discord='true']")
    .forEach((form) => {
      form.addEventListener("submit", async (e) => {
        e.preventDefault();

        if (!currentUser) {
          alert("Please login with Discord first.");
          return;
        }

        const webhook = form.dataset.webhook;
        if (!webhook || webhook.startsWith("YOUR_")) {
          alert("Webhook not configured for this form.");
          return;
        }

        const formName = form.dataset.formName || "Portal Submission";

        const fd = new FormData(form);

        // ✅ multi-select fix
        const rawEntries = Array.from(fd.entries());
        const fields = collapseMultiValueFields(rawEntries);

        const statusId = form.dataset.statusTarget;
        const statusEl = statusId ? document.getElementById(statusId) : null;

        if (statusEl) statusEl.textContent = "Sending to Discord...";

        const submitBtn = form.querySelector("button[type='submit']");
        if (submitBtn) submitBtn.disabled = true;

        try {
          await sendToDiscord(formName, fields, currentUser, webhook);
          if (statusEl) statusEl.textContent = "Logged to Discord ✅";
          form.reset();
        } catch (err) {
          console.error(err);
          if (statusEl) statusEl.textContent = "Error sending to Discord ❌";
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      });
    });
}

/* =========================================================
   NAV + TABS
   ========================================================= */

function showPage(key) {
  document.querySelectorAll(".page").forEach((p) => p.classList.add("hidden"));
  const target = document.getElementById("page-" + key);
  if (target) target.classList.remove("hidden");

  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.page === key);
  });

  if (key === "admin") loadAdminDashboard();
}

function attachNavHandlers() {
  document.querySelectorAll(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const page = btn.dataset.page;
      if (page) showPage(page);
    });
  });

  document.querySelectorAll("[data-page-jump]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const page = btn.dataset.pageJump;
      const tab = btn.dataset.tabJump;
      if (page) showPage(page);
      if (tab) activateTab(tab);
    });
  });
}

function activateTab(tabKey) {
  document.querySelectorAll(".tab-button").forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabKey);
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("hidden", panel.id !== "tab-" + tabKey);
  });
}

function attachTabHandlers() {
  document.querySelectorAll(".tab-button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      if (tab) activateTab(tab);
    });
  });
}

/* =========================================================
   ADMIN / COMMAND DASHBOARD
   FIXED to match server.js:
     /api/admin/logs/summary -> { ok, rows }
     /api/admin/logs/user/:id -> { ok, logs } with fieldsJson
   ========================================================= */

function buildUsersFromSummaryRows(rows) {
  const byUser = new Map();

  for (const r of rows || []) {
    const userId = r.userid || r.userId;
    const username = r.username || "";
    const displayName = r.displayname || r.displayName || "";
    const formType = r.formtype || r.formType || "Unknown";
    const count = Number(r.count || 0);

    if (!userId) continue;

    if (!byUser.has(userId)) {
      byUser.set(userId, {
        userId,
        username,
        displayName,
        total: 0,
        byType: {},
      });
    }

    const u = byUser.get(userId);
    if (!u.username && username) u.username = username;
    if (!u.displayName && displayName) u.displayName = displayName;

    u.byType[formType] = (u.byType[formType] || 0) + count;
    u.total += count;
  }

  return Array.from(byUser.values()).sort((a, b) => {
    const an = (a.displayName || a.username || "").toLowerCase();
    const bn = (b.displayName || b.username || "").toLowerCase();
    return an.localeCompare(bn);
  });
}

async function loadAdminDashboard() {
  const content = document.getElementById("adminContent");
  const errBox = document.getElementById("adminError");
  const tbody = document.getElementById("adminSummaryBody");
  const resetStatus = document.getElementById("adminResetStatus");

  if (!content || !errBox || !tbody) return;

  content.classList.add("hidden");
  errBox.classList.add("hidden");
  tbody.innerHTML = "";
  if (resetStatus) resetStatus.textContent = "";

  try {
    const res = await fetch("/api/admin/logs/summary", {
      credentials: "include",
    });

    if (res.status === 401 || res.status === 403) {
      errBox.classList.remove("hidden");
      return;
    }

    const data = await res.json();
    if (!data.ok) {
      errBox.classList.remove("hidden");
      return;
    }

    // ✅ server returns rows
    const users = buildUsersFromSummaryRows(data.rows || []);
    window.__adminSummaryUsers = users;

    if (!users.length) {
      tbody.innerHTML = `<tr><td colspan="3">No logs recorded yet.</td></tr>`;
    } else {
      users.forEach((u) => {
        const byTypeParts = Object.entries(u.byType || {}).map(
          ([type, count]) => `${type}: ${count}`
        );

        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${u.displayName || u.username || "(Unknown)"}</td>
          <td>ID: ${u.userId}</td>
          <td>${u.total} ${byTypeParts.length ? " • " + byTypeParts.join(" • ") : ""}</td>
        `;
        tbody.appendChild(tr);
      });
    }

    // Populate dropdown for user view
    updateAdminUserSelect();

    content.classList.remove("hidden");
  } catch (e) {
    console.error("admin summary error", e);
    errBox.classList.remove("hidden");
  }
}

function updateAdminUserSelect() {
  const select = document.getElementById("adminUserSelect");
  if (!select) return;

  const users = window.__adminSummaryUsers || [];
  const prev = select.value;

  select.innerHTML = `<option value="">-- Select a user --</option>`;

  users.forEach((u) => {
    const opt = document.createElement("option");
    opt.value = u.userId;
    opt.textContent = `${u.displayName || u.username || "Unknown"} (${u.userId})`;
    select.appendChild(opt);
  });

  if (prev && users.some((u) => u.userId === prev)) select.value = prev;

  if (!select.dataset.bound) {
    select.addEventListener("change", () => {
      const val = select.value;
      if (val) loadAdminUserView(val);
      else {
        const statsEl = document.getElementById("adminUserStats");
        const body = document.getElementById("adminUserLogsBody");
        if (statsEl) statsEl.textContent = "";
        if (body) body.innerHTML = "";
      }
    });
    select.dataset.bound = "1";
  }
}

async function loadAdminUserView(userId) {
  const statsEl = document.getElementById("adminUserStats");
  const body = document.getElementById("adminUserLogsBody");
  if (!body) return;

  body.innerHTML = "";
  if (statsEl) statsEl.textContent = "Loading logs...";

  try {
    const res = await fetch(`/api/admin/logs/user/${encodeURIComponent(userId)}`, {
      credentials: "include",
    });
    const data = await res.json();

    if (!res.ok || !data.ok) {
      if (statsEl) statsEl.textContent = "Failed to load logs for this user.";
      return;
    }

    const logs = data.logs || [];

    const users = window.__adminSummaryUsers || [];
    const u = users.find((x) => x.userId === userId);

    if (statsEl) {
      const byType = u?.byType ? Object.entries(u.byType).map(([t, c]) => `${t}: ${c}`) : [];
      statsEl.textContent = u
        ? `Total logs: ${u.total}${byType.length ? " • " + byType.join(" • ") : ""}`
        : "User stats unavailable.";
    }

    if (!logs.length) {
      body.innerHTML = `<tr><td colspan="3">No logs found for this user.</td></tr>`;
      return;
    }

    logs.forEach((log) => {
      const created = log.createdat || log.createdAt ? new Date(log.createdat || log.createdAt) : null;
      const createdText = created ? created.toLocaleString() : "";

      // ✅ server uses fieldsJson
      const fields = log.fieldsjson || log.fieldsJson || [];
      const detailsPieces = [];

      if (Array.isArray(fields)) {
        fields.forEach((pair) => {
          if (!Array.isArray(pair) || pair.length < 2) return;
          const label = String(pair[0] || "").trim();
          const val = String(pair[1] || "").trim();
          if (!label) return;
          detailsPieces.push(`${label}: ${val}`);
        });
      }

      const details = detailsPieces.join("\n");

      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${createdText}</td>
        <td>${log.formtype || log.formType || ""}</td>
        <td><pre style="white-space:pre-wrap;margin:0;">${details}</pre></td>
      `;
      body.appendChild(tr);
    });
  } catch (e) {
    console.error("loadAdminUserView error", e);
    if (statsEl) statsEl.textContent = "Error loading logs for this user.";
  }
}

async function resetAdminStats() {
  const resetStatus = document.getElementById("adminResetStatus");
  if (resetStatus) resetStatus.textContent = "Resetting stats...";

  try {
    const res = await fetch("/api/admin/logs/reset", {
      method: "POST",
      credentials: "include",
    });

    let data = {};
    try {
      data = await res.json();
    } catch {}

    if (!res.ok || !data.ok) {
      if (resetStatus)
        resetStatus.textContent = (data && data.error) || "You are not allowed to reset stats.";
      return;
    }

    if (resetStatus) resetStatus.textContent = "Stats reset ✅";
    await loadAdminDashboard();
  } catch (e) {
    console.error("reset error", e);
    if (resetStatus) resetStatus.textContent = "Error resetting stats.";
  }
}

/* =========================================================
   BOOT
   ========================================================= */

document.addEventListener("DOMContentLoaded", () => {
  document.getElementById("discordLoginButton")?.addEventListener("click", () => {
    window.location.href = "/api/login";
  });

  const resetBtn = document.getElementById("resetStatsButton");
  if (resetBtn) {
    resetBtn.addEventListener("click", () => {
      if (confirm("Are you sure you want to reset all stored stats? This cannot be undone.")) {
        resetAdminStats();
      }
    });
  }

  attachFormHandlers();
  attachNavHandlers();
  attachTabHandlers();

  showPage("home");
  activateTab("patrol");

  checkAuth();
});
