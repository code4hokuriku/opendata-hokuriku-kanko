import { assert, assertEquals, assertRejects } from "@std/assert";
import { importCsv } from "../src/import.ts";
import { createHandler } from "../src/server.ts";
import { RAW_COLUMNS } from "../src/columns.ts";
import { csvText, row } from "./fixture.ts";

const dir = await Deno.makeTempDir();
const P = "対象県（富山/石川/福井）";
const fukui = row({ "温泉や露天風呂": "1", "自由意見": '駐車場が\n狭い、Wi-Fiも"遅い"' });
await Deno.writeTextFile(
  `${dir}/merged_survey_2025.csv`,
  csvText([
    fukui,
    fukui, // 完全重複
    row({ "おすすめ度": "5", "性別": "男", "名所、旧跡の観光": "1" }),
    row({
      [P]: "石川",
      "年代": "1971",
      "生まれ年": "1971",
      "おすすめ度": "8",
      "名所、旧跡の観光": "1",
    }),
    row({
      [P]: "富山",
      "アンケート回答日": "2025/06/01 00:00:00",
      "おすすめ度": "9",
      "性別": "その他",
    }),
  ]),
);
const dbPath = `${dir}/db/survey.db`;
const imported = await importCsv(dir, dbPath);
const { handler } = createHandler(dbPath, { sqlTimeoutMs: 1500 });

