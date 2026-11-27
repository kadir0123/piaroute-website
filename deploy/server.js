const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");
const { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } = require("crypto");
const { sendWelcome, sendPasswordReset } = require("./mail");
const { searchAddress, nearestMahalle } = require("./address-search");
const reviewDesk = require("./review-desk");
const { listSavedPlaces, saveSavedPlace, deleteSavedPlace } = require("./saved-places");

const PHOTO_DIR = "/var/lib/piaroute/photos";
const PUBLIC_ORIGIN = "https://www.piaroute.com";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\s'.-]{0,79}$/u;
const MAX_PER_HOUR = Number(process.env.APPLY_RATE_LIMIT_PER_HOUR || 5);
const PORT = Number(process.env.PORT || 3000);

const ALLOWED = new Set(
  (process.env.ALLOWED_ORIGINS || "http://38.210.77.96,https://www.piaroute.com,https://piaroute.com")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
pool.on("error", (error) => {
  console.error("db pool", error && error.code ? error.code : "failed");
});

function allowedOrigin(origin) {
  if (!origin) return true;
  return ALLOWED.has(origin);
}

function cors(origin) {
  const allow = origin && ALLOWED.has(origin) ? origin : [...ALLOWED][0];
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

function send(res, status, data, origin) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    ...cors(origin),
  });
  res.end(body);
}

function clean(s, max) {
  return String(s ?? "")
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, max);
}

