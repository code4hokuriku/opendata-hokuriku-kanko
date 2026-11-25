import { assertEquals } from "@std/assert";
import {
  ageToGroup,
  derive,
  incomeGroup,
  nights,
  npsCategory,
  parseDate,
  regionOf,
  revisitGroup,
  score,
  yen,
} from "../src/normalize.ts";
import { row } from "./fixture.ts";

Deno.test("日時: 時の1桁表記・日付のみ・不正値", () => {
  assertEquals(parseDate("2023/12/31 9:46:58", false), {
    at: "2023-12-31T09:46:58",
    date: "2023-12-31",
    year: 2023,
    month: "2023-12",
    dow: 7,
    hour: 9,
  });
  const d = parseDate("2025/05/05 00:00:00", true)!;
  assertEquals([d.at, d.hour, d.dow], ["2025-05-05", null, 1]);
  assertEquals(parseDate("2025/02/30 00:00:00", false), null);
  assertEquals(parseDate("", false), null);
});

Deno.test("世帯年収: 3県の区分を統合", () => {
  assertEquals(incomeGroup("100万円未満"), "1:300万円未満");
  assertEquals(incomeGroup("200万円以上 300万円未満"), "1:300万円未満");
  assertEquals(incomeGroup("1:300万未満"), "1:300万円未満");
  assertEquals(incomeGroup("2:300～500万円"), "2:300-600万円未満");
  assertEquals(incomeGroup("500万円以上 600万円未満"), "2:300-600万円未満");
  assertEquals(incomeGroup("3: 600〜1000万円"), "3:600-1000万円未満");
  assertEquals(incomeGroup("900万円以上 1,000万円未満"), "3:600-1000万円未満");
  assertEquals(incomeGroup("1,500万円以上"), "4:1000万円以上");
  assertEquals(incomeGroup("5:2000万円以上"), "4:1000万円以上");
  assertEquals(incomeGroup("6:無回答"), "無回答");
  assertEquals(incomeGroup("分からない/無回答"), "無回答");
  assertEquals(incomeGroup(""), null);
});

Deno.test("金額・泊数・点数など", () => {
  assertEquals(yen("5,000円以上 10,000円未満"), 7500);
  assertEquals(yen("1,000円未満"), 500);
  assertEquals(yen("100,000円以上 "), 100000);
  assertEquals(yen("使わない"), 0);
  assertEquals(yen(""), null);
  assertEquals(nights("4泊以上"), 4);
  assertEquals(nights("日帰り"), 0);
  assertEquals(nights("福井県内には宿泊しない"), 0);
  assertEquals(nights(""), null);
  assertEquals(score("10 (ぜひ薦めたい)", 0, 10), 10);
  assertEquals(score("自家用車", 1, 5), null);
  assertEquals(score("6", 1, 5), null);
  assertEquals([9, 8, 7, 6, null].map(npsCategory), [
    "推奨者",
    "中立者",
    "中立者",
    "批判者",
    null,
  ]);
  assertEquals(revisitGroup("また行きたい（１年以内）"), "また行きたい");
  assertEquals(revisitGroup("福井県在住"), "在住者");
  assertEquals(regionOf("岐阜県"), "東海");
  assertEquals([9, 10, 79, 80].map(ageToGroup), ["10歳未満", "10代", "70代", "80歳以上"]);
});

Deno.test("年代: 石川は生年から算出し、福井は元の値を使う", () => {
  const i = derive(row({ "対象県（富山/石川/福井）": "石川", "年代": "1971", "生まれ年": "1971" }));
  assertEquals([i.age, i.age_group], [54, "50代"]);
  const f = derive(row({ "年代": "40代", "回答時の年齢": "45" }));
  assertEquals([f.age, f.age_group], [45, "40代"]);
});
