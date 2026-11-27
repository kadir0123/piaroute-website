const NOISE = new Set([
  "mah",
  "mahalle",
  "mahallesi",
  "sk",
  "sok",
  "sokak",
  "sokagi",
  "cad",
  "cd",
  "cadde",
  "caddesi",
  "blv",
  "bulvar",
  "bulvari",
  "no",
]);

const LEVEL = { 1: "il", 2: "ilce", 3: "mahalle", 4: "sokak" };

function fold(value) {
  return String(value || "")
    .toLocaleLowerCase("tr-TR")
    .replace(/ı/g, "i")
    .replace(/ğ/g, "g")
    .replace(/ü/g, "u")
    .replace(/ş/g, "s")
    .replace(/ö/g, "o")
    .replace(/ç/g, "c")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokensOf(query) {
  return fold(query)
    .split(" ")
    .filter((word) => word.length >= 2 && !NOISE.has(word))
    .slice(0, 6);
}

function metres(lat1, lon1, lat2, lon2) {
  const rad = (n) => (n * Math.PI) / 180;
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function matches(name, token) {
  if (!name || !token) return false;
  if (name === token || name.startsWith(token)) return true;
  return token.length >= 5 && name.includes(token);
}

function readablePlace(value) {
  if (!value) return value;
  let text = String(value)
    .replace(/\s*\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (text && text === text.toLocaleUpperCase("tr-TR")) {
    text = text
      .toLocaleLowerCase("tr-TR")
      .replace(/(^|\s)\S/gu, (part) => part.toLocaleUpperCase("tr-TR"));
  }
  return text.replace(/\s+Mah\.?$/i, " Mahallesi");
}

function label(row) {
  return [row.name, row.parent_name, row.grand_name, row.great_name]
    .filter(Boolean)
    .join(", ");
}

function rankRows(rows, tokens, near) {
  if (!tokens.length) return [];
  const ranked = [];
  for (const row of rows) {
    const names = [
      row.name_folded,
      row.parent_folded,
      row.grand_folded,
      row.great_folded,
    ];
    if (!tokens.every((token) => names.some((name) => matches(name, token)))) {
      continue;
    }
    if (!tokens.some((token) => matches(row.name_folded, token))) continue;
    const exact = tokens.some((token) => row.name_folded === token);
    const distance =
      near == null
        ? null
        : metres(near.lat, near.lon, Number(row.latitude), Number(row.longitude));
    ranked.push({ row, exact, distance });
  }
  ranked.sort((a, b) => {
    if (a.exact !== b.exact) return a.exact ? -1 : 1;
    if (a.distance != null && b.distance != null && a.distance !== b.distance) {
      return a.distance - b.distance;
    }
    if (a.row.level !== b.row.level) return a.row.level - b.row.level;
    return String(a.row.name).localeCompare(String(b.row.name), "tr");
  });
  return ranked.slice(0, 8).map(({ row }) => ({
    name: label(row),
    lat: Number(row.latitude),
    lon: Number(row.longitude),
    level: LEVEL[row.level] || "adres",
  }));
}

async function searchAddress(pool, url) {
  const tokens = tokensOf(url.searchParams.get("q") || "");
  if (!tokens.length) return [];
  const params = [];
  const add = (value) => {
    params.push(value);
    return "$" + params.length;
  };
  const cols = [
    "p.name_folded",
    "parent.name_folded",
    "grand.name_folded",
    "great.name_folded",
  ];
  const own = [];
  const every = [];
  for (const token of tokens) {
    const exact = add(token);
    const like = token.length >= 3 ? add(token + "%") : null;
    const bits = [];
    for (const col of cols) {
      bits.push(col + " = " + exact);
      if (like) bits.push(col + " LIKE " + like);
    }
    every.push("(" + bits.join(" OR ") + ")");
    own.push(
      like
        ? "(p.name_folded = " + exact + " OR p.name_folded LIKE " + like + ")"
        : "(p.name_folded = " + exact + ")",
    );
  }
  const lat = Number(url.searchParams.get("lat"));
  const lon = Number(url.searchParams.get("lon"));
  const near =
    Number.isFinite(lat) && Number.isFinite(lon) ? { lat, lon } : null;
  if (tokens.length === 1 && NEARBY[tokens[0]] && near) {
    return nearbyCategory(pool, tokens[0], near, radiusOf(url));
  }
  const latRef = add(near ? near.lat : null);
  const lonRef = add(near ? near.lon : null);
  const found = await pool.query(
    `SELECT p.name, p.level, p.latitude, p.longitude, p.name_folded,
            parent.name AS parent_name, parent.name_folded AS parent_folded,
            grand.name AS grand_name, grand.name_folded AS grand_folded,
            great.name AS great_name, great.name_folded AS great_folded
     FROM address_places p
     LEFT JOIN address_places parent ON parent.id = p.parent_id
     LEFT JOIN address_places grand ON grand.id = parent.parent_id
     LEFT JOIN address_places great ON great.id = grand.parent_id
     WHERE (${own.join(" OR ")})
       AND ${every.join(" AND ")}
     ORDER BY CASE
       WHEN ${latRef}::float8 IS NULL THEN 0
       ELSE power(p.latitude - ${latRef}::float8, 2) + power(p.longitude - ${lonRef}::float8, 2)
     END, p.level ASC
     LIMIT 40`,
    params,
  );
  const rows = found.rows.slice();
  try {
    const likes = tokens
      .filter((token) => token.length >= 4)
      .map((token) => "%" + token + "%");
    if (!likes.length) likes.push("##");
    const institutions = await pool.query(
      `SELECT name, 5 AS level, latitude, longitude, name_folded,
              NULL::text AS parent_name, city_folded AS parent_folded,
              NULL::text AS grand_name, NULL::text AS grand_folded,
              NULL::text AS great_name, NULL::text AS great_folded
       FROM public_institutions
       WHERE name_folded LIKE ANY($1::text[])
          OR category = ANY($2::text[])
       ORDER BY CASE
         WHEN $3::float8 IS NULL THEN 0
         ELSE power(latitude - $3::float8, 2) + power(longitude - $4::float8, 2)
       END
       LIMIT 30`,
      [likes, tokens, near ? near.lat : null, near ? near.lon : null],
    );
    rows.push(...institutions.rows);
  } catch (error) {
    if (!error || error.code !== "42P01") throw error;
  }
  try {
    const likes = tokens
      .filter((token) => token.length >= 3)
      .map((token) => "%" + token + "%");
    if (!likes.length) likes.push("##");
    const chains = await pool.query(
      `SELECT c.name, 5 AS level, c.latitude, c.longitude, c.name_folded,
              mah.name AS parent_name,
              COALESCE(mah.name_folded, c.brand_id) AS parent_folded,
              ilce.name AS grand_name, ilce.name_folded AS grand_folded,
              il.name AS great_name, il.name_folded AS great_folded
       FROM chain_branches c
       LEFT JOIN address_places mah ON mah.id = c.address_place_id
       LEFT JOIN address_places ilce ON ilce.id = mah.parent_id
       LEFT JOIN address_places il ON il.id = ilce.parent_id
       WHERE c.name_folded LIKE ANY($1::text[])
          OR c.brand_id = ANY($2::text[])
          OR c.category = ANY($2::text[])
       ORDER BY CASE
         WHEN $3::float8 IS NULL THEN 0
         ELSE power(c.latitude - $3::float8, 2) + power(c.longitude - $4::float8, 2)
       END
       LIMIT 30`,
      [likes, tokens, near ? near.lat : null, near ? near.lon : null],
    );
    rows.push(...chains.rows);
  } catch (error) {
    if (!error || error.code !== "42P01") throw error;
  }
  for (const row of rows) {
    if (row.level !== 5) continue;
    row.parent_name = readablePlace(row.parent_name);
    row.grand_name = readablePlace(row.grand_name);
    row.great_name = readablePlace(row.great_name);
  }
  await fillPlaceLines(pool, rows.filter((row) => row.level === 5 && !row.parent_name));
  return rankRows(rows, tokens, near);
}

async function fillPlaceLines(pool, rows) {
  if (!rows.length) return;
  const lats = rows.map((row) => Number(row.latitude));
  const lons = rows.map((row) => Number(row.longitude));
  if (lats.some((value) => !Number.isFinite(value))) return;
  let found;
  try {
    found = await pool.query(
      `SELECT i.ord, mah.name AS mahalle, ilce.name AS ilce, il.name AS il
       FROM unnest($1::float8[], $2::float8[]) WITH ORDINALITY AS i(lat, lon, ord)
       LEFT JOIN LATERAL (
         SELECT name, parent_id
         FROM address_places
         WHERE level = 3
           AND latitude BETWEEN i.lat - 0.015 AND i.lat + 0.015
           AND longitude BETWEEN i.lon - 0.015 AND i.lon + 0.015
         ORDER BY power(latitude - i.lat, 2) + power(longitude - i.lon, 2)
         LIMIT 1
       ) mah ON true
       LEFT JOIN address_places ilce ON ilce.id = mah.parent_id
       LEFT JOIN address_places il ON il.id = ilce.parent_id`,
      [lats, lons],
    );
  } catch (error) {
    if (!error || error.code !== "42P01") throw error;
    return;
  }
  const byOrd = new Map(found.rows.map((row) => [Number(row.ord), row]));
  rows.forEach((row, index) => {
    const hit = byOrd.get(index + 1);
    if (!hit || !hit.mahalle) return;
    row.parent_name = readablePlace(hit.mahalle);
    row.grand_name = readablePlace(hit.ilce) || null;
    row.great_name = readablePlace(hit.il) || null;
    row.parent_folded = fold(hit.mahalle);
    row.grand_folded = fold(hit.ilce);
    row.great_folded = fold(hit.il);
  });
}

function namedPlace(row) {
  const line = [row.mahalle, row.ilce, row.il]
    .map(readablePlace)
    .filter(Boolean)
    .join(", ");
  return line ? row.name + ", " + line : row.name;
}

const CATEGORY_WORD = {
  vergi: "vergi",
  adliye: "adliye",
  universite: "universite",
  hastane: "hastane",
  belediye: "belediye",
  nufus: "nufus",
  kaymakamlik: "kaymakamlik",
  valilik: "valilik",
  sgk: "sgk",
  emniyet: "emniyet",
};

const NEARBY = {
  market: { chain: ["market"], institution: [] },
  benzin: { chain: ["benzinlik"], institution: [] },
  benzinlik: { chain: ["benzinlik"], institution: [] },
  kafe: { chain: ["kafe"], institution: [] },
  cafe: { chain: ["kafe"], institution: [] },
  restoran: { chain: ["restoran"], institution: [] },
  hastane: { chain: ["hastane"], institution: ["hastane"] },
  avm: { chain: ["avm"], institution: [] },
  sinema: { chain: ["sinema"], institution: [] },
};

function radiusOf(url) {
  const raw = Number(url.searchParams.get("radius"));
  if (!Number.isFinite(raw)) return 18000;
  return Math.min(50000, Math.max(500, raw));
}

async function nearbyCategory(pool, token, near, radius) {
  const spec = NEARBY[token];
  if (!spec || !near) return null;
  const delta = radius / 111320 + 0.01;
  const box = [
    near.lat - delta,
    near.lat + delta,
    near.lon - delta,
    near.lon + delta,
    near.lat,
    near.lon,
  ];
  const out = [];
  async function pull(table, categories) {
    if (!categories.length) return;
    const placeJoin =
      table === "chain_branches"
        ? `LEFT JOIN address_places mah ON mah.id = ${table}.address_place_id
           LEFT JOIN address_places ilce ON ilce.id = mah.parent_id
           LEFT JOIN address_places il ON il.id = ilce.parent_id`
        : "";
    const placeCols =
      table === "chain_branches"
        ? ", mah.name AS mahalle, ilce.name AS ilce, il.name AS il"
        : "";
    const found = await pool.query(
      `SELECT name, category, latitude, longitude${placeCols}
       FROM ${table}
       ${placeJoin}
       WHERE category = ANY($1::text[])
         AND latitude BETWEEN $2 AND $3
         AND longitude BETWEEN $4 AND $5
       ORDER BY power(latitude - $6, 2) + power(longitude - $7, 2)
       LIMIT 60`,
      [categories, ...box],
    );
    for (const row of found.rows) {
      const distance = metres(near.lat, near.lon, Number(row.latitude), Number(row.longitude));
      if (distance > radius) continue;
      out.push({
        name: namedPlace(row),
        lat: Number(row.latitude),
        lon: Number(row.longitude),
        level: row.category,
        distance,
      });
    }
  }
  try {
    await pull("chain_branches", spec.chain);
  } catch (error) {
    if (!error || error.code !== "42P01") throw error;
  }
  try {
    await pull("public_institutions", spec.institution);
  } catch (error) {
    if (!error || error.code !== "42P01") throw error;
  }
  out.sort((a, b) => a.distance - b.distance);
  return out.slice(0, 24).map(({ name, lat, lon, level }) => ({ name, lat, lon, level }));
}

async function nearestMahalle(pool, lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  try {
    const found = await pool.query(
      `SELECT id, latitude, longitude
       FROM address_places
       WHERE level = 3
         AND latitude BETWEEN $1 AND $2
         AND longitude BETWEEN $3 AND $4
       ORDER BY power(latitude - $5, 2) + power(longitude - $6, 2)
       LIMIT 1`,
      [lat - 0.02, lat + 0.02, lon - 0.02, lon + 0.02, lat, lon],
    );
    const row = found.rows[0];
    if (!row) return null;
    if (metres(lat, lon, Number(row.latitude), Number(row.longitude)) > 1500) return null;
    return row.id;
  } catch (error) {
    if (error && error.code === "42P01") return null;
    throw error;
  }
}

module.exports = {
  fold,
  tokensOf,
  rankRows,
  searchAddress,
  nearestMahalle,
  nearbyCategory,
  CATEGORY_WORD,
};