function clientIp(req) {
  const xf = (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim();
  return xf || req.socket.remoteAddress || "";
}

const rateHits = new Map();

function rateAllow(key, limit, windowMs) {
  const now = Date.now();
  const prev = (rateHits.get(key) || []).filter((at) => now - at < windowMs);
  if (prev.length >= limit) {
    rateHits.set(key, prev);
    return false;
  }
  prev.push(now);
  rateHits.set(key, prev);
  if (rateHits.size > 8000) {
    for (const [name, times] of rateHits) {
      if (!times.some((at) => now - at < windowMs)) rateHits.delete(name);
    }
  }
  return true;
}

function hashIp(ip) {
  const salt = process.env.IP_HASH_SALT;
  if (!ip || !salt) return null;
  return createHash("sha256").update(ip + salt).digest("hex");
}

function readBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > max) {
        reject(Object.assign(new Error("big"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function publicPhoto(name) {
  if (!name) return null;
  if (name.startsWith("https://")) return name;
  return PUBLIC_ORIGIN + "/photos/" + name;
}

function meters(lat1, lon1, lat2, lon2) {
  const r = 6371000;
  const rad = (n) => (n * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * r * Math.asin(Math.sqrt(a));
}

function photoExt(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50) return ".png";
  if (buf.length > 12 && buf[0] === 0x52 && buf[1] === 0x49) return ".webp";
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) return ".jpg";
  return null;
}

function reportJson(row, extra) {
  return {
    reportId: row.id,
    photoUrl: publicPhoto(row.photo_path),
    latitude: row.latitude,
    longitude: row.longitude,
    mergedIntoExisting: false,
    confirmationApplied: false,
    confirmationCount: row.confirmation_count,
    status: row.status,
    confirmedBy: [],
    severity: row.severity || 3,
    ...extra,
  };
}

function stripJpegMetadata(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return buf;
  const parts = [buf.subarray(0, 2)];
  let i = 2;
  while (i + 3 < buf.length) {
    if (buf[i] !== 0xff) break;
    const marker = buf[i + 1];
    if (marker === 0xda || marker === 0xd9) {
      parts.push(buf.subarray(i));
      return Buffer.concat(parts);
    }
    const length = buf.readUInt16BE(i + 2);
    if (length < 2 || i + 2 + length > buf.length) break;
    if (marker !== 0xe1) parts.push(buf.subarray(i, i + 2 + length));
    i += 2 + length;
  }
  return buf;
}

async function nearbyReport(hazardType, lat, lon) {
  const found = await pool.query(
    `SELECT id, latitude, longitude, status, confirmation_count, photo_path, severity, account_uid
     FROM reports
     WHERE hazard_type = $1
       AND latitude BETWEEN $2 AND $3
       AND longitude BETWEEN $4 AND $5
     LIMIT 40`,
    [hazardType, lat - 0.0004, lat + 0.0004, lon - 0.0004, lon + 0.0004],
  );
  let best = null;
  let bestM = 4;
  for (const row of found.rows) {
    const dist = meters(lat, lon, row.latitude, row.longitude);
    if (dist < bestM) {
      best = row;
      bestM = dist;
    }
  }
  return best;
}

async function savePhoto(id, photoBase64) {
  if (!photoBase64) return null;
  const buf = Buffer.from(photoBase64, "base64");
  if (buf.length < 32 || buf.length > 5 * 1024 * 1024) return null;
  const ext = photoExt(buf);
  if (!ext) return null;
  const stored = ext === ".jpg" ? stripJpegMetadata(buf) : buf;
  const name = id + ext;
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  fs.writeFileSync(path.join(PHOTO_DIR, name), stored);
  return name;
}

function reportWindow(url) {
  const south = Number(url.searchParams.get("south"));
  const north = Number(url.searchParams.get("north"));
  const west = Number(url.searchParams.get("west"));
  const east = Number(url.searchParams.get("east"));
  if (![south, north, west, east].every(Number.isFinite)) {
    return { error: "Alan gerekli." };
  }
  if (!(north > south) || !(east > west)) return { error: "Alan geçersiz." };
  if (north - south > 0.5 || east - west > 0.6) return { error: "Alan çok büyük." };
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit")) || 100));
  const raw = url.searchParams.get("cursor");
  if (!raw) return { south, north, west, east, limit, cursorAt: null, cursorId: null };
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString());
  } catch {
    return { error: "Sayfa geçersiz." };
  }
  const cursorAt = new Date(parsed && parsed.at);
  const cursorId = String((parsed && parsed.id) || "");
  if (Number.isNaN(cursorAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(cursorId)) {
    return { error: "Sayfa geçersiz." };
  }
  return { south, north, west, east, limit, cursorAt, cursorId };
}

async function listReports(url, viewerUid) {
  const window = reportWindow(url);
  if (window.error) return window;
  const found = await pool.query(
    `SELECT id, latitude, longitude, hazard_type, source, status, confirmation_count,
            photo_path, severity, account_uid, created_at, train_for_model,
            ai_hazard_type, ai_summary
     FROM reports
     WHERE status <> 'rejected'
       AND latitude BETWEEN $1 AND $2
       AND longitude BETWEEN $3 AND $4
       AND (
         $5::timestamptz IS NULL
         OR created_at < $5
         OR (created_at = $5 AND id < $6::uuid)
       )
     ORDER BY created_at DESC, id DESC
     LIMIT $7`,
    [window.south, window.north, window.west, window.east, window.cursorAt, window.cursorId, window.limit + 1],
  );
  const page = found.rows.slice(0, window.limit);
  const reports = page.map((row) => reportRow(row, viewerUid));
  const last = page[page.length - 1];
  const next = found.rows.length > window.limit && last
    ? Buffer.from(JSON.stringify({ at: last.created_at.toISOString(), id: last.id })).toString("base64url")
    : null;
  return { reports, next };
}

function reportRow(row, viewerUid) {
  const own = Boolean(viewerUid && row.account_uid && viewerUid === row.account_uid);
  return {
    id: row.id,
    latitude: row.latitude,
    longitude: row.longitude,
    hazardType: row.hazard_type,
    source: row.source,
    status: row.status,
    confirmationCount: row.confirmation_count,
    photoUrl: publicPhoto(row.photo_path),
    severity1to5: row.severity,
    uid: own ? row.account_uid : null,
    timestamp: row.created_at,
    trainForModel: row.train_for_model === true,
    aiHazardType: row.ai_hazard_type,
    aiSummary: row.ai_summary,
  };
}

async function recentReports(url, viewerUid) {
  const capped = new URL(url.href);
  const asked = Number(capped.searchParams.get("limit"));
  capped.searchParams.set("limit", String(Math.min(30, Math.max(1, asked || 30))));
  return listReports(capped, viewerUid);
}

async function applyConfirmation(reportId, uid) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const inserted = await client.query(
      `INSERT INTO report_confirmations (report_id, user_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING
       RETURNING report_id`,
      [reportId, uid],
    );
    if (!inserted.rowCount) {
      await client.query("ROLLBACK");
      return null;
    }
    const updated = await client.query(
      `UPDATE reports
       SET confirmation_count = confirmation_count + 1,
           status = CASE WHEN confirmation_count + 1 >= 3 THEN 'confirmed' ELSE status END
       WHERE id = $1
         AND account_uid IS DISTINCT FROM $2
       RETURNING id, latitude, longitude, status, confirmation_count, photo_path, severity, account_uid`,
      [reportId, uid],
    );
    if (!updated.rowCount) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function createReport(body, sessionUser) {
  const lat = Number(body.latitude);
  const lon = Number(body.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return { error: "Konum geçersiz.", status: 400 };
  }
  const hazardType = String(body.hazardType || "pothole").slice(0, 32);
  const uid = sessionUser || null;
  const near = await nearbyReport(hazardType, lat, lon);
  if (near) {
    let row = near;
    let applied = false;
    if (uid && uid !== near.account_uid) {
      const voted = await applyConfirmation(near.id, uid);
      if (voted) {
        row = voted;
        applied = true;
      }
    }
    if (!row.photo_path && body.photoBase64 && uid && uid === row.account_uid) {
      const name = await savePhoto(row.id, body.photoBase64);
      if (name) {
        await pool.query(`UPDATE reports SET photo_path = $1 WHERE id = $2`, [name, row.id]);
        row.photo_path = name;
      }
    }
    return {
      status: 200,
      data: reportJson(row, {
        mergedIntoExisting: true,
        confirmationApplied: applied,
      }),
    };
  }

  const id = randomUUID();
  const photo = await savePhoto(id, body.photoBase64);
  const severity = Number(body.severity1to5);
  const inserted = await pool.query(
    `INSERT INTO reports (
       id, latitude, longitude, status, source, hazard_type, user_label, note,
       photo_path, severity, speed_kmh, sensor_magnitude, ai_is_hazard,
       ai_confidence, ai_suggested_severity, ai_hazard_type, ai_summary,
       train_for_model, app_version, account_uid
     ) VALUES (
       $1,$2,$3,'unconfirmed',$4,$5,$6,$7,
       $8,$9,$10,$11,$12,
       $13,$14,$15,$16,
       $17,$18,$19
     )
     RETURNING id, latitude, longitude, status, confirmation_count, photo_path, severity, account_uid`,
    [
      id,
      lat,
      lon,
      String(body.source || "manual").slice(0, 32),
      hazardType,
      String(body.userLabel || hazardType).slice(0, 32),
      body.note ? String(body.note).slice(0, 500) : null,
      photo,
      Number.isFinite(severity) ? Math.min(5, Math.max(1, Math.round(severity))) : null,
      Number.isFinite(Number(body.speedKmh)) ? Number(body.speedKmh) : null,
      Number.isFinite(Number(body.sensorMagnitude)) ? Number(body.sensorMagnitude) : null,
      typeof body.aiIsHazard === "boolean" ? body.aiIsHazard : null,
      Number.isFinite(Number(body.aiConfidence)) ? Number(body.aiConfidence) : null,
      Number.isFinite(Number(body.aiSuggestedSeverity)) ? Number(body.aiSuggestedSeverity) : null,
      body.aiHazardType ? String(body.aiHazardType).slice(0, 32) : null,
      body.aiSummary ? String(body.aiSummary).slice(0, 400) : null,
      body.trainForModel === true,
      body.appVersion ? String(body.appVersion).slice(0, 40) : null,
      uid,
    ],
  );
  return { status: 200, data: reportJson(inserted.rows[0], {}) };
}

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 32);
  return `scrypt:${salt.toString("hex")}:${hash.toString("hex")}`;
}

