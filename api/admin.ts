import type { VercelRequest, VercelResponse } from "@vercel/node";
import { timingSafeEqual } from "node:crypto";
import { config } from "../lib/config.js";
import { importLeads } from "../lib/leads.js";
import { makeBot } from "../lib/runtime.js";
import { normalizePhone } from "../lib/store.js";
import { isDryRun } from "../lib/twilio.js";

function passwordOk(given: unknown): boolean {
  const want = config.adminPassword;
  if (!want || typeof given !== "string") return false;
  const a = Buffer.from(given);
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** GET: the control page. POST: its actions, each needing ADMIN_PASSWORD. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "GET") return res.status(200).setHeader("Content-Type", "text/html; charset=utf-8").send(PAGE);
  if (req.method !== "POST") return res.status(405).send("GET or POST");

  const input = (typeof req.body === "string" ? JSON.parse(req.body) : req.body) ?? {};
  if (!passwordOk(input.password)) {
    await new Promise((r) => setTimeout(r, 1000));
    return res.status(403).json({ error: "Wrong password" });
  }

  const { bot, store } = makeBot();
  try {
    switch (input.action) {
      case "status": {
        const leads = await store.allLeads();
        return res.json({
          leads,
          drafts: await store.pendingDrafts(),
          paused: await store.paused(),
          auto: await store.autoSend(),
          dryRun: isDryRun(),
        });
      }
      case "conversation": {
        const phone = normalizePhone(input.phone);
        return res.json({ turns: phone ? await store.history(phone) : [] });
      }
      case "import":
        return res.json(await importLeads(store, String(input.csv ?? "")));
      case "exclude":
      case "requeue": {
        const lead = await store.getLead(normalizePhone(input.phone) ?? "");
        if (!lead) return res.status(404).json({ error: "No such lead" });
        if (input.action === "exclude") lead.status = "excluded";
        else if (lead.status === "excluded" && !lead.firstTextAt) lead.status = "queued";
        await store.saveLead(lead);
        return res.json({ ok: true, status: lead.status });
      }
      case "send-draft":
      case "skip-draft": {
        const draft = await store.takeDraft(Number(input.id));
        if (!draft) return res.status(404).json({ error: "That draft is gone (already used or replaced)" });
        if (input.action === "skip-draft") return res.json({ ok: true });
        const lead = await store.getLead(draft.phone);
        if (!lead) return res.status(404).json({ error: "Lead not found" });
        const body = typeof input.body === "string" && input.body.trim() ? input.body.trim() : draft.body;
        const sent = await bot.textLead(lead, body, body === draft.body ? "bot" : "owner");
        await store.saveLead(lead);
        return res.json({ ok: sent });
      }
      case "pause":
        await store.setPaused(Boolean(input.value));
        return res.json({ ok: true });
      case "auto":
        await store.setAutoSend(Boolean(input.value));
        return res.json({ ok: true });
      default:
        return res.status(400).json({ error: "Unknown action" });
    }
  } catch (err: any) {
    console.log(JSON.stringify({ event: "admin_failed", action: input.action, error: err?.message }));
    return res.status(500).json({ error: err?.message });
  }
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Text bot</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--card:#fff;--accent:#0f766e}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--line:#44403c;--card:#292524;--accent:#2dd4bf}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.45 system-ui,sans-serif;padding:16px;max-width:900px;margin:auto}
h1{font-size:20px;margin:0 0 12px}h2{font-size:16px;margin:24px 0 8px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px;margin:8px 0}
button{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:8px 12px;font:inherit;cursor:pointer;margin:2px}
button.alt{background:transparent;color:var(--fg);border:1px solid var(--line)}
input,textarea{width:100%;font:inherit;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
textarea{min-height:90px}.muted{color:var(--muted);font-size:13px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:6px 4px;border-bottom:1px solid var(--line)}
.turn{margin:4px 0}.in{color:var(--fg)}.out{color:var(--accent)}#err{color:#dc2626}
</style></head><body>
<h1>Text bot</h1>
<div id="login" class="card"><div class="row"><input id="pw" type="password" placeholder="Admin password"><button onclick="login()">Open</button></div></div>
<div id="app" hidden>
<div id="err"></div>
<div class="card" id="mode"></div>
<h2>Drafts waiting for you</h2><div id="drafts"></div>
<h2>Leads</h2><div class="card"><table id="leads"></table></div>
<h2>Add leads</h2><div class="card"><p class="muted">Paste a CSV with a header row: phone, name (or first name, last name), notes, exclude. Numbers already on the list are skipped.</p>
<textarea id="csv" placeholder="name,phone,notes&#10;Jane Doe,602-555-1234,Front and back windows, paid $180 last spring"></textarea><button onclick="importCsv()">Import</button> <span id="importResult" class="muted"></span></div>
<div id="convo" class="card" hidden></div>
</div>
<script>
let pw="";try{pw=sessionStorage.getItem("pw")||""}catch(e){}
async function call(action,extra={}){const r=await fetch(location.pathname,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:pw,action,...extra})});const j=await r.json();if(!r.ok)throw new Error(j.error||r.status);return j}
function esc(s){return String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
async function login(){pw=document.getElementById("pw").value;try{await load();try{sessionStorage.setItem("pw",pw)}catch(e){}}catch(e){alertErr(e)}}
function alertErr(e){document.getElementById("err").textContent=e.message}
async function load(){const s=await call("status");document.getElementById("login").hidden=true;document.getElementById("app").hidden=false;
document.getElementById("mode").innerHTML='<div class="row"><b>'+(s.paused?"Paused":s.auto?"Automatic":"Review mode")+'</b>'+(s.dryRun?' <span class="muted">(dry run: nothing reaches leads)</span>':'')+
'<button class="alt" onclick="act(\\'pause\\',{value:'+!s.paused+'})">'+(s.paused?"Resume":"Pause")+'</button><button class="alt" onclick="act(\\'auto\\',{value:'+!s.auto+'})">'+(s.auto?"Switch to review":"Switch to automatic")+'</button></div>';
document.getElementById("drafts").innerHTML=s.drafts.length?s.drafts.map(d=>'<div class="card"><div class="muted">#'+d.id+' to '+esc(d.phone)+'</div><textarea id="d'+d.id+'">'+esc(d.body)+'</textarea><button onclick="sendDraft('+d.id+')">Send</button><button class="alt" onclick="act(\\'skip-draft\\',{id:'+d.id+'})">Skip</button></div>').join(""):'<p class="muted">None.</p>';
document.getElementById("leads").innerHTML='<tr><th>Name</th><th>Phone</th><th>Status</th><th></th></tr>'+s.leads.map(l=>'<tr><td>'+esc(l.name)+'</td><td>'+esc(l.phone)+'</td><td>'+esc(l.status)+(l.requestedTime?' ('+esc(l.requestedTime)+')':'')+(l.reason?'<div class="muted">'+esc(l.reason)+'</div>':'')+'</td><td><button class="alt" onclick="convo(\\''+l.phone+'\\')">Texts</button>'+(l.status==="queued"?'<button class="alt" onclick="act(\\'exclude\\',{phone:\\''+l.phone+'\\'})">Exclude</button>':'')+'</td></tr>').join("")}
async function act(a,x){try{await call(a,x);await load()}catch(e){alertErr(e)}}
async function sendDraft(id){await act("send-draft",{id,body:document.getElementById("d"+id).value})}
async function convo(phone){const c=await call("conversation",{phone});const el=document.getElementById("convo");el.hidden=false;el.innerHTML='<b>'+esc(phone)+'</b>'+c.turns.map(t=>'<div class="turn '+t.dir+'">'+(t.dir==="in"?"Them":"Us")+': '+esc(t.body)+' <span class="muted">'+new Date(t.at).toLocaleString()+'</span></div>').join("");el.scrollIntoView()}
async function importCsv(){try{const r=await call("import",{csv:document.getElementById("csv").value});document.getElementById("importResult").textContent="Added "+r.added+", already on list "+r.alreadyOnList+", excluded "+r.excluded+", opted out "+r.optedOut+(r.badPhone.length?", bad numbers: "+r.badPhone.join(", "):"");await load()}catch(e){alertErr(e)}}
if(pw)load().catch(()=>{});
</script></body></html>`;
