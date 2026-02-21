let currentUser = null;

function showLoginOverlay(){document.getElementById("loginOverlay").classList.remove("hidden");}
function hideLoginOverlay(){document.getElementById("loginOverlay").classList.add("hidden");}

// Discord no longer uses discriminators for most accounts.
// This helper prevents showing "#undefined" in the UI and provides a safe handle.
function getUserHandle(user){
  if(!user) return "";
  if(user.discriminator && String(user.discriminator).trim() && String(user.discriminator) !== "0"){
    return user.username + "#" + user.discriminator;
  }
  return user.tag || user.username;
}


function setLoggedInUI(user){
  currentUser = user;
  hideLoginOverlay();
  const label = user.displayName || user.username;
  document.getElementById("sidebarUserName").textContent = label;
  document.getElementById("sidebarUserRank").textContent = getUserHandle(user);
  document.getElementById("topbarUserName").textContent = label;
  document.getElementById("topbarUserRank").textContent = getUserHandle(user);
}

async function checkAuth(){
  try{
    const res = await fetch("/api/me",{credentials:"include"});
    if(!res.ok){showLoginOverlay();return;}
    const data = await res.json();
    if(data.ok && data.user){setLoggedInUI(data.user);} else {showLoginOverlay();}
  }catch(e){console.error(e);showLoginOverlay();}
}

// Format Discord IDs into: <@id> (ServerNickname)
// Works for: "123", "<@123>", "<@!123>" and multiple IDs in one field.
// Runs for any field whose *name/label* suggests it contains a Discord ID.
const __discordMemberCache = new Map();

function extractDiscordIds(raw){
  if(!raw) return [];
  const str = String(raw);
  const matches = str.match(/\d{15,20}/g);
  return matches ? Array.from(new Set(matches)) : [];
}

async function fetchMemberDisplayName(id){
  if(__discordMemberCache.has(id)) return __discordMemberCache.get(id);
  try{
    const res = await fetch(`/api/discord/member/${encodeURIComponent(id)}`, { credentials: "include" });
    const data = await res.json().catch(()=>({}));
    const name = (data && data.ok && data.displayName) ? String(data.displayName) : "";
    __discordMemberCache.set(id, name);
    return name;
  }catch(e){
    __discordMemberCache.set(id, "");
    return "";
  }
}

function looksLikeDiscordIdField(fieldKey){
  const k = String(fieldKey || "").toLowerCase();
  // Common patterns across the portal forms
  // - "... Discord ID" (label text)
  // - "*_discord_id" (name attribute)
  // - "discordId" / "discordid" (camel / inconsistent)
  if(k.includes("discord") && k.includes("id")) return true;
  if(k.includes("discord_id")) return true;
  if(k.includes("discordid")) return true;
  return false;
}

async function formatDiscordIdsInValue(fieldKey, value){
  if(!value) return value;
  if(!looksLikeDiscordIdField(fieldKey)) return value;

  const ids = extractDiscordIds(value);
  if(!ids.length) return value;

  let out = String(value);

  for(const id of ids){
    const nick = await fetchMemberDisplayName(id);
    const replacement = nick ? `<@${id}> (${nick})` : `<@${id}>`;

    // Replace bare IDs and mention forms
    out = out.replace(new RegExp(`\\b${id}\\b`, "g"), replacement);
    out = out.replace(new RegExp(`<@!?${id}>`, "g"), replacement);
  }

  return out;
}


async function sendToDiscord(formName, fields, user, webhook){
  const blocks = await Promise.all(fields.map(async ([k,v])=>{
    const formatted = await formatDiscordIdsInValue(k, v || "");
    const val = (formatted || "").trim() || "*n/a*";
    return `**${k}:**\n${val}`;
  }));

  const description = ["Georgia State Roleplay. Cuz We Can.","",...blocks].join("\n\n");
  // Avoid double-bracketing when displayName already includes brackets like "[T-411] Quinoa"
  const dn = (user.displayName || "").trim();
  const showDn = dn && dn !== user.username;
  const submitNick = showDn ? (dn.startsWith("[") && dn.endsWith("]") ? ` ${dn}` : ` [${dn}]`) : "";
  const footerText = `Submitted by ${getUserHandle(user)}${submitNick} | ID: ${user.id}`;

  const payload = {
    username:"Portal Logs",
    embeds:[{
      title:formName || "Portal Submission",
      description,
      color:0xf97316,
      footer:{text:footerText},
      timestamp:new Date().toISOString()
    }]
  };

  const res = await fetch(webhook,{
    method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify(payload)
  });
  if(!res.ok) throw new Error("Webhook returned "+res.status);

  // store in backend for dashboard
  try{
    await fetch("/api/logs/store",{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      credentials:"include",
      body:JSON.stringify({formType:formName,fields})
    });
  }catch(e){console.warn("Failed to store log",e);}
}