function passwordMatches(password, stored) {
  const parts = String(stored || "").split(":");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const actual = scryptSync(password, salt, 32);
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

async function ensureAuthTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id UUID PRIMARY KEY,
      email TEXT,
      password_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  try {
    await pool.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_uq
      ON app_users (LOWER(email))
      WHERE email IS NOT NULL
    `);
  } catch (error) {
    console.error("user index", error && error.code ? error.code : "failed");
  }
  try {
    await pool.query(`
      DO $$
      DECLARE row record;
      BEGIN
        FOR row IN
          SELECT n.nspname AS schema_name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid
          WHERE c.relname = 'reports'
            AND a.attname = 'firebase_uid'
            AND NOT a.attisdropped
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        LOOP
          EXECUTE format(
            'ALTER TABLE %I.reports RENAME COLUMN firebase_uid TO account_uid',
            row.schema_name
          );
        END LOOP;
        FOR row IN
          SELECT n.nspname AS schema_name
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid
          WHERE c.relname = 'reports'
            AND a.attname = 'firebase_id'
            AND NOT a.attisdropped
            AND n.nspname NOT IN ('pg_catalog', 'information_schema')
        LOOP
          EXECUTE format(
            'ALTER TABLE %I.reports RENAME COLUMN firebase_id TO import_id',
            row.schema_name
          );
        END LOOP;
      END $$;
    `);
    await pool.query(
      `ALTER INDEX IF EXISTS reports_firebase_id_uq RENAME TO reports_import_id_uq`,
    );
    await pool.query(
      `ALTER TABLE reports ADD COLUMN IF NOT EXISTS account_uid TEXT`,
    );
    await pool.query(
      `ALTER TABLE reports ADD COLUMN IF NOT EXISTS train_for_model BOOLEAN NOT NULL DEFAULT FALSE`,
    );
  } catch (error) {
    console.error("column rename", error && error.code ? error.code : "failed");
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_sessions (
      token_hash TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES app_users (id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
    )
  `);
  await pool.query(`
    ALTER TABLE app_sessions
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days'
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS report_confirmations (
      report_id UUID NOT NULL,
      user_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (report_id, user_id)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      token_hash TEXT PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES app_users (id) ON DELETE CASCADE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS content_reports (
      id UUID PRIMARY KEY,
      user_id TEXT,
      target_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS raw_samples (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS account_erasures (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL,
      report_ids TEXT[] NOT NULL DEFAULT '{}',
      photo_names TEXT[] NOT NULL DEFAULT '{}',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      local_purged_at TIMESTAMPTZ,
      places JSONB NOT NULL DEFAULT '[]'
    )
  `);
  await pool.query(
    `ALTER TABLE account_erasures ADD COLUMN IF NOT EXISTS places JSONB NOT NULL DEFAULT '[]'`,
  );
  await pool.query(`
    ALTER TABLE reports ALTER COLUMN train_for_model SET DEFAULT FALSE
  `).catch(() => {});
  await pool.query(`
    CREATE TABLE IF NOT EXISTS training_photos (
      id UUID PRIMARY KEY,
      user_id TEXT NOT NULL,
      photo_path TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS brand_places (
      id TEXT PRIMARY KEY,
      brand_id TEXT NOT NULL,
      category TEXT,
      name TEXT NOT NULL,
      address TEXT,
      city TEXT,
      district TEXT,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      confidence DOUBLE PRECISION NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      last_verified_ms BIGINT,
      source_url TEXT,
      user_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(
    `ALTER TABLE brand_places ADD COLUMN IF NOT EXISTS address_place_id INTEGER`,
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saved_places (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES app_users (id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('home', 'work', 'parked', 'favorite')),
      name TEXT NOT NULL,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL,
      address_place_id INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS saved_places_slot_uq
    ON saved_places (user_id, kind)
    WHERE kind <> 'favorite'
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public_institutions (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      name_folded TEXT NOT NULL,
      category TEXT NOT NULL,
      city_folded TEXT,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS public_institutions_folded_idx
    ON public_institutions (name_folded)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS public_institutions_category_idx
    ON public_institutions (category)
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS chain_branches (
      id INTEGER PRIMARY KEY,
      brand_id TEXT NOT NULL,
      name TEXT NOT NULL,
      name_folded TEXT NOT NULL,
      category TEXT NOT NULL,
      address_place_id INTEGER,
      latitude DOUBLE PRECISION NOT NULL,
      longitude DOUBLE PRECISION NOT NULL
    )
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS chain_branches_folded_idx
    ON chain_branches (name_folded)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS chain_branches_brand_idx
    ON chain_branches (brand_id)
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS chain_branches_category_idx
    ON chain_branches (category)
  `);
}

async function userFromAuth(req) {
  const header = String(req.headers.authorization || "");
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  if (token.length < 20) return null;
  const found = await pool.query(
    `SELECT user_id FROM app_sessions
     WHERE token_hash = $1 AND expires_at > NOW()`,
    [tokenHash(token)],
  );
  return found.rows[0] ? String(found.rows[0].user_id) : null;
}

async function issueSession(userId) {
  const token = randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO app_sessions (token_hash, user_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 days')`,
    [tokenHash(token), userId],
  );
  return token;
}

function authEmail(value) {
  const email = String(value || "").trim().toLowerCase().slice(0, 160);
  if (!EMAIL_RE.test(email)) return "";
  return email;
}

async function registerAccount(body) {
  const email = authEmail(body.email);
  const password = String(body.password || "");
  if (!email || password.length < 6 || password.length > 200) {
    return { error: "E-posta ve en az 6 karakterlik şifre gerekli.", status: 400 };
  }
  const existing = await pool.query(
    `SELECT id FROM app_users WHERE LOWER(email) = $1`,
    [email],
  );
  if (existing.rows[0]) {
    return { error: "Bu e-posta kayıtlı. Giriş yap.", status: 409 };
  }
  const id = randomUUID();
  await pool.query(
    `INSERT INTO app_users (id, email, password_hash) VALUES ($1, $2, $3)`,
    [id, email, hashPassword(password)],
  );
  const token = await issueSession(id);
  return { status: 200, data: { id, email, token } };
}

async function loginAccount(body) {
  const email = authEmail(body.email);
  const password = String(body.password || "");
  if (!email || !password) {
    return { error: "E-posta veya şifre uyuşmadı.", status: 401 };
  }
  const found = await pool.query(
    `SELECT id, email, password_hash FROM app_users WHERE LOWER(email) = $1`,
    [email],
  );
  const row = found.rows[0];
  if (!row || !passwordMatches(password, row.password_hash)) {
    return { error: "E-posta veya şifre uyuşmadı.", status: 401 };
  }
  const token = await issueSession(row.id);
  return { status: 200, data: { id: row.id, email: row.email, token } };
}

async function requestPasswordReset(body) {
  const email = authEmail(body.email);
  if (!email) return { status: 200, data: { ok: true } };
  const found = await pool.query(
    `SELECT id FROM app_users WHERE LOWER(email) = $1`,
    [email],
  );
  const row = found.rows[0];
  if (!row) return { status: 200, data: { ok: true } };
  const token = randomBytes(32).toString("hex");
  await pool.query(
    `DELETE FROM password_resets WHERE user_id = $1 AND used_at IS NULL`,
    [row.id],
  );
  await pool.query(
    `INSERT INTO password_resets (token_hash, user_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 minutes')`,
    [tokenHash(token), row.id],
  );
  const link = PUBLIC_ORIGIN + "/sifre/?token=" + token;
  await sendPasswordReset(email, link);
  return { status: 200, data: { ok: true } };
}

