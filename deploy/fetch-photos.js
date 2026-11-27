const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const dir = "/var/lib/piaroute/photos";

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
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

function extFrom(url, type) {
  const clean = url.split("?")[0].toLowerCase();
  if (clean.endsWith(".png")) return ".png";
  if (clean.endsWith(".webp")) return ".webp";
  if (clean.endsWith(".jpeg") || clean.endsWith(".jpg")) return ".jpg";
  if (type && type.includes("png")) return ".png";
  if (type && type.includes("webp")) return ".webp";
  return ".jpg";
}

async function main() {
  loadEnv("/etc/piaroute-api.env");
  fs.mkdirSync(dir, { recursive: true });
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const rows = await pool.query(
    `SELECT id, photo_path
     FROM reports
     WHERE photo_path LIKE 'https://%'`,
  );
  let saved = 0;
  let failed = 0;
  for (const row of rows.rows) {
    try {
      const response = await fetch(row.photo_path, {
        redirect: "follow",
        signal: AbortSignal.timeout(20000),
      });
      if (!response.ok) throw new Error(String(response.status));
      const type = response.headers.get("content-type") || "";
      const ext = extFrom(row.photo_path, type);
      const name = row.id + ext;
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length < 32) throw new Error("empty");
      fs.writeFileSync(path.join(dir, name), bytes);
      await pool.query(`UPDATE reports SET photo_path = $1 WHERE id = $2`, [
        name,
        row.id,
      ]);
      saved += 1;
    } catch (_) {
      failed += 1;
    }
  }
  console.log("inen=" + saved + " kalan=" + failed);
  await pool.end();
}

main().catch((err) => {
  console.error("photo failed", err && err.code ? err.code : "net");
  process.exit(1);
});
