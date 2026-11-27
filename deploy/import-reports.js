const fs = require("fs");
const { Pool } = require("pg");

function loadEnv(path) {
  if (!fs.existsSync(path)) return;
  for (const line of fs.readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const cut = trimmed.indexOf("=");
    if (cut < 1) continue;
    const key = trimmed.slice(0, cut);
    let value = trimmed.slice(cut + 1).trim();
    if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value, max) {
  if (typeof value !== "string") return null;
  const clean = value.trim();
  if (!clean) return null;
  return clean.length <= max ? clean : clean.slice(0, max);
}

async function main() {
  loadEnv("/etc/piaroute-api.env");
  const file = process.argv[2];
  if (!file) throw new Error("json yolu gerekli");
  const docs = JSON.parse(fs.readFileSync(file, "utf8"));
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  let inserted = 0;
  for (const doc of docs) {
    const f = doc.fields || {};
    const count = Number.isInteger(f.confirmationCount) ? f.confirmationCount : 0;
    const status = f.status === "confirmed" && count >= 3 ? "confirmed" : "unconfirmed";
    const result = await pool.query(
      `INSERT INTO reports (
         id, created_at, latitude, longitude, status, source, hazard_type,
         user_label, note, photo_path, severity, speed_kmh, sensor_magnitude,
         ai_is_hazard, ai_confidence, ai_suggested_severity, ai_hazard_type,
         ai_summary, confirmation_count, location_source, train_for_model,
         app_version, import_id, account_uid
       ) VALUES (
         gen_random_uuid(), COALESCE($1::timestamptz, NOW()), $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11, $12,
         $13, $14, $15, $16,
         $17, $18, $19, $20,
         $21, $22, $23
       )
       ON CONFLICT (import_id) WHERE import_id IS NOT NULL DO NOTHING`,
      [
        text(f.timestamp, 40),
        num(f.latitude),
        num(f.longitude),
        status,
        text(f.source, 32) || "manual",
        text(f.hazardType, 32) || "pothole",
        text(f.userLabel, 32),
        text(f.note, 500),
        text(f.photoUrl, 2048),
        num(f.severity1to5),
        num(f.speedKmh),
        num(f.sensorMagnitude),
        typeof f.aiIsHazard === "boolean" ? f.aiIsHazard : null,
        num(f.aiConfidence),
        num(f.aiSuggestedSeverity),
        text(f.aiHazardType, 32),
        text(f.aiSummary, 400),
        count,
        text(f.locationSource, 32),
        f.trainForModel !== false,
        text(f.appVersion, 40),
        doc.id,
        text(f.uid, 128),
      ],
    );
    inserted += result.rowCount;
  }
  const count = await pool.query("SELECT COUNT(*)::int AS c FROM reports");
  console.log("eklenen=" + inserted + " toplam=" + count.rows[0].c);
  await pool.end();
}

main().catch((err) => {
  console.error("import failed", err && err.code ? err.code : "db");
  process.exit(1);
});