function attachFormHandlers(){
  document.querySelectorAll("form[data-log-to-discord='true']").forEach(form=>{
    form.addEventListener("submit", async (e)=>{
      e.preventDefault();
      if(!currentUser){alert("Please login with Discord first.");return;}

      const webhook = form.dataset.webhook;
      if(!webhook || webhook.startsWith("YOUR_")){
        alert("Webhook not configured for this form.");return;
      }
      const formName = form.dataset.formName || "Portal Submission";
      const fd = new FormData(form);
      const fields = Array.from(fd.entries());

      const statusId = form.dataset.statusTarget;
      const statusEl = statusId ? document.getElementById(statusId) : null;
      if(statusEl) statusEl.textContent = "Sending to Discord...";

      const submitBtn = form.querySelector("button[type='submit']");
      if(submitBtn) submitBtn.disabled = true;

      try{
        await sendToDiscord(formName, fields, currentUser, webhook);
        if(statusEl) statusEl.textContent = "Logged to Discord ✅";
        form.reset();
      }catch(err){
        console.error(err);
        if(statusEl) statusEl.textContent = "Error sending to Discord ❌";
      }finally{
        if(submitBtn) submitBtn.disabled = false;
      }
    });
  });
}

// NAV + TABS
function showPage(key){
  document.querySelectorAll(".page").forEach(p=>p.classList.add("hidden"));
  const target = document.getElementById("page-"+key);
  if(target) target.classList.remove("hidden");
  document.querySelectorAll(".nav-item").forEach(btn=>{
    btn.classList.toggle("active", btn.dataset.page===key);
  });
  if(key==="admin") loadAdminDashboard();
}

function attachNavHandlers(){
  document.querySelectorAll(".nav-item").forEach(btn=>{
    btn.addEventListener("click",()=>{
      const page = btn.dataset.page;
      if(page) showPage(page);
    });
  });
  document.querySelectorAll("[data-page-jump]").forEach(btn=>{
    btn.addEventListener("click",()=>{
      const page = btn.dataset.pageJump;
      const tab = btn.dataset.tabJump;
      if(page) showPage(page);
      if(tab) activateTab(tab);
    });
  });
}

function activateTab(tabKey){
  document.querySelectorAll(".tab-button").forEach(btn=>{
    btn.classList.toggle("active", btn.dataset.tab===tabKey);
  });
  document.querySelectorAll(".tab-panel").forEach(panel=>{
    panel.classList.toggle("hidden", panel.id !== "tab-"+tabKey);
  });
}

function attachTabHandlers(){
  document.querySelectorAll(".tab-button").forEach(btn=>{
    btn.addEventListener("click",()=>{
      const tab = btn.dataset.tab;
      if(tab) activateTab(tab);
    });
  });
}

