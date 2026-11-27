import { sql } from "@vercel/postgres";
import { createHash, randomUUID } from "crypto";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/i;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://www.piaroute.com";

function corsHeaders(origin) {
  const allow =
    !origin ||
    origin === ALLOWED_ORIGIN ||
    origin.endsWith(".vercel.app") ||
    origin.includes("localhost")
      ? origin || ALLOWED_ORIGIN
      : ALLOWED_ORIGIN;
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
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
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, max);
}

async function verifyTurnstile(token, ip) {
  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) return { ok: true, skipped: true };
  if (!token) return { ok: false };

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
    json(res, 204, {}, origin);
    return;
  }

  if (req.method !== "POST") {
    json(res, 405, { error: "Method not allowed" }, origin);
    return;
  }

  let body = req.body;
  if (typeof body === "string") {
    try {
      body = JSON.parse(body);
    } catch {
      json(res, 400, { error: "Geçersiz istek gövdesi." }, origin);
      return;
    }
  }
  body = body || {};

  // Honeypot: bots fill hidden "website" field
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

  if (!first_name || !last_name || !EMAIL_RE.test(email)) {
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

  const ip =
    (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
    req.socket?.remoteAddress ||
    "";

  const bot = await verifyTurnstile(turnstile_token, ip);
  if (!bot.ok) {
    json(res, 403, { error: "Bot koruması başarısız. Tekrar deneyin." }, origin);
    return;
  }
  if (!bot.skipped && !turnstile_token) {
    json(res, 400, { error: "Bot koruması doğrulanamadı." }, origin);
    return;
  }

  if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL) {
    json(
      res,
      500,
      {
        error:
          "Veritabanı bağlı değil. Vercel → Storage → Postgres oluşturun.",
      },
      origin,
    );
    return;
  }

  const id = randomUUID();
  const ip_hash = ip
    ? createHash("sha256")
        .update(ip + (process.env.IP_HASH_SALT || "piaroute"))
        .digest("hex")
    : null;

  try {
    await sql`
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
    console.error("apply insert error", e);
    json(res, 500, { error: "Kayıt sırasında hata oluştu." }, origin);
    return;
  }

  json(res, 201, { ok: true, id, status: "pending" }, origin);
}
