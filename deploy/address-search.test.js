const test = require("node:test");
const assert = require("node:assert/strict");
const { fold, tokensOf, rankRows, searchAddress } = require("./address-search");

test("fold folds Turkish letters", () => {
  assert.equal(fold("Kadıköy, Çankaya"), "kadikoy cankaya");
});

test("street words are not search tokens", () => {
  assert.deepEqual(tokensOf("Ataevler Mahallesi Nilüfer"), ["ataevler", "nilufer"]);
});

test("Kadıköy stays inside İstanbul", () => {
  const rows = [
    {
      name: "Kadıköy",
      level: 2,
      latitude: 40.99,
      longitude: 29.02,
      name_folded: "kadikoy",
      parent_name: "İstanbul",
      parent_folded: "istanbul",
      grand_name: null,
      grand_folded: null,
    },
    {
      name: "Kadıköy",
      level: 2,
      latitude: 40.6,
      longitude: 30.1,
      name_folded: "kadikoy",
      parent_name: "Sakarya",
      parent_folded: "sakarya",
      grand_name: null,
      grand_folded: null,
    },
  ];
  const found = rankRows(rows, tokensOf("Kadıköy İstanbul"), null);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "Kadıköy, İstanbul");
});

test("a street keeps its province through the neighbourhood", () => {
  const rows = [
    {
      name: "Çam Sokak",
      level: 4,
      latitude: 40.99,
      longitude: 29.03,
      name_folded: "cam",
      parent_name: "Caferağa",
      parent_folded: "caferaga",
      grand_name: "Kadıköy",
      grand_folded: "kadikoy",
      great_name: "İstanbul",
      great_folded: "istanbul",
    },
  ];
  const found = rankRows(rows, tokensOf("Çam Sokak İstanbul"), null);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, "Çam Sokak, Caferağa, Kadıköy, İstanbul");
});

test("a nearer exact district ranks first", () => {
  const rows = [
    {
      name: "Merkez",
      level: 2,
      latitude: 41.0,
      longitude: 29.0,
      name_folded: "merkez",
      parent_name: "İstanbul",
      parent_folded: "istanbul",
      grand_name: null,
      grand_folded: null,
    },
    {
      name: "Merkez",
      level: 2,
      latitude: 39.7,
      longitude: 30.5,
      name_folded: "merkez",
      parent_name: "Eskişehir",
      parent_folded: "eskisehir",
      grand_name: null,
      grand_folded: null,
    },
  ];
  const found = rankRows(rows, ["merkez"], { lat: 39.77, lon: 30.52 });
  assert.equal(found[0].name, "Merkez, Eskişehir");
});

test("a chain branch keeps its neighbourhood and district", async () => {
  let chainSql = "";
  const pool = {
    async query(sql) {
      const text = String(sql);
      if (text.includes("chain_branches")) {
        chainSql = text;
        return {
          rows: [
            {
              name: "McDonald's",
              level: 5,
              latitude: 39.78,
              longitude: 30.5,
              name_folded: "mcdonald s",
              parent_name: "ESKİBAĞLAR MAH.(MERKEZ)",
              parent_folded: "eskibaglar",
              grand_name: "Tepebaşı",
              grand_folded: "tepebasi",
              great_name: "Eskişehir",
              great_folded: "eskisehir",
            },
          ],
        };
      }
      return { rows: [] };
    },
  };
  const found = await searchAddress(
    pool,
    new URL("http://local/api/address?q=mcd&lat=39.77&lon=30.52"),
  );
  assert.match(chainSql, /address_place_id/);
  assert.equal(
    found[0].name,
    "McDonald's, Eskibağlar Mahallesi, Tepebaşı, Eskişehir",
  );
});

test("a nearby market query returns branches inside the radius", async () => {
  const pool = {
    async query(sql) {
      if (String(sql).includes("chain_branches")) {
        return {
          rows: [
            { name: "Şok", category: "market", latitude: 41.01, longitude: 29.01 },
            { name: "Uzak Migros", category: "market", latitude: 36.9, longitude: 30.7 },
          ],
        };
      }
      return { rows: [] };
    },
  };
  const found = await searchAddress(
    pool,
    new URL("http://local/api/address?q=market&lat=41.01&lon=29.02&radius=18000"),
  );
  assert.deepEqual(
    found.map((row) => row.name),
    ["Şok"],
  );
  assert.equal(found[0].level, "market");
});
