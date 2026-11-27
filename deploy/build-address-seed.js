const fs = require("fs");

function load(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
}

function fold(value) {
  return String(value)
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

function sqlStr(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

const cities = load(process.argv[2]);
const iller = load(process.argv[3]);
const by = new Map();
for (const il of iller) {
  by.set(fold(il.il_adi).replace(/ /g, ""), il);
}

const provinces = [];
const seen = new Set();
for (const row of cities) {
  if (seen.has(row.il)) continue;
  seen.add(row.il);
  const key = fold(row.il).replace(/ /g, "");
  const meta = [...by.entries()].find(
    ([name]) => name === key || name.startsWith(key) || key.startsWith(name),
  );
  if (!meta) throw new Error("il yok: " + row.il);
  provinces.push({
    name: row.il,
    plate: Number(meta[1].plaka),
    lat: Number(meta[1].lat),
    lon: Number(meta[1].lon),
    folded: fold(row.il),
  });
}
provinces.sort((a, b) => a.plate - b.plate);
if (provinces.length !== 81) {
  throw new Error("il sayisi " + provinces.length);
}

const parent = new Map(provinces.map((item) => [item.name, item.plate]));
const lines = [];
const dup = new Set();
let id = 1000;
for (const row of cities) {
  const folded = fold(row.ilce);
  const key = row.il + "|" + folded;
  if (dup.has(key)) throw new Error("tekrar: " + key);
  dup.add(key);
  const lat = Number(row.lat);
  const lon = Number(row.lon);
  if (!(lat >= 35 && lat <= 43 && lon >= 25 && lon <= 46)) {
    throw new Error("kutu disi: " + row.ilce);
  }
  lines.push(
    "(" +
      id +
      "," +
      parent.get(row.il) +
      ",2," +
      sqlStr(row.ilce) +
      "," +
      sqlStr(folded) +
      ",NULL," +
      lat.toFixed(6) +
      "," +
      lon.toFixed(6) +
      ")",
  );
  id += 1;
}

const provLines = provinces.map(
  (item) =>
    "(" +
    item.plate +
    ",NULL,1," +
    sqlStr(item.name) +
    "," +
    sqlStr(item.folded) +
    "," +
    item.plate +
    "," +
    item.lat.toFixed(6) +
    "," +
    item.lon.toFixed(6) +
    ")",
);

const out =
  "-- Il ve ilce tohumu. Hesap tablolarina dokunmaz.\n" +
  "-- Il merkezleri acik il listesinden, ilce noktalari acik OSM turevi listeden.\n" +
  "-- Mahalle ve sokak bu dosyada yoktur. Onlarin kimligi 100000 ve sonrasidir.\n" +
  "INSERT INTO address_places (id, parent_id, level, name, name_folded, plate, latitude, longitude) VALUES\n" +
  provLines.concat(lines).join(",\n") +
  "\nON CONFLICT (id) DO UPDATE SET parent_id = EXCLUDED.parent_id, level = EXCLUDED.level, name = EXCLUDED.name, name_folded = EXCLUDED.name_folded, plate = EXCLUDED.plate, latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude;\n";

fs.writeFileSync(process.argv[4], out);
console.log("rows", provLines.length + lines.length, "bytes", out.length);
