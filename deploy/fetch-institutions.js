const fs = require("fs");
const https = require("https");
const path = require("path");
const { fold } = require("./address-search");

function queryFor(south, west, north, east) {
  const box = `${south},${west},${north},${east}`;
  return `
[out:json][timeout:40];
(
  nwr["amenity"="courthouse"]["name"](${box});
  nwr["amenity"="university"]["name"](${box});
  nwr["amenity"="townhall"]["name"](${box});
  nwr["amenity"="hospital"]["name"~"Devlet Hastanesi|Egitim ve Arastirma|Eğitim ve Araştırma"](${box});
  nwr["name"~"Vergi Dairesi"](${box});
  nwr["office"="government"]["name"~"Nüfus|Nufus|Kaymakamlık|Kaymakamlik|Valilik|Sosyal Güvenlik|Emniyet Müdür"](${box});
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
    req.setTimeout(150000, () => req.destroy(new Error("timeout")));
    req.end(body);
  });
}

function categoryOf(tags) {
  const name = tags.name || "";
  const folded = fold(name);
  if (folded.includes("vergi dairesi")) return "vergi";
  if (tags.amenity === "courthouse" || folded.includes("adliye")) return "adliye";
  if (tags.amenity === "university") return "universite";
  if (tags.amenity === "hospital") return "hastane";
  if (tags.amenity === "townhall" || folded.includes("belediye")) return "belediye";
  if (folded.includes("nufus")) return "nufus";
  if (folded.includes("kaymakamlik")) return "kaymakamlik";
  if (folded.includes("valilik")) return "valilik";
  if (folded.includes("sosyal guvenlik") || folded.includes("sgk")) return "sgk";
  if (folded.includes("emniyet")) return "emniyet";
  return null;
}

function sqlStr(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

async function main() {
  const url = process.argv[2] || "https://www.piaroute.com/overpass/api/interpreter";
  const elements = [];
  for (let south = 36; south < 42.5; south += 2) {
    for (let west = 26; west < 45; west += 2.5) {
      const response = await post(url, queryFor(south, west, south + 2, west + 2.5));
      if (response.status !== 200) {
        console.error("kutu", south, west, response.status);
        continue;
      }
      const data = JSON.parse(response.body);
      elements.push(...(data.elements || []));
      console.log("kutu", south, west, (data.elements || []).length);
    }
  }
  const seen = new Set();
  const rows = [];
  let id = 1;
  for (const element of elements) {
    const tags = element.tags || {};
    const name = String(tags.name || "").replace(/\s+/g, " ").trim();
    const category = categoryOf(tags);
    const lat = element.lat || (element.center && element.center.lat);
    const lon = element.lon || (element.center && element.center.lon);
    if (!name || !category || !Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    if (lat < 35 || lat > 43 || lon < 25 || lon > 46) continue;
    const folded = fold(name);
    const key = category + "|" + folded + "|" + lat.toFixed(3) + "|" + lon.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    const city = tags["addr:city"] || tags["addr:province"] || "";
    rows.push(
      "(" +
        id +
        "," +
        sqlStr(name) +
        "," +
        sqlStr(folded) +
        "," +
        sqlStr(category) +
        "," +
        sqlStr(fold(city)) +
        "," +
        Number(lat).toFixed(6) +
        "," +
        Number(lon).toFixed(6) +
        ")",
    );
    id += 1;
  }
  const out =
    "-- Kamuya acik kurumlar. OpenStreetMap merkez noktalari.\n" +
    "INSERT INTO public_institutions (id, name, name_folded, category, city_folded, latitude, longitude) VALUES\n" +
    rows.join(",\n") +
    "\nON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, name_folded = EXCLUDED.name_folded, category = EXCLUDED.category, city_folded = EXCLUDED.city_folded, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude;\n";
  const dest = path.join(__dirname, "..", "sql", "institutions_seed.sql");
  fs.writeFileSync(dest, out);
  console.log("kurum", rows.length);
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