async function get(path: string, status = 200) {
  const r = await handler(new Request("http://x" + encodeURI(path)));
  const text = await r.text();
  assertEquals(r.status, status, text);
  return r.headers.get("content-type")!.includes("json") ? JSON.parse(text) : text;
}
async function post(body: unknown, status = 200) {
  const r = await handler(
    new Request("http://x/api/sql", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const j = await r.json();
  assertEquals(r.status, status, JSON.stringify(j));
  return j;
}

Deno.test("取り込み件数と重複", async () => {
  assertEquals([imported.rows, imported.duplicates, imported.comments], [5, 1, 2]);
  const m = await get("/api/meta");
  assertEquals(m.total, 5);
});

Deno.test("ヘッダーが違うCSVは拒否し、既存DBは残る", async () => {
  const d = await Deno.makeTempDir();
  const h = [...RAW_COLUMNS];
  h[5] = "新しい列";
  await Deno.writeTextFile(`${d}/merged_survey_2025.csv`, csvText([row()], h));
  await assertRejects(() => importCsv(d, dbPath), Error, "新しい列");
  assertEquals((await get("/api/meta")).total, 5);
});

Deno.test("responses: 絞り込み・列選択・ページング・並べ替え", async () => {
  const r = await get("/api/responses?gender=女&prefecture=福井&fields=id,gender&limit=1");
  assertEquals([r.total, r.rows], [2, [{ id: 1, gender: "女" }]]);
  const s = await get("/api/responses?gender=男&gender=その他&fields=id&sort=-id");
  assertEquals(s.rows.map((x: { id: number }) => x.id), [5, 3]);
  assertEquals((await get("/api/responses?recommend__lte=8&fields=id")).total, 2);
  assertEquals((await get("/api/responses?from=2025-06-01&fields=id")).total, 1);
  assertEquals((await get("/api/responses?自由意見__like=駐車場&fields=id")).total, 2);
  assertEquals((await get("/api/responses?age__null=true&fields=id")).total, 1);
  assertEquals((await get("/api/responses?is_duplicate=0&fields=id")).total, 4);
});

Deno.test("aggregate: 指標・構成比・CSV", async () => {
  const r = await get("/api/aggregate?by=prefecture&metrics=count,nps,avg:recommend&sort=-count");
  assertEquals(r.rows[0], {
    prefecture: "福井",
    count: 3,
    nps: 33.33,
    n_nps: 3,
    avg_recommend: 8.333,
    n_recommend: 3,
  });
  const s = await get("/api/aggregate?by=prefecture,gender&share_by=prefecture&prefecture=福井");
  assertEquals(s.rows.map((x: { share: number }) => x.share), [0.6667, 0.3333]);
  const c = await get("/api/aggregate?by=prefecture&format=csv&sort=-count");
  assert(c.includes("prefecture,count\r\n福井,3\r\n"));
});

Deno.test("フラグの割合は未設問の県を分母から除く", async () => {
  // 名所観光: 福井1/3 + 石川1/1。富山は選択肢がないので除外
  const r = await get("/api/aggregate?metrics=rate:名所、旧跡の観光");
  assertEquals(r.rows[0], { "rate_名所、旧跡の観光": 0.5, "n_名所、旧跡の観光": 4 });
  const f = await get("/api/flags?group=purpose&by=prefecture&prefecture=富山");
  assert(!f.rows.some((x: { flag: string }) => x.flag === "名所、旧跡の観光"));
  const g = await get("/api/flags?group=purpose");
  const x = g.rows.find((x: { flag: string }) => x.flag === "温泉や露天風呂");
  assertEquals(x, { flag: "温泉や露天風呂", count: 2, n: 5, rate: 0.4 });
});

Deno.test("comments: 複数語AND・属性での絞り込み", async () => {
  assertEquals((await get("/api/comments?q=駐車場 wi-fi")).total, 2);
  assertEquals((await get("/api/comments?q=駐車場&prefecture=石川")).total, 0);
  assertEquals((await get("/api/comments?field=自由意見&is_duplicate=0")).total, 1);
  await get("/api/comments?field=性別", 400);
});

Deno.test("comments: 新しい順・古い順", async () => {
  const d = await Deno.makeTempDir();
  const at = (day: string, o = {}) => row({ "アンケート回答日": day, "自由意見": day, ...o });
  // 取り込み順と日時順をずらし、1桁の時・同時刻・複数項目を含める
  await Deno.writeTextFile(
    `${d}/merged_survey_2025.csv`,
    csvText([
      at("2025/05/04 10:00:00"),
      at("2025/05/04 9:00:00"),
      at("2025/12/01 00:00:00", { "推奨項目": "恐竜" }),
      at("2025/05/04 10:00:00"),
    ]),
  );
  await importCsv(d, `${d}/s.db`);
  const { handler, close } = createHandler(`${d}/s.db`);
  const ids = async (query: string) => {
    const r = await handler(new Request(`http://x/api/comments?${query}`));
    assertEquals(r.status, 200);
    const j = await r.json();
    return [j.order, j.rows.map((x: { survey_id: number }) => x.survey_id)];
  };
  assertEquals(await ids("order=newest"), ["newest", [3, 3, 4, 1, 2]]);
  assertEquals(await ids("order=oldest"), ["oldest", [2, 1, 4, 3, 3]]);
  assertEquals(await ids(""), ["oldest", [2, 1, 4, 3, 3]]);
  assertEquals(await ids("order=newest&limit=2&offset=2"), ["newest", [4, 1]]);
  close();
});

Deno.test("columns", async () => {
  const c = await get("/api/columns");
  assertEquals([c.raw.length, c.derived[0].name], [126, "id"]);
  const v = await get("/api/columns/性別?prefecture=福井");
  assertEquals(v.rows, [{ value: "女", count: 2 }, { value: "男", count: 1 }]);
});

Deno.test("不正な入力は400", async () => {
  for (
    const u of [
      "/api/responses?nope=1",
      "/api/responses?fields=nope",
      "/api/responses?sort=id;drop table survey",
      "/api/responses?limit=-1",
      "/api/responses?recommend=abc",
      "/api/responses?recommend__foo=1",
      "/api/responses?from=2025/01/01",
      '/api/aggregate?by=x" FROM survey--',
      "/api/aggregate?metrics=avg:性別",
      "/api/aggregate?metrics=avg:Instagram",
      "/api/aggregate?metrics=foo:recommend",
      "/api/aggregate?by=gender&share_by=prefecture",
      "/api/flags",
      "/api/comments?order=latest",
      "/api/flags?group=constructor",
      "/api/sql",
      "/api/aggregate?format=xml",
    ]
  ) await get(u, 400);
  await get("/api/nope", 404);
  // 値のインジェクションは単なる文字列として扱われる
  assertEquals((await get("/api/responses?gender=' OR 1=1 --&fields=id")).total, 0);
});

Deno.test("sql: 実行・パラメータ・同名列・件数上限", async () => {
  const r = await post({ sql: "SELECT count(*) n FROM survey WHERE gender = ?", params: ["女"] });
  assertEquals(r.rows, [{ n: 3 }]);
  const named = await post({ sql: "SELECT :a AS a", params: { a: 7 } });
  assertEquals(named.rows, [{ a: 7 }]);
  const d = await post({ sql: "-- c\nSELECT 1 AS a, 2 AS a" });
  assertEquals(d.rows, [{ a: 1, a_2: 2 }]);
  const l = await get("/api/sql?sql=SELECT id FROM survey&limit=2");
  assertEquals([l.rows.length, l.truncated], [2, true]);
});

Deno.test("sql: 書き込みや外部ファイルは拒否", async () => {
  for (
    const sql of [
      "DELETE FROM survey",
      "ATTACH '/etc/hosts' AS x",
      "PRAGMA writable_schema=1",
      "WITH a AS (SELECT 1) DELETE FROM survey",
      "SELECT load_extension('x')",
      "SELECT * FROM nope",
    ]
  ) await post({ sql }, 400);
  await post({ sql: "SELECT 1; DELETE FROM survey" }, 400);
  assertEquals((await get("/api/meta")).total, 5);
});

Deno.test("sql: 途中の行で起きたエラーを握りつぶさない", async () => {
  const sql = "SELECT abs(column1) FROM (VALUES (1), (-9223372036854775808), (3))";
  assert((await post({ sql }, 400)).error.includes("overflow"));
});

Deno.test("sql: 末尾のセミコロン・コメント・WITH・EXPLAIN・並び順", async () => {
  assertEquals((await post({ sql: "SELECT id FROM survey ORDER BY id DESC;\n" })).rows[0].id, 5);
  assertEquals((await post({ sql: "WITH a AS (SELECT 1 x) SELECT x FROM a -- end" })).rows, [{
    x: 1,
  }]);
  assert((await post({ sql: "EXPLAIN QUERY PLAN SELECT * FROM survey" })).rows.length > 0);
});

Deno.test("sql: 重いクエリは打ち切り、その間も他のAPIは応答する", async () => {
  const slow = post({
    sql: "WITH RECURSIVE t(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM t) SELECT count(*) FROM t",
  }, 408);
  const t = performance.now();
  await get("/api/meta");
  assert(performance.now() - t < 1000);
  await slow;
});