// Admin dashboard
async function loadAdminDashboard(){
  const content = document.getElementById("adminContent");
  const errBox = document.getElementById("adminError");
  const tbody = document.getElementById("adminSummaryBody");
  const resetStatus = document.getElementById("adminResetStatus");
  if(!content || !errBox || !tbody) return;

  content.classList.add("hidden");
  errBox.classList.add("hidden");
  tbody.innerHTML = "";
  if(resetStatus) resetStatus.textContent = "";

  try{
    const res = await fetch("/api/admin/logs/summary",{credentials:"include"});
    if(res.status===401 || res.status===403){
      errBox.classList.remove("hidden");
      return;
    }
    const data = await res.json();
    if(!data.ok){errBox.classList.remove("hidden");return;}

    const users = data.users || [];
    window.__adminSummaryUsers = users;

    if(!users.length){
      tbody.innerHTML = '<tr><td colspan="3">No logs recorded yet.</td></tr>';
    }else{
      users.forEach(u=>{
        const tr = document.createElement("tr");
        const byTypeParts = [];
        for(const [type,count] of Object.entries(u.byType || {})){
          byTypeParts.push(`${type}: ${count}`);
        }

        const extraParts = [];
        if(u.patrolHours && typeof u.patrolHours === "object"){
          const h = u.patrolHours.hours || 0;
          const m = u.patrolHours.minutes || 0;
          const hoursStr = `${h}h ${String(m).padStart(2,"0")}m`;
          if(h || m){
            extraParts.push(`Patrol hours: ${hoursStr}`);
          }
        }
        if(typeof u.onboardingCount === "number" && u.onboardingCount > 0){
          extraParts.push(`Onboardings: ${u.onboardingCount}`);
        }

        const metaLines = [`ID: ${u.userId}`];
        if(extraParts.length){
          metaLines.push(extraParts.join(" • "));
        }

        tr.innerHTML = `
          <td>
            <div><strong>${u.displayName || u.username}</strong></div>
            <div style="font-size:0.78rem;color:#6b7280;">${metaLines.join("<br>")}</div>
          </td>
          <td>${u.total}</td>
          <td>${byTypeParts.join(" • ")}</td>
        `;
        tbody.appendChild(tr);
      });
    }

    // update Command view user dropdown
    if(typeof updateAdminUserSelect === "function"){
      updateAdminUserSelect();
    }

    content.classList.remove("hidden");
  }catch(e){
    console.error("admin summary error",e);
    errBox.classList.remove("hidden");
  }
}


function updateAdminUserSelect(){
  const select = document.getElementById("adminUserSelect");
  if(!select) return;
  const users = window.__adminSummaryUsers || [];
  const prev = select.value;
  select.innerHTML = '<option value="">-- Select a user --</option>';
  const sorted = [...users].sort((a,b)=>{
    const an = (a.displayName || a.username || "").toLowerCase();
    const bn = (b.displayName || b.username || "").toLowerCase();
    if(an<bn) return -1;
    if(an>bn) return 1;
    return 0;
  });
  sorted.forEach(u=>{
    const opt = document.createElement("option");
    opt.value = u.userId;
    opt.textContent = (u.displayName || u.username) + ` (${u.userId})`;
    select.appendChild(opt);
  });
  if(prev && users.some(u=>u.userId===prev)){
    select.value = prev;
  }
  if(!select.dataset.bound){
    select.addEventListener("change", ()=>{
      const val = select.value;
      if(val){
        loadAdminUserView(val);
      }else{
        const statsEl = document.getElementById("adminUserStats");
        const body = document.getElementById("adminUserLogsBody");
        if(statsEl) statsEl.textContent = "";
        if(body) body.innerHTML = "";
      }
    });
    select.dataset.bound = "1";
  }
}