async function resetPassword(body) {
  const token = String(body.token || "").trim();
  const password = String(body.password || "");
  if (!/^[0-9a-f]{64}$/i.test(token)) {
    return { error: "Bağlantı geçersiz veya süresi dolmuş.", status: 400 };
  }
  if (password.length < 6 || password.length > 200) {
    return { error: "Şifre en az 6 karakter olmalı.", status: 400 };
  }
  const found = await pool.query(
    `SELECT user_id FROM password_resets
     WHERE token_hash = $1
       AND used_at IS NULL
       AND expires_at > NOW()`,
    [tokenHash(token)],
  );
  const row = found.rows[0];
  if (!row) return { error: "Bağlantı geçersiz veya süresi dolmuş.", status: 400 };
  await pool.query(
    `UPDATE app_users SET password_hash = $1 WHERE id = $2`,
    [hashPassword(password), row.user_id],
  );
  await pool.query(
    `UPDATE password_resets SET used_at = NOW() WHERE token_hash = $1`,
    [tokenHash(token)],
  );
  await pool.query(`DELETE FROM app_sessions WHERE user_id = $1`, [row.user_id]);
  return { status: 200, data: { ok: true } };
}

async function recordErasure(uid) {
  if (!uid) return;
  const found = await pool.query(
    `SELECT id::text AS id, photo_path, latitude, longitude
     FROM reports WHERE account_uid = $1`,
    [uid],
  );
  const reportIds = found.rows.map((row) => row.id);
  const photoNames = found.rows
    .map((row) => row.photo_path)
    .filter((name) => name && !String(name).startsWith("https://"))
    .map((name) => path.basename(String(name)));
  const places = found.rows.map((row) => ({
    reportId: row.id,
    lat: row.latitude,
    lng: row.longitude,
  }));
  await pool.query(
    `INSERT INTO account_erasures (id, user_id, report_ids, photo_names, places)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [randomUUID(), uid, reportIds, photoNames, JSON.stringify(places)],
  );
}

function unlinkStoredPhoto(name) {
  if (!name || String(name).startsWith("https://")) return;
  try {
    fs.unlinkSync(path.join(PHOTO_DIR, path.basename(String(name))));
  } catch (_) {}
}

async function deleteTrainingPhotos(uid) {
  if (!uid) return 0;
  const found = await pool.query(
    `DELETE FROM training_photos WHERE user_id = $1 RETURNING photo_path`,
    [uid],
  );
  for (const row of found.rows) unlinkStoredPhoto(row.photo_path);
  return found.rowCount || 0;
}

async function saveTrainingPhoto(body, sessionUser) {
  if (!sessionUser) return { error: "Giriş gerekir.", status: 401 };
  const id = randomUUID();
  const name = await savePhoto(id, body.photoBase64);
  if (!name) return { error: "Fotoğraf kaydedilemedi.", status: 400 };
  await pool.query(
    `INSERT INTO training_photos (id, user_id, photo_path) VALUES ($1, $2, $3)`,
    [id, sessionUser, name],
  );
  return { status: 200, data: { photoUrl: publicPhoto(name) } };
}

async function deleteAccount(userId) {
  if (!userId) return { error: "Giriş gerekir.", status: 401 };
  await recordErasure(userId);
  await deleteTrainingPhotos(userId);
  await pool.query(`DELETE FROM saved_places WHERE user_id = $1`, [userId]);
  await pool.query(`UPDATE brand_places SET user_id = NULL WHERE user_id = $1`, [userId]);
  await pool.query(`UPDATE content_reports SET user_id = NULL WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM report_confirmations WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM app_sessions WHERE user_id = $1`, [userId]);
  await pool.query(`DELETE FROM app_users WHERE id = $1`, [userId]);
  return { status: 200, data: { ok: true } };
}

function brandJson(row) {
  return {
    id: row.id,
    brandId: row.brand_id,
    name: row.name,
    address: row.address,
    city: row.city,
    district: row.district,
    lat: row.latitude,
    lng: row.longitude,
    confidence: row.confidence,
    status: row.status,
    source: row.source,
    lastVerifiedMs: row.last_verified_ms,
    sourceUrl: row.source_url,
    uid: row.user_id,
    category: row.category,
    addressPlaceId: row.address_place_id,
  };
}

async function saveBrandPlace(body, sessionUser) {
  const id = String(body.id || "").trim().slice(0, 80);
  const brandId = String(body.brandId || "").trim().slice(0, 80);
  const name = String(body.name || "").trim().slice(0, 160);
  const lat = Number(body.lat ?? body.latitude);
  const lng = Number(body.lng ?? body.longitude);
  if (!id || !brandId || !name || !Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { error: "Yer kaydı geçersiz.", status: 400 };
  }
  if (!sessionUser) return { error: "Giriş gerekir.", status: 401 };
  const uid = sessionUser;
  const addressPlaceId = await nearestMahalle(pool, lat, lng);
  await pool.query(
    `INSERT INTO brand_places (
       id, brand_id, category, name, address, city, district,
       latitude, longitude, confidence, status, source, user_id, address_place_id
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending','userReport',$11,$12)
     ON CONFLICT (id) DO NOTHING`,
    [
      id,
      brandId,
      String(body.category || "").slice(0, 80),
      name,
      body.address ? String(body.address).slice(0, 200) : null,
      body.city ? String(body.city).slice(0, 80) : null,
      body.district ? String(body.district).slice(0, 80) : null,
      lat,
      lng,
      Number(body.confidence) || 20,
      uid,
      addressPlaceId,
    ],
  );
  return { status: 200, data: { ok: true } };
}

async function listBrandPlaces(url, sessionUser) {
  const drafts = url.searchParams.get("drafts") === "1";
  if (drafts) {
    if (!sessionUser) return { status: 200, data: { places: [] } };
    const found = await pool.query(
      `SELECT * FROM brand_places
       WHERE user_id = $1 AND status = 'pending'
       ORDER BY updated_at DESC
       LIMIT 200`,
      [sessionUser],
    );
    return { status: 200, data: { places: found.rows.map(brandJson) } };
  }
  const clauses = ["status = 'open'"];
  const params = [];
  const brandId = String(url.searchParams.get("brandId") || "").slice(0, 80);
  const category = String(url.searchParams.get("category") || "").slice(0, 80);
  if (brandId) {
    params.push(brandId);
    clauses.push(`brand_id = $${params.length}`);
  }
  if (category) {
    params.push(category);
    clauses.push(`category = $${params.length}`);
  }
  const found = await pool.query(
    `SELECT * FROM brand_places
     WHERE ${clauses.join(" AND ")}
     ORDER BY updated_at DESC
     LIMIT 80`,
    params,
  );
  return { status: 200, data: { places: found.rows.map(brandJson) } };
}

async function publishBrandPlace(body, sessionUser) {
  if (!sessionUser) return { error: "Giriş gerekir.", status: 401 };
  const id = String(body.id || "").trim().slice(0, 80);
  if (!id) return { error: "Yer kaydı geçersiz.", status: 400 };
  const updated = await pool.query(
    `UPDATE brand_places
     SET status = 'open',
         last_verified_ms = $3,
         updated_at = NOW()
     WHERE id = $1 AND user_id = $2`,
    [id, sessionUser, Date.now()],
  );
  if (!updated.rowCount) return { error: "Yer kaydı bulunamadı.", status: 404 };
  return { status: 200, data: { ok: true } };
}

async function rejectBrandPlace(body, sessionUser) {
  if (!sessionUser) return { error: "Giriş gerekir.", status: 401 };
  const id = String(body.id || "").trim().slice(0, 80);
  if (!id) return { error: "Yer kaydı geçersiz.", status: 400 };
  await pool.query(
    `DELETE FROM brand_places WHERE id = $1 AND user_id = $2 AND status = 'pending'`,
    [id, sessionUser],
  );
  return { status: 200, data: { ok: true } };
}

async function saveContentReport(body, sessionUser) {
  const reason = String(body.reason || "").trim().slice(0, 500);
  const targetId = String(body.targetId || "").trim().slice(0, 128);
  if (!reason || !targetId) {
    return { error: "Şikâyet nedeni yazın.", status: 400 };
  }
  await pool.query(
    `INSERT INTO content_reports (id, user_id, target_id, reason) VALUES ($1, $2, $3, $4)`,
    [randomUUID(), sessionUser, targetId, reason],
  );
  return { status: 200, data: { ok: true } };
}

async function upsertRawSample(body, sessionUser) {
  const id = String(body.id || "").trim().slice(0, 200);
  if (!id || !body.payload || typeof body.payload !== "object") {
    return { error: "Kayıt geçersiz.", status: 400 };
  }
  if (!sessionUser) return { error: "Giriş gerekir.", status: 401 };
  const saved = await pool.query(
    `INSERT INTO raw_samples (id, user_id, payload)
     VALUES ($1, $2, $3::jsonb)
     ON CONFLICT (id) DO UPDATE
     SET payload = raw_samples.payload || EXCLUDED.payload,
         updated_at = NOW()
     WHERE raw_samples.user_id = EXCLUDED.user_id`,
    [id, sessionUser, JSON.stringify(body.payload)],
  );
  if (!saved.rowCount) return { error: "Kayıt yazılamadı.", status: 403 };
  return { status: 200, data: { ok: true } };
}

async function deleteOwnRawSamples(sessionUser) {
  if (!sessionUser) return { error: "Giriş gerekir.", status: 401 };
  const found = await pool.query(
    `DELETE FROM raw_samples WHERE user_id = $1`,
    [sessionUser],
  );
  const photos = await deleteTrainingPhotos(sessionUser);
  return { status: 200, data: { deleted: (found.rowCount || 0) + photos } };
}

async function confirmReport(body, sessionUser) {
  const id = String(body.reportId || "");
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return { error: "Kayıt yok.", status: 400 };
  }
  if (!sessionUser) return { error: "Onay için giriş gerekir.", status: 401 };
  const voted = await applyConfirmation(id, sessionUser);
  if (voted) {
    return {
      status: 200,
      data: reportJson(voted, { confirmationApplied: true }),
    };
  }
  const existing = await pool.query(
    `SELECT id, latitude, longitude, status, confirmation_count, photo_path, severity, account_uid
     FROM reports WHERE id = $1`,
    [id],
  );
  if (!existing.rows[0]) return { error: "Kayıt yok.", status: 404 };
  return {
    status: 200,
    data: reportJson(existing.rows[0], { confirmationApplied: false }),
  };
}

function reviewSession(req) {
  const expected = reviewDesk.cookieValue(process.env.ERASURE_TOKEN);
  if (!expected) return false;
  const cookie = String(req.headers.cookie || "");
  const part = cookie
    .split(";")
    .map((item) => item.trim())
    .find((item) => item.startsWith("piaroute_review="));
  if (!part) return false;
  return reviewDesk.sameText(part.slice("piaroute_review=".length), expected);
}

function erasureAuthorized(req) {
  const expected = String(process.env.ERASURE_TOKEN || "");
  const got = String(req.headers["x-erasure-token"] || "");
  if (expected.length < 16 || got.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

async function listErasures() {
  const found = await pool.query(
    `SELECT id::text AS id, user_id, report_ids, photo_names, places, created_at
     FROM account_erasures
     WHERE local_purged_at IS NULL
     ORDER BY created_at ASC
     LIMIT 200`,
  );
  return found.rows.map((row) => ({
    id: row.id,
    userId: row.user_id,
    reportIds: row.report_ids || [],
    photoNames: row.photo_names || [],
    places: Array.isArray(row.places) ? row.places : [],
    createdAt: row.created_at,
  }));
}

async function markErasuresPurged(ids) {
  const clean = [...new Set(ids.map((id) => String(id || "").trim()))].filter((id) =>
    /^[0-9a-f-]{36}$/i.test(id),
  );
  if (!clean.length) return 0;
  const updated = await pool.query(
    `UPDATE account_erasures
     SET local_purged_at = NOW()
     WHERE local_purged_at IS NULL
       AND id = ANY($1::uuid[])`,
    [clean],
  );
  return updated.rowCount || 0;
}

async function deleteOwnReports(_body, sessionUser) {
  if (!sessionUser) return { error: "Giriş gerekir.", status: 401 };
  const uid = sessionUser;
  await recordErasure(uid);
  const found = await pool.query(
    `DELETE FROM reports
     WHERE account_uid = $1
       AND status = 'unconfirmed'
       AND confirmation_count = 0
     RETURNING photo_path`,
    [uid],
  );
  for (const row of found.rows) {
    const name = row.photo_path;
    if (!name || String(name).startsWith("https://")) continue;
    try {
      fs.unlinkSync(path.join(PHOTO_DIR, path.basename(String(name))));
    } catch (_) {}
  }
  await pool.query(
    `UPDATE reports SET account_uid = NULL WHERE account_uid = $1`,
    [uid],
  );
  return { status: 200, data: { deleted: found.rows.length, more: false } };
}

async function readJson(req, max) {
  const raw = await readBody(req, max);
  return raw ? JSON.parse(raw) : {};
}

async function handle(req, res) {
  const origin = req.headers.origin || "";
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const path = url.pathname;

  if (path === "/api/auth/register" && req.method === "POST") {
    if (!rateAllow("reg:" + clientIp(req), 5, 60 * 60 * 1000)) {
      send(res, 429, { error: "Çok fazla deneme. Biraz sonra tekrar dene." }, origin);
      return;
    }
    let body;
    try {
      body = await readJson(req, 4096);
    } catch {
      send(res, 400, { error: "Geçersiz istek." }, origin);
      return;
    }
    const result = await registerAccount(body);
    if (result.error) {
      send(res, result.status, { error: result.error }, origin);
      return;
    }
    send(res, 200, { data: result.data }, origin);
    return;
  }

  if (path === "/api/auth/login" && req.method === "POST") {
    if (!rateAllow("login:" + clientIp(req), 8, 10 * 60 * 1000)) {
      send(res, 429, { error: "Çok fazla deneme. Biraz sonra tekrar dene." }, origin);
      return;
    }
    let body;
    try {
      body = await readJson(req, 4096);
    } catch {
      send(res, 400, { error: "Geçersiz istek." }, origin);
      return;
    }
    const result = await loginAccount(body);
    if (result.error) {
      send(res, result.status, { error: result.error }, origin);
      return;
    }
    send(res, 200, { data: result.data }, origin);
    return;
  }

  if (path === "/api/auth/forgot" && req.method === "POST") {
    if (!rateAllow("forgot:" + clientIp(req), 5, 60 * 60 * 1000)) {
      send(res, 429, { error: "Çok fazla deneme. Biraz sonra tekrar dene." }, origin);
      return;
    }
    let body;
    try {
      body = await readJson(req, 4096);
    } catch {
      send(res, 400, { error: "Geçersiz istek." }, origin);
      return;
    }
    const emailKey = authEmail(body.email) || clientIp(req);
    if (!rateAllow("forgot-mail:" + emailKey, 3, 60 * 60 * 1000)) {
      send(res, 200, { ok: true }, origin);
      return;
    }
    try {
      await requestPasswordReset(body);
    } catch (error) {
      console.error("reset mail", error && error.code ? error.code : "failed");
      send(res, 500, { error: "Posta gönderilemedi. Biraz sonra tekrar dene." }, origin);
      return;
    }
    send(res, 200, { ok: true }, origin);
    return;
  }

  if (path === "/api/auth/reset" && req.method === "POST") {
    if (!rateAllow("reset:" + clientIp(req), 10, 60 * 60 * 1000)) {
      send(res, 429, { error: "Çok fazla deneme. Biraz sonra tekrar dene." }, origin);
      return;
    }
    let body;
    try {
      body = await readJson(req, 4096);
    } catch {
      send(res, 400, { error: "Geçersiz istek." }, origin);
      return;
    }
    const result = await resetPassword(body);
    if (result.error) {
      send(res, result.status, { error: result.error }, origin);
      return;
    }
    send(res, 200, { ok: true }, origin);
    return;
  }

  if (path === "/api/ops/erasures" && req.method === "GET") {
    if (!erasureAuthorized(req)) {
      send(res, 401, { error: "Yetki yok." }, origin);
      return;
    }
    send(res, 200, { data: { erasures: await listErasures() } }, origin);
    return;
  }

  if (path === "/api/ops/erasures/done" && req.method === "POST") {
    if (!erasureAuthorized(req)) {
      send(res, 401, { error: "Yetki yok." }, origin);
      return;
    }
    let body;
    try {
      body = await readJson(req, 65536);
    } catch {
      send(res, 400, { error: "Geçersiz istek." }, origin);
      return;
    }
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, 200) : [];
    send(res, 200, { data: { updated: await markErasuresPurged(ids) } }, origin);
    return;
  }

  if (path === "/api/auth/logout" && req.method === "POST") {
    const header = String(req.headers.authorization || "");
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    if (token.length >= 20) {
      await pool.query(`DELETE FROM app_sessions WHERE token_hash = $1`, [tokenHash(token)]);
    }
    send(res, 200, { ok: true }, origin);
    return;
  }

  if (path === "/api/auth/delete" && req.method === "POST") {
    const result = await deleteAccount(await userFromAuth(req));
    if (result.error) {
      send(res, result.status, { error: result.error }, origin);
      return;
    }
    send(res, 200, { data: result.data }, origin);
    return;
  }

  if (path === "/api/brand-places" && req.method === "GET") {
    const result = await listBrandPlaces(url, await userFromAuth(req));
    send(res, 200, { data: result.data }, origin);
    return;
  }

  if (path === "/api/brand-places" && req.method === "POST") {
    let body;
    try {
      body = await readJson(req, 8192);
    } catch {
      send(res, 400, { error: "Geçersiz istek." }, origin);
      return;
    }
    const result = await saveBrandPlace(body, await userFromAuth(req));
    if (result.error) {
      send(res, result.status, { error: result.error }, origin);
      return;
    }
    send(res, 200, { data: result.data }, origin);
    return;
  }

  if (path === "/api/brand-places/publish" && req.method === "POST") {
    let body;
    try {
      body = await readJson(req, 4096);
    } catch {
      send(res, 400, { error: "Geçersiz istek." }, origin);
      return;
    }
    const result = await publishBrandPlace(body, await userFromAuth(req));
    if (result.error) {
      send(res, result.status, { error: result.error }, origin);
      return;
    }
    send(res, 200, { data: result.data }, origin);
    return;
  }

  if (path === "/api/brand-places/reject" && req.method === "POST") {
    let body;
    try {
      body = await readJson(req, 4096);
    } catch {
      send(res, 400, { error: "Geçersiz istek." }, origin);
      return;
    }
    const result = await rejectBrandPlace(body, await userFromAuth(req));
    if (result.error) {
      send(res, result.status, { error: result.error }, origin);
      return;
    }
    send(res, 200, { data: result.data }, origin);
    return;
  }

  if (path === "/api/training-photos" && req.method === "POST") {
    if (!rateAllow("train:" + clientIp(req), 20, 60 * 60 * 1000)) {
      send(res, 429, { error: "Çok fazla fotoğraf. Biraz sonra tekrar dene." }, origin);
      return;
    }
    let body;
    try {
      body = await readJson(req, 8 * 1024 * 1024);
    } catch {
      send(res, 400, { error: "Geçersiz istek." }, origin);
      return;
    }
    const result = await saveTrainingPhoto(body, await userFromAuth(req));
    if (result.error) {
      send(res, result.status, { error: result.error }, origin);
      return;
    }
    send(res, 200, { data: result.data }, origin);
    return;
  }

  if (path === "/api/content-reports" && req.method === "POST") {
    if (!rateAllow("complaint:" + clientIp(req), 20, 60 * 60 * 1000)) {
      send(res, 429, { error: "Çok fazla şikâyet. Biraz sonra tekrar dene." }, origin);
      return;
    }
    let body;
    try {
      body = await readJson(req, 8192);
    } catch {
      send(res, 400, { error: "Geçersiz istek." }, origin);
      return;
    }
    const result = await saveContentReport(body, await userFromAuth(req));
    if (result.error) {
      send(res, result.status, { error: result.error }, origin);
      return;
    }
    send(res, 200, { data: result.data }, origin);
    return;
  }

  if (path === "/api/raw-samples" && req.method === "POST") {
    if (!rateAllow("raw:" + clientIp(req), 60, 60 * 60 * 1000)) {
      send(res, 429, { error: "Çok fazla kayıt. Biraz sonra tekrar dene." }, origin);
      return;
    }
    let body;
    try {
      body = await readJson(req, 1024 * 1024);
    } catch {
      send(res, 400, { error: "Geçersiz istek." }, origin);
      return;
    }
    const sessionUser = await userFromAuth(req);
    const result =
      body.patch && !body.payload
        ? await upsertRawSample(
            { id: body.id, payload: body.patch },
            sessionUser,
          )
        : await upsertRawSample(body, sessionUser);
    if (result.error) {
      send(res, result.status, { error: result.error }, origin);
      return;
    }
    send(res, 200, { data: result.data }, origin);
    return;
  }

  if (path === "/api/raw-samples/delete-own" && req.method === "POST") {
    const result = await deleteOwnRawSamples(await userFromAuth(req));
    if (result.error) {
      send(res, result.status, { error: result.error }, origin);
      return;
    }
    send(res, 200, { data: result.data }, origin);
    return;
  }

  if (req.method === "GET" && (path === "/api/reports/recent" || path === "/api/reports")) {
    if (!rateAllow("reports:" + clientIp(req), 40, 60 * 1000)) {
      send(res, 429, { error: "Çok fazla istek. Biraz sonra tekrar dene." }, origin);
      return;
    }
    const listed = path.endsWith("/recent")
      ? await recentReports(url, await userFromAuth(req))
      : await listReports(url, await userFromAuth(req));
    if (listed.error) {
      send(res, 400, { error: listed.error }, origin);
      return;
    }
    send(res, 200, { data: { reports: listed.reports, next: listed.next } }, origin);
    return;
  }

  if (path === "/api/reports/delete-own" && req.method === "POST") {
    let raw;
    try {
      raw = await readBody(req, 4096);
    } catch {
      send(res, 413, { error: "İstek çok büyük." }, origin);
      return;
    }
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      send(res, 400, { error: "Geçersiz istek." }, origin);
      return;
    }
    const result = await deleteOwnReports(body, await userFromAuth(req));
    if (result.error) {
      send(res, result.status, { error: result.error }, origin);
      return;
    }
    send(res, 200, { data: result.data }, origin);
    return;
  }

  if (path === "/api/reports/confirm" && req.method === "POST") {
    if (!rateAllow("confirm:" + clientIp(req), 40, 60 * 60 * 1000)) {
      send(res, 429, { error: "Çok fazla onay. Biraz sonra tekrar dene." }, origin);
      return;
    }
    let raw;
    try {
      raw = await readBody(req, 4096);
    } catch {
      send(res, 413, { error: "İstek çok büyük." }, origin);
      return;
    }
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      send(res, 400, { error: "Geçersiz istek." }, origin);
      return;
    }
    const result = await confirmReport(body, await userFromAuth(req));
    if (result.error) {
      send(res, result.status, { error: result.error }, origin);
      return;
    }
    send(res, 200, { data: result.data }, origin);
    return;
  }

  if (path === "/api/reports" && req.method === "POST") {
    if (!rateAllow("report:" + clientIp(req), 30, 60 * 60 * 1000)) {
      send(res, 429, { error: "Çok fazla bildirim. Biraz sonra tekrar dene." }, origin);
      return;
    }
    let raw;
    try {
      raw = await readBody(req, 8 * 1024 * 1024);
    } catch {
      send(res, 413, { error: "Fotoğraf çok büyük." }, origin);
      return;
    }
    let body;
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch {
      send(res, 400, { error: "Geçersiz istek." }, origin);
      return;
    }
    const result = await createReport(body, await userFromAuth(req));
    if (result.error) {
      send(res, result.status, { error: result.error }, origin);
      return;
    }
    send(res, 200, { data: result.data }, origin);
    return;
  }

  if (path === "/api/saved-places" && req.method === "GET") {
    const result = await listSavedPlaces(pool, await userFromAuth(req));
    if (result.error) {
      send(res, result.status, { error: result.error }, origin);
      return;
    }
    send(res, 200, { data: result.data }, origin);
    return;
  }

  if (path === "/api/saved-places" && req.method === "PUT") {
    let body;
    try {
      body = await readJson(req, 4096);
    } catch {
      send(res, 400, { error: "Geçersiz istek." }, origin);
      return;
    }
    const result = await saveSavedPlace(pool, await userFromAuth(req), body);
    if (result.error) {
      send(res, result.status, { error: result.error }, origin);
      return;
    }
    send(res, 200, { data: result.data }, origin);
    return;
  }

  if (path === "/api/saved-places" && req.method === "DELETE") {
    const result = await deleteSavedPlace(pool, await userFromAuth(req), url);
    if (result.error) {
      send(res, result.status, { error: result.error }, origin);
      return;
    }
    send(res, 200, { data: result.data }, origin);
    return;
  }

  if (req.method === "GET" && path === "/api/review") {
    const html = reviewDesk.reviewHtml();
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Length": Buffer.byteLength(html),
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    res.end(html);
    return;
  }

  if (req.method === "POST" && path === "/api/review/login") {
    if (!rateAllow("review-login:" + clientIp(req), 8, 10 * 60 * 1000)) {
      send(res, 429, { error: "Çok fazla deneme." }, origin);
      return;
    }
    let body;
    try {
      body = await readJson(req, 4096);
    } catch {
      send(res, 400, { error: "Geçersiz istek." }, origin);
      return;
    }
    const expected = String(process.env.ERASURE_TOKEN || "");
    if (!reviewDesk.sameText(body.token, expected)) {
      send(res, 401, { error: "Anahtar uyuşmadı." }, origin);
      return;
    }
    const cookie = reviewDesk.cookieValue(expected);
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Set-Cookie":
        "piaroute_review=" +
        cookie +
        "; HttpOnly; Secure; SameSite=Lax; Path=/api/review; Max-Age=43200",
      "Cache-Control": "no-store",
    });
    res.end('{"ok":true}');
    return;
  }

  if (req.method === "GET" && path === "/api/review/queue") {
    if (!reviewSession(req)) {
      send(res, 401, { error: "Yetki yok." }, origin);
      return;
    }
    send(res, 200, { data: await reviewDesk.queue(pool, publicPhoto) }, origin);
    return;
  }

  if (req.method === "GET" && path === "/api/review/training") {
    const syncToken = String(req.headers["x-training-token"] || "");
    const syncOk = reviewDesk.sameText(syncToken, process.env.TRAINING_SYNC_TOKEN);
    if (!reviewSession(req) && !syncOk) {
      send(res, 401, { error: "Yetki yok." }, origin);
      return;
    }
    send(res, 200, { data: await reviewDesk.training(pool, publicPhoto) }, origin);
    return;
  }

  if (req.method === "POST" && path === "/api/review/decide") {
    if (!reviewSession(req)) {
      send(res, 401, { error: "Yetki yok." }, origin);
      return;
    }
    let body;
    try {
      body = await readJson(req, 4096);
    } catch {
      send(res, 400, { error: "Geçersiz istek." }, origin);
      return;
    }
    const row = await reviewDesk.decide(pool, body.id, body.decision);
    if (!row) {
      send(res, 400, { error: "Karar kaydedilemedi." }, origin);
      return;
    }
    send(res, 200, { data: { id: row.id, status: row.status } }, origin);
    return;
  }

  if (req.method === "GET" && path === "/api/reports/status") {
    const ids = String(url.searchParams.get("ids") || "").split(",");
    send(res, 200, { data: await reviewDesk.statuses(pool, ids) }, origin);
    return;
  }

  if (req.method === "GET" && path === "/api/address") {
    if (!rateAllow("addr:" + clientIp(req), 40, 60 * 1000)) {
      send(res, 429, { error: "Çok fazla arama. Biraz sonra tekrar dene." }, origin);
      return;
    }
    try {
      const data = await searchAddress(pool, url);
      send(res, 200, { data }, origin);
    } catch (error) {
      console.error("address", error && error.code ? error.code : "failed");
      send(res, 200, { data: [] }, origin);
    }
    return;
  }

  if (req.method === "GET" && path === "/api/health") {
    send(res, 200, { ok: true }, origin);
    return;
  }

  if (path !== "/api/apply") {
    send(res, 404, { error: "Not found" }, origin);
    return;
  }

  if (req.method === "OPTIONS") {
    if (origin && !allowedOrigin(origin)) {
      send(res, 403, { error: "Forbidden" }, origin);
      return;
    }
    send(res, 204, {}, origin);
    return;
  }

  if (req.method !== "POST") {
    send(res, 405, { error: "Method not allowed" }, origin);
    return;
  }

  if (origin && !allowedOrigin(origin)) {
    send(res, 403, { error: "Forbidden" }, origin);
    return;
  }

  let raw;
  try {
    raw = await readBody(req, 4096);
  } catch (err) {
    send(res, err.status || 400, { error: "İstek çok büyük." }, origin);
    return;
  }

  let body;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    send(res, 400, { error: "Geçersiz istek gövdesi." }, origin);
    return;
  }

  if (body.website) {
    send(res, 201, { ok: true, status: "pending" }, origin);
    return;
  }

  const email = clean(body.email, 160).toLowerCase();
  let firstName = clean(body.first_name, 80);
  let lastName = clean(body.last_name, 80);
  if (!NAME_RE.test(firstName)) firstName = "Liste";
  if (!NAME_RE.test(lastName)) lastName = "Uyesi";
  let device = String(body.device || "android").toLowerCase();
  if (device !== "android" && device !== "ios") device = "android";
  const privacyOk = !!body.privacy_ok;

  if (!EMAIL_RE.test(email)) {
    send(res, 400, { error: "Geçerli bir e-posta gerekli." }, origin);
    return;
  }
  if (!privacyOk) {
    send(res, 400, { error: "Aydınlatma metni onayı gerekli." }, origin);
    return;
  }

  const ipHash = hashIp(clientIp(req));
  if (ipHash) {
    const counted = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM applications
       WHERE ip_hash = $1
         AND created_at > NOW() - INTERVAL '1 hour'`,
      [ipHash],
    );
    if ((counted.rows[0] && counted.rows[0].c) >= MAX_PER_HOUR) {
      send(res, 429, { error: "Çok fazla başvuru. Lütfen bir süre sonra tekrar deneyin." }, origin);
      return;
    }
  }

  await pool.query(
    `INSERT INTO applications (
       id, first_name, last_name, email, device,
       play_email_same, feedback_interview, product_updates,
       status, ip_hash
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8,
       'pending', $9
     )`,
    [
      randomUUID(),
      firstName,
      lastName,
      email,
      device,
      !!body.play_email_same,
      !!body.feedback_interview,
      body.product_updates === true,
      ipHash,
    ],
  );

  try {
    const mailed = await sendWelcome(email);
    if (mailed) {
      await pool.query(
        `UPDATE applications
         SET welcome_sent_at = NOW()
         WHERE lower(email) = lower($1)
           AND welcome_sent_at IS NULL`,
        [email],
      );
    }
  } catch (err) {
    console.error("welcome mail failed", err && err.responseCode ? err.responseCode : "smtp");
  }

  send(res, 201, { ok: true, status: "pending" }, origin);
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin || "";
  try {
    await handle(req, res);
  } catch (err) {
    const msg = String(err && err.message ? err.message : err);
    if (msg.includes("unique") || msg.includes("duplicate") || msg.includes("23505")) {
      send(res, 409, { error: "Bu e-posta zaten listede. Davet gelince yazarız." }, origin);
      return;
    }
    console.error("apply failed", err && err.code ? err.code : "unknown");
    if (!res.headersSent) {
      send(res, 500, { error: "Kayıt sırasında hata oluştu." }, origin);
    }
  }
});

ensureAuthTables()
  .catch((error) => {
    console.error(
      "auth table",
      error && error.code ? error.code : "failed",
      error && error.message ? error.message : "",
    );
  })
  .then(() => {
    server.listen(PORT, "127.0.0.1", () => {
      console.log("piaroute-api listening on 127.0.0.1:" + PORT);
    });
  });
