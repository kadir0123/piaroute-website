const fs = require("fs");
const https = require("https");
const path = require("path");
const readline = require("readline");
const { fold } = require("./address-search");

function queryFor(south, west, north, east) {
  const box = `${south},${west},${north},${east}`;
  return `
[out:json][timeout:40];
(
  nwr["shop"~"supermarket|convenience"]["name"~"A101|A 101|BİM|BIM|Migros|Şok|Sok Market|Carrefour",i](${box});
  nwr["brand"~"A101|BİM|BIM|Migros|Şok|CarrefourSA|Carrefour",i]["shop"](${box});
  nwr["amenity"="fuel"]["name"~"Opet|Shell|Petrol Ofisi|Aytemiz|^BP$|^BP ",i](${box});
  nwr["amenity"="fuel"]["brand"~"Opet|Shell|BP|Petrol Ofisi|Aytemiz",i](${box});
  nwr["amenity"~"cafe|fast_food|restaurant"]["name"~"Starbucks|Kahve Dünyası|Kahve Dunyasi|McDonald|Burger King",i](${box});
  nwr["brand"~"Starbucks|McDonald's|Burger King",i](${box});
);
out center tags;
`;
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = https.request(
      {
        hostname: target.hostname,
        path: target.pathname,
        method: "POST",
        headers: {
          "Content-Type": "text/plain",
          "Content-Length": Buffer.byteLength(body),
          "User-Agent": "piaroute-seed",
        },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () =>
          resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    req.on("error", reject);
    req.setTimeout(90000, () => req.destroy(new Error("timeout")));
    req.end(body);
  });
}

function brandOf(tags) {
  const name = fold(`${tags.name || ""} ${tags.brand || ""} ${tags.operator || ""}`);
  const fuel = tags.amenity === "fuel";
  if (name.includes("a101") || name.includes("a 101")) return ["a101", "market"];
  if (/(^| )bim( |$)/.test(name)) return ["bim", "market"];
  if (name.includes("migros")) return ["migros", "market"];
  if (name.includes("sok market") || name.includes("carrefour")) {
    if (name.includes("carrefour")) return ["carrefoursa", "market"];
    return ["sok", "market"];
  }
  if (/(^| )sok( |$)/.test(name) && tags.shop) return ["sok", "market"];
  if (fuel && name.includes("petrol ofisi")) return ["po", "benzinlik"];
  if (fuel && name.includes("aytemiz")) return ["aytemiz", "benzinlik"];
  if (fuel && name.includes("opet")) return ["opet", "benzinlik"];
  if (fuel && /(^| )shell( |$)/.test(name)) return ["shell", "benzinlik"];
  if (fuel && /(^| )bp( |$)/.test(name)) return ["bp", "benzinlik"];
  if (name.includes("starbucks")) return ["starbucks", "kafe"];
  if (name.includes("kahve dunyasi")) return ["kahvedunyasi", "kafe"];
  if (name.includes("mcdonald")) return ["mcdonalds", "restoran"];
  if (name.includes("burger king")) return ["burgerking", "restoran"];
  return null;
}

function sqlStr(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

async function loadMahalle() {
  const file = path.join(__dirname, "..", "sql", "address_seed.sql");
  const grid = new Map();
  const row =
    /^\((\d+),\d+,3,'(?:[^']|'')*','(?:[^']|'')*',NULL,(-?\d+\.\d+),(-?\d+\.\d+)\)/;
  const input = fs.createReadStream(file);
  const lines = readline.createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    const match = row.exec(line.trim());
    if (!match) continue;
    const place = {
      id: Number(match[1]),
      lat: Number(match[2]),
      lon: Number(match[3]),
    };
    const key =
      Math.floor(place.lat / 0.02) + "," + Math.floor(place.lon / 0.02);
    const bucket = grid.get(key);
    if (bucket) bucket.push(place);
    else grid.set(key, [place]);
  }
  return grid;
}

function nearestMahalle(grid, lat, lon) {
  let best = null;
  let bestMetres = 1500;
  const latCell = Math.floor(lat / 0.02);
  const lonCell = Math.floor(lon / 0.02);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const bucket = grid.get(latCell + dy + "," + (lonCell + dx));
      if (!bucket) continue;
      for (const place of bucket) {
        const dLat = (place.lat - lat) * 111320;
        const dLon = (place.lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180);
        const metres = Math.hypot(dLat, dLon);
        if (metres < bestMetres) {
          bestMetres = metres;
          best = place.id;
        }
      }
    }
  }
  return best;
}

async function main() {
  const url = process.argv[2] || "https://www.piaroute.com/overpass/api/interpreter";
  const elements = [];
  for (let south = 36; south < 42.5; south += 2) {
    for (let west = 26; west < 45; west += 2.5) {
      let response;
      try {
        response = await post(url, queryFor(south, west, south + 2, west + 2.5));
      } catch (error) {
        console.error("kutu", south, west, error.message || error);
        continue;
      }
      if (response.status !== 200) {
        console.error("kutu", south, west, response.status);
        continue;
      }
      const data = JSON.parse(response.body);
      elements.push(...(data.elements || []));
      console.log("kutu", south, west, (data.elements || []).length);
    }
  }
  const grid = await loadMahalle();
  const seen = new Set();
  const rows = [];
  const counts = {};
  let id = 1;
  for (const element of elements) {
    const tags = element.tags || {};
    const brand = brandOf(tags);
    const lat = element.lat || (element.center && element.center.lat);
    const lon = element.lon || (element.center && element.center.lon);
    if (!brand || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < 35 || lat > 43 || lon < 25 || lon > 46) continue;
    const name = String(tags.name || tags.brand || brand[0]).replace(/\s+/g, " ").trim();
    const folded = fold(name);
    const key = brand[0] + "|" + lat.toFixed(4) + "|" + lon.toFixed(4);
    if (seen.has(key)) continue;
    seen.add(key);
    counts[brand[0]] = (counts[brand[0]] || 0) + 1;
    const mahalle = nearestMahalle(grid, lat, lon);
    rows.push(
      "(" +
        id +
        "," +
        sqlStr(brand[0]) +
        "," +
        sqlStr(name) +
        "," +
        sqlStr(folded) +
        "," +
        sqlStr(brand[1]) +
        "," +
        (mahalle == null ? "NULL" : mahalle) +
        "," +
        Number(lat).toFixed(6) +
        "," +
        Number(lon).toFixed(6) +
        ")",
    );
    id += 1;
  }
  const out =
    "-- Taninan zincir subeleri. OpenStreetMap merkez noktalari.\n" +
    "-- address_place_id, 1.5 km icindeki mahalle satiridir.\n" +
    "INSERT INTO chain_branches (id, brand_id, name, name_folded, category, address_place_id, latitude, longitude) VALUES\n" +
    rows.join(",\n") +
    "\nON CONFLICT (id) DO UPDATE SET brand_id = EXCLUDED.brand_id, name = EXCLUDED.name, name_folded = EXCLUDED.name_folded, category = EXCLUDED.category, address_place_id = EXCLUDED.address_place_id, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude;\n";
  fs.writeFileSync(path.join(__dirname, "..", "sql", "chain_branches_seed.sql"), out);
  console.log(JSON.stringify({ toplam: rows.length, counts }));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
