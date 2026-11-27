const fs = require("fs");
const { Pool } = require("pg");
const { sendWelcome } = require("./mail");

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

loadEnv("/etc/piaroute-api.env");

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const pending = await pool.query(
    `SELECT id, email
     FROM applications
     WHERE welcome_sent_at IS NULL
     ORDER BY created_at`,
  );

  let sent = 0;
  for (const row of pending.rows) {
    const ok = await sendWelcome(row.email);
    if (!ok) {
      console.error("smtp ayari yok");
      process.exitCode = 1;
      break;
    }
    await pool.query(
      `UPDATE applications SET welcome_sent_at = NOW() WHERE id = $1`,
      [row.id],
    );
    sent += 1;
  }

  console.log("gonderilen: " + sent);
  await pool.end();
}

main().catch((err) => {
  console.error("mail failed", err && err.responseCode ? err.responseCode : "smtp");
  process.exit(1);
});
