const { createHash, timingSafeEqual } = require("crypto");

function decisionPatch(decision) {
  if (decision === "approved") return { reject: false, train: true };
  if (decision === "rejected") return { reject: true, train: false };
  return null;
}

function cookieValue(secret) {
  const key = String(secret || "");
  if (key.length < 16) return "";
  return createHash("sha256").update("piaroute-review:" + key).digest("hex");
}

function sameText(got, expected) {
  const a = String(got || "");
  const b = String(expected || "");
  if (b.length < 16 || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function reviewHtml() {
  return `<!doctype html>
<html lang="tr">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tespit kontrolü</title>
  <style>
    :root { color-scheme: light; }
    body { margin: 0; font-family: sans-serif; background: #eef0f8; color: #21172c; }
    main { max-width: 560px; margin: 0 auto; padding: 20px 14px 40px; }
    h1 { font-size: 22px; margin: 0 0 6px; }
    p.lead { margin: 0 0 16px; color: #514657; font-size: 14px; line-height: 1.4; }
    .card { background: #fffcff; border-radius: 28px; padding: 16px; margin: 0 0 14px; box-shadow: 0 10px 28px #2b154714; }
    img.photo { width: 100%; height: 240px; object-fit: cover; border-radius: 18px; background: #f4eff7; }
    .kind { font-weight: 800; margin: 12px 0 2px; }
    .meta { color: #817689; font-size: 13px; }
    .row { display: flex; gap: 8px; margin-top: 12px; }
    button { border: 0; border-radius: 16px; padding: 12px 14px; font-weight: 700; font-size: 14px; cursor: pointer; }
    button.ok { background: #6d28d9; color: white; flex: 1; }
    button.no { background: #fff0f1; color: #b42318; flex: 1; }
    button.ghost { background: #f4eff7; color: #6d28d9; }
    input { width: 100%; box-sizing: border-box; border: 1px solid #ece3f2; border-radius: 14px; padding: 12px; font-size: 15px; }
    .err { color: #b42318; font-size: 13px; min-height: 18px; }
    .empty { color: #514657; }
  </style>
</head>
<body>
<main>
  <h1>Tespit kontrolü</h1>
  <p class="lead">Fotoğrafa bak. Onayla dersen fotoğraf model eğitimine alınır. Haritadaki pin, üç sürücü onayı birikmeden onaylı sayılmaz. Bu bilgisayarda model sunucusu açıksa fotoğraf ai-model\\incoming_reports klasörüne de yazılır. Uygun değil dersen bildirim düşer.</p>
  <section id="login" class="card" hidden>
    <p class="meta">Operatör anahtarı</p>
    <input id="token" type="password" autocomplete="current-password">
    <div class="row"><button class="ok" id="enter" type="button">Gir</button></div>
    <p class="err" id="loginErr"></p>
  </section>
  <div id="tools" hidden>
    <div class="row" style="margin-bottom:14px">
      <button class="ghost" id="reload" type="button">Yenile</button>
    </div>
    <div id="list"></div>
  </div>
</main>
<script>
const login = document.getElementById("login");
const tools = document.getElementById("tools");
const list = document.getElementById("list");
const loginErr = document.getElementById("loginErr");
const kindName = { pothole: "Çukur", speed_bump: "Kasis", not_hazard: "Tehlike değil" };
function when(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("tr-TR", { hour: "2-digit", minute: "2-digit", day: "2-digit", month: "2-digit" });
}
function card(item) {
  const box = document.createElement("article");
  box.className = "card";
  const photo = document.createElement("img");
  photo.className = "photo";
  photo.alt = kindName[item.hazardType] || "Tespit";
  photo.src = item.photoUrl;
  const kind = document.createElement("div");
  kind.className = "kind";
  kind.textContent = kindName[item.hazardType] || item.hazardType || "Tespit";
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = when(item.createdAt);
  const row = document.createElement("div");
  row.className = "row";
  const ok = document.createElement("button");
  ok.className = "ok";
  ok.type = "button";
  ok.textContent = "Onayla";
  const no = document.createElement("button");
  no.className = "no";
  no.type = "button";
  no.textContent = "Uygun değil";
  ok.onclick = () => decide(item, "approved", box);
  no.onclick = () => decide(item, "rejected", box);
  row.append(ok, no);
  box.append(photo, kind, meta, row);
  return box;
}
function modelNote(text) {
  let note = document.getElementById("modelNote");
  if (!note) {
    note = document.createElement("p");
    note.id = "modelNote";
    note.className = "meta";
    tools.prepend(note);
  }
  note.textContent = text;
}
async function ensureLocal(item) {
  const id = item && item.id;
  const photoUrl = item && item.photoUrl;
  if (!id || !photoUrl) return "fail";
  try {
    const probe = await fetch("http://127.0.0.1:8000/approved/" + id);
    if (probe.ok) return "exists";
    if (probe.status !== 404) return "down";
    const photo = await fetch(photoUrl);
    if (!photo.ok) return "fail";
    const sent = await fetch("http://127.0.0.1:8000/approved", {
      method: "POST",
      headers: {
        "Content-Type": photo.headers.get("Content-Type") || "image/jpeg",
        "X-Report-Id": id,
        "X-Hazard-Type": item.hazardType || "pothole",
      },
      body: await photo.blob(),
    });
    if (sent.status === 404) return "down";
    return sent.ok ? "saved" : "fail";
  } catch (e) {
    return "down";
  }
}
async function deliverApproved(items, afterDecision) {
  const pending = items.filter((item) => item && item.photoUrl);
  if (!pending.length) return;
  let saved = 0;
  let failed = 0;
  for (const item of pending) {
    const state = await ensureLocal(item);
    if (state === "down") {
      modelNote(afterDecision
        ? "Karar kaydedildi. Model sunucusu kapalı: fotoğraf incoming_reports içine yazılamadı. server.py açıkken sayfayı yenile."
        : "Model sunucusu kapalı. server.py açıkken sayfayı yenile; onaylı fotoğraflar incoming_reports içine yazılır.");
      return;
    }
    if (state === "saved" || state === "exists") saved += 1;
    else failed += 1;
  }
  if (failed) modelNote("Bazı fotoğraflar klasöre yazılamadı. Yenile ve tekrar dene.");
  else if (saved) modelNote("Onaylı fotoğraflar ai-model\\\\incoming_reports klasöründe.");
}
async function decide(item, decision, box) {
  const response = await fetch("/api/review/decide", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: item.id, decision }),
  });
  if (response.status === 401) return showLogin();
  if (!response.ok) {
    let note = box.querySelector(".err");
    if (!note) {
      note = document.createElement("p");
      note.className = "err";
      box.append(note);
    }
    note.textContent = "Karar kaydedilemedi. Yenile ve tekrar dene.";
    return;
  }
  if (decision === "approved") await deliverApproved([item], true);
  box.remove();
  if (!list.childElementCount) showEmpty();
}
function showEmpty() {
  list.innerHTML = '<section class="card empty">Bekleyen fotoğraf yok. Telefondan bir tespit yükle, sonra yenile.</section>';
}
function showLogin() {
  login.hidden = false;
  tools.hidden = true;
}
async function load() {
  const response = await fetch("/api/review/queue");
  if (response.status === 401) return showLogin();
  const body = await response.json();
  login.hidden = true;
  tools.hidden = false;
  list.innerHTML = "";
  const items = Array.isArray(body.data) ? body.data : [];
  if (!items.length) return showEmpty();
  for (const item of items) list.append(card(item));
  const training = await fetch("/api/review/training");
  if (training.ok) {
    const packed = await training.json();
    const approved = Array.isArray(packed.data) ? packed.data : [];
    await deliverApproved(approved);
  }
}
document.getElementById("enter").onclick = async () => {
  loginErr.textContent = "";
  const response = await fetch("/api/review/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: document.getElementById("token").value }),
  });
  if (!response.ok) {
    loginErr.textContent = "Anahtar uyuşmadı.";
    return;
  }
  document.getElementById("token").value = "";
  await load();
};
document.getElementById("reload").onclick = () => load();
load();
</script>
</body>
</html>`;
}

async function queue(pool, publicPhoto) {
  const found = await pool.query(
    `SELECT id, hazard_type, status, photo_path, created_at
     FROM reports
     WHERE status = 'unconfirmed'
       AND photo_path IS NOT NULL
       AND photo_path <> ''
     ORDER BY created_at DESC
     LIMIT 40`,
  );
  return found.rows.map((row) => ({
    id: row.id,
    hazardType: row.hazard_type,
    status: row.status,
    photoUrl: publicPhoto(row.photo_path),
    createdAt: row.created_at,
  }));
}

async function training(pool, publicPhoto) {
  const found = await pool.query(
    `SELECT id, hazard_type, photo_path, created_at
     FROM reports
     WHERE train_for_model = TRUE
       AND status <> 'rejected'
       AND photo_path IS NOT NULL
       AND photo_path <> ''
     ORDER BY created_at DESC
     LIMIT 40`,
  );
  return found.rows.map((row) => ({
    id: row.id,
    hazardType: row.hazard_type,
    photoUrl: publicPhoto(row.photo_path),
    createdAt: row.created_at,
  }));
}

async function decide(pool, id, decision) {
  const patch = decisionPatch(decision);
  if (!patch || !/^[0-9a-f-]{36}$/i.test(String(id || ""))) return null;
  const updated = await pool.query(
    `UPDATE reports
     SET train_for_model = $2,
         status = CASE
           WHEN $3 THEN 'rejected'
           WHEN confirmation_count >= 3 THEN 'confirmed'
           ELSE status
         END
     WHERE id = $1
     RETURNING id, status, train_for_model`,
    [id, patch.train, patch.reject],
  );
  return updated.rows[0] || null;
}

async function statuses(pool, ids) {
  const clean = [...new Set(ids.map((id) => String(id || "").trim()))]
    .filter((id) => /^[0-9a-f-]{36}$/i.test(id))
    .slice(0, 40);
  if (!clean.length) return [];
  const found = await pool.query(
    `SELECT id, status, confirmation_count
     FROM reports
     WHERE id = ANY($1::uuid[])`,
    [clean],
  );
  return found.rows.map((row) => ({
    id: row.id,
    status: row.status,
    confirmationCount: row.confirmation_count,
  }));
}

module.exports = {
  decisionPatch,
  cookieValue,
  sameText,
  reviewHtml,
  queue,
  training,
  decide,
  statuses,
};
