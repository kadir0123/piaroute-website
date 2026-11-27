const { randomUUID } = require("crypto");
const { nearestMahalle } = require("./address-search");

const KINDS = new Set(["home", "work", "parked", "favorite"]);

function placeJson(row) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    lat: row.latitude,
    lon: row.longitude,
    addressPlaceId: row.address_place_id,
  };
}

async function listSavedPlaces(pool, userId) {
  if (!userId) return { error: "Giriş gerekir.", status: 401 };
  const found = await pool.query(
    `SELECT id, kind, name, latitude, longitude, address_place_id
     FROM saved_places
     WHERE user_id = $1
     ORDER BY updated_at DESC`,
    [userId],
  );
  return { status: 200, data: { places: found.rows.map(placeJson) } };
}

async function saveSavedPlace(pool, userId, body) {
  if (!userId) return { error: "Giriş gerekir.", status: 401 };
  const kind = String(body.kind || "").trim();
  const name = String(body.name || "").trim().slice(0, 160);
  const lat = Number(body.lat);
  const lon = Number(body.lon);
  if (!KINDS.has(kind) || !name || !Number.isFinite(lat) || !Number.isFinite(lon)) {
    return { error: "Yer kaydı geçersiz.", status: 400 };
  }
  const addressPlaceId = await nearestMahalle(pool, lat, lon);
  if (kind === "favorite") {
    const id = randomUUID();
    await pool.query(
      `DELETE FROM saved_places
       WHERE user_id = $1 AND kind = 'favorite'
         AND abs(latitude - $2) < 0.00001
         AND abs(longitude - $3) < 0.00001`,
      [userId, lat, lon],
    );
    await pool.query(
      `INSERT INTO saved_places
         (id, user_id, kind, name, latitude, longitude, address_place_id)
       VALUES ($1,$2,'favorite',$3,$4,$5,$6)`,
      [id, userId, name, lat, lon, addressPlaceId],
    );
    return { status: 200, data: { id, addressPlaceId } };
  }
  const existing = await pool.query(
    `SELECT id FROM saved_places WHERE user_id = $1 AND kind = $2`,
    [userId, kind],
  );
  if (existing.rows[0]) {
    await pool.query(
      `UPDATE saved_places
       SET name = $3, latitude = $4, longitude = $5,
           address_place_id = $6, updated_at = NOW()
       WHERE id = $1 AND user_id = $2`,
      [existing.rows[0].id, userId, name, lat, lon, addressPlaceId],
    );
    return { status: 200, data: { id: existing.rows[0].id, addressPlaceId } };
  }
  const id = randomUUID();
  await pool.query(
    `INSERT INTO saved_places
       (id, user_id, kind, name, latitude, longitude, address_place_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, userId, kind, name, lat, lon, addressPlaceId],
  );
  return { status: 200, data: { id, addressPlaceId } };
}

async function deleteSavedPlace(pool, userId, url) {
  if (!userId) return { error: "Giriş gerekir.", status: 401 };
  const kind = String(url.searchParams.get("kind") || "").trim();
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  if (kind === "favorite" && Number.isFinite(lat) && Number.isFinite(lon)) {
    await pool.query(
      `DELETE FROM saved_places
       WHERE user_id = $1 AND kind = 'favorite'
         AND abs(latitude - $2) < 0.00001
         AND abs(longitude - $3) < 0.00001`,
      [userId, lat, lon],
    );
    return { status: 200, data: { ok: true } };
  }
  if (!KINDS.has(kind) || kind === "favorite") {
    return { error: "Yer kaydı geçersiz.", status: 400 };
  }
  await pool.query(`DELETE FROM saved_places WHERE user_id = $1 AND kind = $2`, [
    userId,
    kind,
  ]);
  return { status: 200, data: { ok: true } };
}

module.exports = { listSavedPlaces, saveSavedPlace, deleteSavedPlace };
