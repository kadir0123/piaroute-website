const fs = require("fs");
const https = require("https");
const path = require("path");
const { fold } = require("./address-search");

const seedPath = path.join(__dirname, "..", "sql", "address_seed.sql");
const csvPath = process.argv[2];
const workDir = process.argv[3];

function sqlStr(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function placeFold(value) {
  const bare = String(value).replace(/\([^)]*\)/g, " ");
  return fold(bare)
    .split(" ")
    .filter((word) => !["mah", "mahalle", "mahallesi", "koy", "koyu"].includes(word))
    .join(" ");
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = https.get(url, { headers: { "User-Agent": "piaroute-seed" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        file.close();
        fs.unlink(dest, () => resolve(download(res.headers.location, dest)));
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        file.close();
        fs.unlink(dest, () => reject(new Error(res.statusCode + " " + url)));
        return;
      }
      res.pipe(file);
      file.on("finish", () => file.close(() => resolve()));
    });
    request.on("error", (error) => {
      file.close();
      fs.unlink(dest, () => reject(error));
    });
  });
}

function readLines(file) {
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean);
}

function parseSeed(text) {
  const marker = "\n-- mahalle ve sokak\n";
  const head = text.includes(marker) ? text.slice(0, text.indexOf(marker)) : text;
  const districts = new Map();
  const provinces = new Map();
  const row = /^\((\d+),(NULL|\d+),(\d+),'((?:[^']|'')*)','((?:[^']|'')*)'/;
  for (const line of head.split(/\r?\n/)) {
    const match = row.exec(line.trim().replace(/,\s*$/, "").replace(/\),?$/, ")"));
    if (!match) continue;
    const id = Number(match[1]);
    const parent = match[2] === "NULL" ? null : Number(match[2]);
    const level = Number(match[3]);
    const name = match[4].replace(/''/g, "'");
    const folded = match[5];
    if (level === 1) provinces.set(id, { name, folded });
    if (level === 2 && parent != null) {
      const province = provinces.get(parent);
      if (!province) continue;
      districts.set(province.folded + "|" + folded, id);
    }
  }
  return { head: head.replace(/\s*$/, "\n"), districts, provinces };
}

function parseCsv(file) {
  const lines = readLines(file);
  const rows = [];
  for (const line of lines.slice(1)) {
    const parts = line.split(",");
    if (parts.length < 8) continue;
    rows.push({
      il: parts[1],
      ilce: parts[3],
      mahalle: parts[5],
      lat: Number(parts[6]),
      lon: Number(parts[7]),
    });
  }
  return rows;
}

function inTurkey(lat, lon) {
  return lat >= 35 && lat <= 43 && lon >= 25 && lon <= 46;
}

function tuple(id, parent, level, name, folded, lat, lon) {
  return (
    "(" +
    id +
    "," +
    parent +
    "," +
    level +
    "," +
    sqlStr(name) +
    "," +
    sqlStr(folded) +
    ",NULL," +
    lat.toFixed(6) +
    "," +
    lon.toFixed(6) +
    ")"
  );
}

async function main() {
  const parsed = parseSeed(fs.readFileSync(seedPath, "utf8"));
  parsed.head = parsed.head.replace(
    "-- Mahalle ve sokak bu dosyada yoktur. Onlarin kimligi 100000 ve sonrasidir.\n",
    "-- Mahalle ve sokak bu dosyanin devamindadir. Kimlikleri 100000 ve sonrasidir.\n",
  );
  const mahalle = new Map();
  const seenMahalle = new Set();
  let id = 100000;
  let skippedCoord = 0;
  let skippedDistrict = 0;
  const missingDistrict = new Set();
  const mahalleRows = [];
  for (const row of parseCsv(csvPath)) {
    if (!inTurkey(row.lat, row.lon)) {
      skippedCoord++;
      continue;
    }
    const il = fold(row.il);
    let ilce = placeFold(row.ilce);
    if (ilce === "kahramankazan") ilce = "kazan";
    let districtId = parsed.districts.get(il + "|" + ilce);
    if (!districtId && ilce === "merkez") {
      districtId = parsed.districts.get(il + "|" + il);
      ilce = il;
    }
    if (!districtId) {
      skippedDistrict++;
      missingDistrict.add(il + "|" + placeFold(row.ilce));
      continue;
    }
    const nameFold = placeFold(row.mahalle);
    if (!nameFold) continue;
    const key = il + "|" + ilce + "|" + nameFold;
    if (seenMahalle.has(districtId + "|" + nameFold)) continue;
    seenMahalle.add(districtId + "|" + nameFold);
    const placeId = id++;
    mahalle.set(key, { id: placeId, lat: row.lat, lon: row.lon, districtId });
    mahalleRows.push(tuple(placeId, districtId, 3, row.mahalle.replace(/\s+/g, " ").trim(), nameFold, row.lat, row.lon));
  }

  const out = fs.createWriteStream(seedPath, { flags: "w" });
  out.write(parsed.head);
  out.write("\n-- mahalle ve sokak\n");
  out.write("-- Mahalle noktasi acik koordinat listesinden.\n");
  out.write("-- Sokak adinin ayri geometrisi yok; noktasi bagli oldugu mahallenin merkezidir.\n");

  function writeInsert(rows) {
    if (!rows.length) return;
    out.write(
      "INSERT INTO address_places (id, parent_id, level, name, name_folded, plate, latitude, longitude) VALUES\n",
    );
    out.write(rows.join(",\n"));
    out.write(
      "\nON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id, level = EXCLUDED.level, name = EXCLUDED.name, name_folded = EXCLUDED.name_folded, plate = EXCLUDED.plate, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude;\n",
    );
  }

  console.log("eksik ilce", missingDistrict.size, [...missingDistrict].slice(0, 25).join(", "));
  if (missingDistrict.size > 40) throw new Error("ilce eslesmesi zayif");

  for (let i = 0; i < mahalleRows.length; i += 2000) {
    writeInsert(mahalleRows.slice(i, i + 2000));
  }

  let streets = 0;
  let skippedStreet = 0;
  const seenStreet = new Set();
  const batch = [];
  function flush() {
    if (!batch.length) return;
    writeInsert(batch.splice(0, batch.length));
  }

  for (let plate = 1; plate <= 81; plate++) {
    const province = parsed.provinces.get(plate);
    if (!province) throw new Error("il yok: " + plate);
    const base =
      "https://raw.githubusercontent.com/onurusluca/turkey-geo-api/main/data/jsonl/province-" +
      plate +
      "/";
    const districtFile = path.join(workDir, "d-" + plate + ".jsonl");
    const neighborhoodFile = path.join(workDir, "n-" + plate + ".jsonl");
    const streetFile = path.join(workDir, "s-" + plate + ".jsonl");
    await download(base + "districts.jsonl", districtFile);
    await download(base + "neighborhoods.jsonl", neighborhoodFile);
    await download(base + "streets.jsonl", streetFile);
    const districtName = new Map();
    for (const line of readLines(districtFile)) {
      const row = JSON.parse(line);
      districtName.set(row.id, placeFold(row.name));
    }
    const neighborhood = new Map();
    for (const line of readLines(neighborhoodFile)) {
      const row = JSON.parse(line);
      let ilce = districtName.get(row.district_id);
      if (!ilce) continue;
      if (ilce === "kahramankazan") ilce = "kazan";
      let districtKey = province.folded + "|" + ilce;
      let ilceFold = ilce;
      if (!parsed.districts.has(districtKey) && ilce === "merkez") {
        districtKey = province.folded + "|" + province.folded;
        ilceFold = province.folded;
      }
      const nameFold = placeFold(row.name);
      const hit = mahalle.get(province.folded + "|" + ilceFold + "|" + nameFold);
      if (hit) neighborhood.set(row.id, hit);
    }
    for (const line of readLines(streetFile)) {
      const row = JSON.parse(line);
      const parent = neighborhood.get(row.neighborhood_id);
      if (!parent) {
        skippedStreet++;
        continue;
      }
      const nameFold = placeFold(row.name);
      if (!nameFold) continue;
      const unique = parent.id + "|" + nameFold;
      if (seenStreet.has(unique)) continue;
      seenStreet.add(unique);
      const type = /\(([^)]+)\)/.exec(row.full_official_name || "");
      const display = type ? row.name + " " + type[1] : row.name;
      batch.push(tuple(id++, parent.id, 4, display, nameFold, parent.lat, parent.lon));
      streets++;
      if (batch.length >= 2000) flush();
    }
    fs.unlinkSync(districtFile);
    fs.unlinkSync(neighborhoodFile);
    fs.unlinkSync(streetFile);
    console.log("il", plate, "sokak", streets);
  }
  flush();
  await new Promise((resolve) => out.end(resolve));
  console.log(
    JSON.stringify({
      mahalle: mahalleRows.length,
      skippedCoord,
      skippedDistrict,
      streets,
      skippedStreet,
      lastId: id - 1,
    }),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