async function loadAdminUserView(userId){
  const statsEl = document.getElementById("adminUserStats");
  const body = document.getElementById("adminUserLogsBody");
  if(!body) return;
  body.innerHTML = "";
  if(statsEl) statsEl.textContent = "Loading logs...";

  try{
    const res = await fetch(`/api/admin/logs/user/${encodeURIComponent(userId)}`,{credentials:"include"});
    const data = await res.json();
    if(!res.ok || !data.ok){
      if(statsEl) statsEl.textContent = "Failed to load logs for this user.";
      return;
    }
    const logs = data.logs || [];
    const users = window.__adminSummaryUsers || [];
    const u = users.find(x=>x.userId===userId);
    const statsBits = [];
    if(u){
      statsBits.push(`Total logs: ${u.total}`);
      const patrolCount = (u.byType && u.byType["Patrol Log"]) || u.patrolCount || 0;
      if(patrolCount){
        const h = (u.patrolHours && u.patrolHours.hours) || 0;
        const m = (u.patrolHours && u.patrolHours.minutes) || 0;
        const hoursStr = `${h}h ${String(m).padStart(2,"0")}m`;
        statsBits.push(`Patrol logs: ${patrolCount} (${hoursStr})`);
      }
      const onboardingCount = (u.byType && u.byType["Onboarding Log"]) || u.onboardingCount || 0;
      if(onboardingCount){
        statsBits.push(`Onboardings: ${onboardingCount}`);
      }
    }
    if(statsEl){
      statsEl.textContent = statsBits.length ? statsBits.join(" • ") : "No stats for this user yet.";
    }

    if(!logs.length){
      body.innerHTML = '<tr><td colspan="4">No logs found for this user.</td></tr>';
      return;
    }

    logs.forEach(log=>{
      const tr = document.createElement("tr");
      const created = log.createdAt ? new Date(log.createdAt) : null;
      const createdText = created ? created.toLocaleString() : "";
      const detailsPieces = [];
      if(Array.isArray(log.fields)){
        log.fields.forEach(pair=>{
          if(!Array.isArray(pair) || pair.length<2) return;
          const label = String(pair[0]||"").trim();
          const val = String(pair[1]||"").trim();
          if(!label) return;
          detailsPieces.push(`<strong>${label}:</strong> ${val}`);
        });
      }
      const details = detailsPieces.join("<br>");

      tr.innerHTML = `
        <td>${createdText}</td>
        <td>${log.formType || ""}</td>
        <td>${details}</td>
        <td><button class="danger-btn small" data-log-id="${log.id}" data-user-id="${log.userId}">Remove</button></td>
      `;
      body.appendChild(tr);
    });

    body.querySelectorAll("button[data-log-id]").forEach(btn=>{
      btn.addEventListener("click", ()=>{
        const logId = btn.getAttribute("data-log-id");
        const uid = btn.getAttribute("data-user-id");
        if(logId && uid){
          deleteAdminLog(logId, uid);
        }
      });
    });
  }catch(e){
    console.error("loadAdminUserView error", e);
    if(statsEl) statsEl.textContent = "Error loading logs for this user.";
  }
}

async function deleteAdminLog(logId,userId){
  if(!logId) return;
  const yes = confirm("Are you sure you want to remove this log? This cannot be undone.");
  if(!yes) return;

  const resetStatus = document.getElementById("adminResetStatus");
  if(resetStatus) resetStatus.textContent = "Removing log...";

  try{
    const res = await fetch(`/api/admin/logs/${encodeURIComponent(logId)}`,{
      method:"DELETE",
      credentials:"include"
    });
    let data = {};
    try{ data = await res.json(); }catch(e){}
    if(!res.ok || !data.ok){
      alert((data && data.error) || "Failed to remove log.");
      if(resetStatus) resetStatus.textContent = "";
      return;
    }
    if(resetStatus) resetStatus.textContent = "Log removed ✅";
    await loadAdminDashboard();
    if(userId){
      await loadAdminUserView(userId);
    }
  }catch(e){
    console.error("deleteAdminLog error", e);
    alert("Error removing log.");
    if(resetStatus) resetStatus.textContent = "";
  }
}


async function resetAdminStats(){
  const resetStatus = document.getElementById("adminResetStatus");
  if(resetStatus) resetStatus.textContent = "Resetting stats...";
  try{
    const res = await fetch("/api/admin/logs/reset",{
      method:"POST",
      credentials:"include"
    });
    let data = {};
    try{ data = await res.json(); }catch(e){}
    if(!res.ok || !data.ok){
      if(resetStatus)
        resetStatus.textContent = (data && data.error) || "You are not allowed to reset stats.";
      return;
    }
    if(resetStatus) resetStatus.textContent = "Stats reset ✅";
    await loadAdminDashboard();
  }catch(e){
    console.error("reset error",e);
    if(resetStatus) resetStatus.textContent = "Error resetting stats.";
  }
}

document.addEventListener("DOMContentLoaded",()=>{
  document.getElementById("discordLoginButton").addEventListener("click",()=>{
    window.location.href = "/api/login";
  });
  const resetBtn = document.getElementById("resetStatsButton");
  if(resetBtn){
    resetBtn.addEventListener("click",()=>{
      if(confirm("Are you sure you want to reset all stored stats? This cannot be undone.")){
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
