import { appendFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const home = join(homedir(), "AppData", "Local", "Piaroute");
const indexPath = join(home, "model-index.jsonl");
const tokenPath = join(home, "erasure-token.txt");
const logPath = join(home, "purge-log.txt");
const modelRoot = process.env.PIAROUTE_MODEL_DIR || join(homedir(), "ai-model");
const api = process.env.PIAROUTE_ERASURE_URL || "https://www.piaroute.com/api/ops/erasures";
const uuidRe = /^[0-9a-f-]{36}$/i;

function log(line) {
  mkdirSync(home, { recursive: true });
  appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
  console.log(line);
}

function readToken() {
  const fromEnv = String(process.env.ERASURE_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  try {
    return readFileSync(tokenPath, "utf8").trim();
  } catch {
    return "";
  }
}

function readIndex() {
  try {
    return readFileSync(indexPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((row) => row && typeof row === "object");
  } catch {
    return [];
  }
}

function localReports() {
  const root = join(modelRoot, "incoming_reports");
  let names = [];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const rows = [];
  for (const name of names) {
    if (!uuidRe.test(name)) continue;
    try {
      const report = JSON.parse(readFileSync(join(root, name, "report.json"), "utf8"));
      rows.push({
        modelReportId: name,
        sourceReportId: String(report.source_report_id || ""),
        userId: String(report.user_id || ""),
        lat: Number(report.lat),
        lng: Number(report.lng),
        trainingFiles: report.training_files || {},
      });
    } catch {
      rows.push({ modelReportId: name, sourceReportId: "", userId: "", lat: NaN, lng: NaN, trainingFiles: {} });
    }
  }
  return rows;
}

function removeModelCopy(modelReportId, trainingFiles) {
  if (!uuidRe.test(modelReportId)) return 0;
  let removed = 0;
  const folder = join(modelRoot, "incoming_reports", modelReportId);
  rmSync(folder, { recursive: true, force: true });
  removed += 1;
  const names = [
    trainingFiles.image,
    trainingFiles.label,
    `${modelReportId}.jpg`,
    `${modelReportId}.txt`,
  ].filter(Boolean);
  for (const name of names) {
    const base = String(name).replace(/[\\/]/g, "");
    if (base !== name) continue;
    rmSync(join(modelRoot, "resimler", base), { force: true });
    rmSync(join(modelRoot, "etiketler", base), { force: true });
  }
  return removed;
}

async function main() {
  const token = readToken();
  if (token.length < 16) {
    log("Temizlik anahtarı yok. AppData\\Local\\Piaroute\\erasure-token.txt dosyasına sunucudaki ERASURE_TOKEN değerini yazın.");
    process.exitCode = 1;
    return;
  }
  const response = await fetch(api, { headers: { "X-Erasure-Token": token } });
  if (!response.ok) {
    log(`Silinen hesap listesi alınamadı: ${response.status}`);
    process.exitCode = 1;
    return;
  }
  const body = await response.json();
  const erasures = Array.isArray(body?.data?.erasures) ? body.data.erasures : [];
  const userIds = new Set(erasures.map((row) => String(row.userId || "")).filter(Boolean));
  const reportIds = new Set(erasures.flatMap((row) => row.reportIds || []).map(String));
  const places = erasures.flatMap((row) => (Array.isArray(row.places) ? row.places : []));
  const nearPlace = (copy) =>
    Number.isFinite(copy.lat) &&
    Number.isFinite(copy.lng) &&
    places.some(
      (place) =>
        Math.abs(Number(place.lat) - copy.lat) < 0.00003 &&
        Math.abs(Number(place.lng) - copy.lng) < 0.00003,
    );
  const index = readIndex();
  const copies = localReports();
  const modelIds = new Set();
  for (const row of index) {
    if (userIds.has(String(row.userId || "")) || reportIds.has(String(row.sourceReportId || ""))) {
      if (row.modelReportId) modelIds.add(String(row.modelReportId));
    }
  }
  let matchedByPlace = 0;
  for (const copy of copies) {
    const identified = Boolean(copy.userId || copy.sourceReportId);
    if (userIds.has(copy.userId) || reportIds.has(copy.sourceReportId)) {
      modelIds.add(copy.modelReportId);
    } else if (!identified && nearPlace(copy)) {
      modelIds.add(copy.modelReportId);
      matchedByPlace += 1;
    }
  }
  const trainingById = new Map(copies.map((copy) => [copy.modelReportId, copy.trainingFiles]));
  let removed = 0;
  for (const modelReportId of modelIds) {
    removed += removeModelCopy(modelReportId, trainingById.get(modelReportId) || {});
  }
  const kept = index.filter(
    (row) => !userIds.has(String(row.userId || "")) && !reportIds.has(String(row.sourceReportId || "")),
  );
  if (kept.length !== index.length) {
    writeFileSync(indexPath, kept.map((row) => JSON.stringify(row)).join("\n") + (kept.length ? "\n" : ""));
  }
  const unindexed = copies.filter(
    (copy) => !copy.userId && !copy.sourceReportId && !modelIds.has(copy.modelReportId),
  ).length;
  if (erasures.length) {
    const done = await fetch(`${api}/done`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Erasure-Token": token },
      body: JSON.stringify({ ids: erasures.map((row) => row.id) }),
    });
    if (!done.ok) {
      log(`Silinen hesaplar işaretlenemedi: ${done.status}`);
      process.exitCode = 1;
      return;
    }
  }
  log(`Kontrol edilen silme kaydı: ${erasures.length}. Silinen yerel kopya: ${removed}. Konumla eşleşen eski klasör: ${matchedByPlace}. Eşleşmeyen eski klasör: ${unindexed}.`);
}

main().catch((error) => {
  log(error instanceof Error ? error.message : "Temizlik başarısız");
  process.exitCode = 1;
});
