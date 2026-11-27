const fs = require("fs");
const https = require("https");
const path = require("path");
const readline = require("readline");
const { fold } = require("./address-search");

const seedPath = path.join(__dirname, "..", "sql", "chain_branches_seed.sql");

function queryFor(south, west, north, east) {
  const box = `${south},${west},${north},${east}`;
  return `
[out:json][timeout:40];
(
  nwr["amenity"="hospital"]["name"~"Acıbadem|Acibadem|Medical Park|Medicana|Memorial",i](${box});
  nwr["healthcare"="hospital"]["name"~"Acıbadem|Acibadem|Medical Park|Medicana|Memorial",i](${box});
  nwr["shop"="mall"]["name"~"İstinye|Istinye|Zorlu|Cevahir|Forum|Mall of",i](${box});
  nwr["name"~"İstinyePark|Istinye Park|Zorlu Center|Mall of İstanbul|Mall of Istanbul|Cevahir AVM|Forum AVM",i](${box});
  nwr["name"~"^Simit Sarayı|^Simit Sarayi|^Tavuk Dünyası|^Tavuk Dunyasi",i](${box});
  nwr["brand"~"Simit Sarayı|Simit Sarayi|Tavuk Dünyası|Tavuk Dunyasi|Cinemaximum",i](${box});
  nwr["name"~"^Cinemaximum|^Cinema Maximum",i](${box});
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
  const name = fold(`${tags.name || ""} ${tags.brand || ""}`);
  const hospital =
    tags.amenity === "hospital" ||
    tags.healthcare === "hospital" ||
    name.includes("hastane") ||
    name.includes("tip merkezi");
  if (name.includes("universite")) return null;
  if (hospital && name.includes("acibadem")) return ["acibadem", "hastane"];
  if (hospital && name.includes("medical park")) return ["medicalpark", "hastane"];
  if (hospital && name.includes("medicana")) return ["medicana", "hastane"];
  if (hospital && name.includes("memorial")) return ["memorial", "hastane"];
  const brandTag = fold(tags.brand || "");
  if (mallSelf(name, ["istinyepark", "istinye park"])) return ["istinyepark", "avm"];
  if (mallSelf(name, ["zorlu center"])) return ["zorlu", "avm"];
  if (mallSelf(name, ["mall of istanbul"])) return ["mallofistanbul", "avm"];
  if (mallSelf(name, ["cevahir", "biz cevahir"])) return ["cevahir", "avm"];
  if (mallSelf(name, ["forum", "marmara forum"])) return ["forum", "avm"];
  if (chainName(name, brandTag, "simit sarayi")) return ["simitsarayi", "restoran"];
  if (chainName(name, brandTag, "tavuk dunyasi")) return ["tavukdunyasi", "restoran"];
  if (chainName(name, brandTag, "cinemaximum") || chainName(name, brandTag, "cinema maximum")) {
    return ["cinemaximum", "sinema"];
  }
  return null;
}

const mallExtra = new Set([
  "avm",
  "center",
  "outlet",
  "park",
  "istanbul",
  "izmir",
  "ankara",
  "antalya",
  "bursa",
  "adana",
  "mersin",
  "konya",
  "gaziantep",
  "kayseri",
  "diyarbakir",
  "samsun",
  "denizli",
  "aydin",
  "trabzon",
  "erzurum",
  "eskisehir",
  "bornova",
  "gordion",
  "kapadokya",
  "halic",
  "marmara",
  "alisveris",
  "ve",
  "eglence",
  "yasam",
  "merkezi",
  "outlet",
]);

function mallSelf(name, needles) {
  const hit = needles
    .slice()
    .sort((a, b) => b.length - a.length)
    .find((needle) => name.includes(needle));
  if (!hit) return false;
  if (/(otobus|durak|duragi|mescit|taksi|eczane|kapi|otopark|fitcity|hyatt|hilton)/.test(name)) {
    return false;
  }
  const rest = name.replace(hit, " ");
  return rest.split(" ").filter(Boolean).every((word) => mallExtra.has(word));
}

function chainName(name, brandTag, needle) {
  return brandTag.includes(needle) || name === needle || name.startsWith(needle + " ");
}

function sqlStr(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

async function loadMahalle() {
  const file = path.join(__dirname, "..", "sql", "address_seed.sql");
  const grid = new Map();
  const row =
    /^\((\d+),\d+,3,'(?:[^']|'')*','(?:[^']|'')*',NULL,(-?\d+\.\d+),(-?\d+\.\d+)\)/;
  const lines = readline.createInterface({
    input: fs.createReadStream(file),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    const match = row.exec(line.trim());
    if (!match) continue;
    const place = {
      id: Number(match[1]),
      lat: Number(match[2]),
      lon: Number(match[3]),
    };
    const key = Math.floor(place.lat / 0.02) + "," + Math.floor(place.lon / 0.02);
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

function nextId() {
  let text = fs.readFileSync(seedPath, "utf8");
  const markerAt = text.indexOf("\n-- dalga 2\n");
  if (markerAt >= 0) text = text.slice(0, markerAt);
  let max = 0;
  for (const line of text.split(/\n/)) {
    const match = /^\((\d+),/.exec(line);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
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
  const kept = [];
  const counts = {};
  let id = nextId();
  for (const element of elements) {
    const tags = element.tags || {};
    const brand = brandOf(tags);
    const lat = element.lat || (element.center && element.center.lat);
    const lon = element.lon || (element.center && element.center.lon);
    if (!brand || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < 35 || lat > 43 || lon < 25 || lon > 46) continue;
    const label = String(tags.name || tags.brand || brand[0]).replace(/\s+/g, " ").trim();
    const folded = fold(label);
    const key = brand[0] + "|" + lat.toFixed(4) + "|" + lon.toFixed(4);
    if (seen.has(key)) continue;
    seen.add(key);
    const near = kept.find((place) => {
      if (place.brand !== brand[0]) return false;
      const dLat = (place.lat - lat) * 111320;
      const dLon = (place.lon - lon) * 111320 * Math.cos((lat * Math.PI) / 180);
      const limit = brand[1] === "avm" ? 400 : 80;
      return Math.hypot(dLat, dLon) < limit;
    });
    if (near) continue;
    counts[brand[0]] = (counts[brand[0]] || 0) + 1;
    const mahalle = nearestMahalle(grid, lat, lon);
    kept.push({ brand: brand[0], lat, lon, id });
    id += 1;
    kept[kept.length - 1].sql =
      "(" +
      kept[kept.length - 1].id +
      "," +
      sqlStr(brand[0]) +
      "," +
      sqlStr(label) +
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
      ")";
  }
  const rows = kept.map((place) => place.sql);
  const marker = "\n-- dalga 2\n";
  let head = fs.readFileSync(seedPath, "utf8");
  const at = head.indexOf(marker);
  if (at >= 0) head = head.slice(0, at);
  if (!head.endsWith("\n")) head += "\n";
  const block =
    marker +
    "INSERT INTO chain_branches (id, brand_id, name, name_folded, category, address_place_id, latitude, longitude) VALUES\n" +
    rows.join(",\n") +
    "\nON CONFLICT (id) DO UPDATE SET brand_id = EXCLUDED.brand_id, name = EXCLUDED.name, name_folded = EXCLUDED.name_folded, category = EXCLUDED.category, address_place_id = EXCLUDED.address_place_id, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude;\n";
  fs.writeFileSync(seedPath, head + block);
  console.log(JSON.stringify({ toplam: rows.length, counts }));
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
