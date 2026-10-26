import { createPool } from "@vercel/postgres";
import { createHash, randomUUID } from "crypto";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const NAME_RE = /^[\p{L}\p{M}][\p{L}\p{M}\s'.-]{0,79}$/u;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://www.piaroute.com";
const MAX_PER_HOUR = Number(process.env.APPLY_RATE_LIMIT_PER_HOUR || 5);

function dbUrl() {
  return (
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    ""
  );
}

let pool;
function getPool() {
  if (!pool) {
    const connectionString = dbUrl();
    if (!connectionString) return null;
    pool = createPool({ connectionString });
  }
  return pool;
}

function isAllowedOrigin(origin) {
  if (!origin) return true;
  if (origin === ALLOWED_ORIGIN) return true;
  if (origin === "http://localhost:3000" || origin === "http://127.0.0.1:3000") {
    return process.env.NODE_ENV !== "production";
  }
  if (
    process.env.ALLOW_VERCEL_PREVIEW === "true" &&
    /\.vercel\.app$/.test(new URL(origin).hostname)
  ) {
    return true;
  }
  return false;
}

function corsHeaders(origin) {
  const allow = isAllowedOrigin(origin) ? origin || ALLOWED_ORIGIN : ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
}

function json(res, status, data, origin) {
  res.statusCode = status;
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    ...corsHeaders(origin),
  };
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(data));
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
  return xf || req.socket?.remoteAddress || "";
}

function hashIp(ip) {
  if (!ip) return null;
  const salt = process.env.IP_HASH_SALT;
  if (!salt) return null;
  return createHash("sha256").update(ip + salt).digest("hex");
}

async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true, skipped: true };
  if (!token || token.length > 2048) return { ok: false };

  const body = new URLSearchParams();
  body.set("secret", secret);
  body.set("response", token);
  if (ip) body.set("remoteip", ip);

  const r = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    { method: "POST", body },
  );
  if (!r.ok) return { ok: false };
  const data = await r.json();
  return { ok: !!data.success };
}

export default async function handler(req, res) {
  const origin = req.headers.origin || "";

  if (req.method === "OPTIONS") {
    if (!isAllowedOrigin(origin)) {
      json(res, 403, { error: "Forbidden" }, origin);
      return;
    }
    json(res, 204, {}, origin);
    return;
  }

  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" }, origin);
    return;
  }

  if (origin && !isAllowedOrigin(origin)) {
    json(res, 403, { error: "Forbidden" }, origin);
    return;
  }

  const rawLen = Number(req.headers["content-length"] || 0);
  if (rawLen > 4096) {
    json(res, 413, { error: "İstek çok büyük." }, origin);
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    if (body.length > 4096) {
      json(res, 413, { error: "İstek çok büyük." }, origin);
      return;
    }
    try {
      body = JSON.parse(body);
    } catch {
      json(res, 400, { error: "Geçersiz istek gövdesi." }, origin);
      return;
    }
  }
  body = body || {};

  if (body.website) {
    json(res, 201, { ok: true, status: "pending" }, origin);
    return;
  }

  const first_name = clean(body.first_name, 80);
  const last_name = clean(body.last_name, 80);
  const email = clean(body.email, 160).toLowerCase();
  const device = String(body.device || "").toLowerCase();
  const play_email_same = !!body.play_email_same;
  const feedback_interview = !!body.feedback_interview;
  const product_updates = !!body.product_updates;
  const privacy_ok = !!body.privacy_ok;
  const turnstile_token = String(body.turnstile_token || "");

  if (!NAME_RE.test(first_name) || !NAME_RE.test(last_name) || !EMAIL_RE.test(email)) {
    json(res, 400, { error: "Ad, soyad ve geçerli e-posta gerekli." }, origin);
    return;
  }
  if (device !== "android" && device !== "ios") {
    json(res, 400, { error: "Cihaz seçimi geçersiz." }, origin);
    return;
  }
  if (device === "android" && !play_email_same) {
    json(
      res,
      400,
      { error: "Android için Play hesabı e-posta onayını işaretleyin." },
      origin,
    );
    return;
  }
  if (!privacy_ok) {
    json(res, 400, { error: "Aydınlatma metni onayı gerekli." }, origin);
    return;
  }

  const ip = clientIp(req);
  const bot = await verifyTurnstile(turnstile_token, ip);
  if (!bot.ok) {
    json(res, 403, { error: "Bot koruması başarısız. Tekrar deneyin." }, origin);
    return;
  }

  const db = getPool();
  if (!db) {
    json(
      res,
      500,
      { error: "Başvuru şu an alınamıyor. Lütfen daha sonra tekrar deneyin." },
      origin,
    );
    return;
  }

  const id = randomUUID();
  const ip_hash = hashIp(ip);

  try {
    if (ip_hash) {
      const { rows } = await db.sql`
        SELECT COUNT(*)::int AS c
        FROM applications
        WHERE ip_hash = ${ip_hash}
          AND created_at > NOW() - INTERVAL '1 hour'
      `;
      if ((rows[0]?.c || 0) >= MAX_PER_HOUR) {
        json(
          res,
          429,
          { error: "Çok fazla başvuru. Lütfen bir süre sonra tekrar deneyin." },
          origin,
        );
        return;
      }
    }

    await db.sql`
      INSERT INTO applications (
        id, first_name, last_name, email, device,
        play_email_same, feedback_interview, product_updates,
        status, ip_hash
      ) VALUES (
        ${id}, ${first_name}, ${last_name}, ${email}, ${device},
        ${play_email_same}, ${feedback_interview}, ${product_updates},
        'pending', ${ip_hash}
      )
    `;
  } catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes("unique") || msg.includes("duplicate") || msg.includes("23505")) {
      json(
        res,
        409,
        {
          error:
            "Bu e-posta ile zaten başvuru var. Durumu e-posta ile takip edebilirsiniz.",
        },
        origin,
      );
      return;
    }
    console.error("apply insert error", e?.code || "unknown");
    json(res, 500, { error: "Kayıt sırasında hata oluştu." }, origin);
    return;
  }

  json(res, 201, { ok: true, status: "pending" }, origin);
}
