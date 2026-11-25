import { assertEquals, assertRejects } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { importCsv } from "../src/import.ts";
import { csvText, pastCsv, row } from "./fixture.ts";

async function setup(past: string, merged = csvText([row()])) {
  const d = await Deno.makeTempDir();
  for (const x of ["csv", "past"]) await Deno.mkdir(`${d}/${x}`);
  await Deno.writeTextFile(`${d}/csv/merged_survey_2023.csv`, merged);
  await Deno.writeTextFile(`${d}/past/2022.csv`, past);
  // 統合CSVに含まれる年度のファイルは読まない
  await Deno.writeTextFile(`${d}/past/2023.csv`, past);
  return {
    run: () => importCsv(`${d}/csv`, `${d}/s.db`, { pastDir: `${d}/past` }),
    open: () => new DatabaseSync(`${d}/s.db`, { readOnly: true }),
  };
}

Deno.test("過去データを126列に変換して取り込む", async () => {
  const t = await setup(pastCsv(1, { "満足度の理由": "景色が\nよい" }));
  const r = await t.run();
  assertEquals([r.rows, r.skipped], [2, []]);
  const db = t.open();
  const x = db.prepare("SELECT * FROM survey WHERE source_year = 2022").get()!;
  const pick = (...c: string[]) => c.map((n) => x[n]);
  assertEquals(pick("source_file", "source_row", "prefecture", "answered_at", "会員ID"), [
    "fukui_fiscalyearly_2022.csv",
    1,
    "福井",
    "2022-05-03T09:08:07",
    "000000",
  ]);
  assertEquals(pick("アンケート回答日", "目的", "登録エリア", "満足度理由"), [
    "2022/05/03 09:08:07",
    "温泉や露天風呂地元の美味しいものを食べる",
    "web",
    "景色が\nよい",
  ]);
  assertEquals(
    pick("温泉や露天風呂", "名所、旧跡の観光", "X（旧Twitter）", "観光案内所", "その他"),
    [
      1,
      0,
      1,
      1,
      0,
    ],
  );
  assertEquals(pick("新幹線", "在来線", "自家用車", "徒歩"), [1, 1, 0, 1]);
  assertEquals(pick("sat_trip", "sat_service", "sat_transport", "recommend", "age", "is_local"), [
    5,
    null, // 2022年度は設問なし
    null, // 「選択肢なし」
    9,
    52,
    1,
  ]);
  assertEquals(x["交通の満足度"], "選択肢なし");
  db.close();
});

Deno.test("統合CSVに同じ期間の福井があれば二重計上しない", async () => {
  const t = await setup(
    pastCsv(3),
    csvText([row({ "アンケート回答日": "2022/05/03 09:08:07" })]),
  );
  const r = await t.run();
  assertEquals([r.rows, r.skipped], [1, ["fukui_fiscalyearly_2022.csv"]]);
});

Deno.test("過去データの範囲外の日付や列の欠落はエラー", async () => {
  const late = await setup(pastCsv(1, { "回答日時": "2023-04-01 00:00:00" }));
  await assertRejects(late.run, Error, "重複します");
  const missing = await setup(pastCsv(1).replace("都道府県", "都道府県名"));
  await assertRejects(missing.run, Error, "都道府県");
});
