import { stringify } from "@std/csv";
import { FLAG_COLUMNS, RAW_COLUMNS } from "../src/columns.ts";

/** 既定値(福井・2025年)に上書きした1行 */
export function row(o: Record<string, string> = {}): Record<string, string> {
  const r: Record<string, string> = Object.fromEntries(RAW_COLUMNS.map((c) => [c, ""]));
  for (const f of FLAG_COLUMNS) r[f] = "0";
  return Object.assign(r, {
    "対象県（富山/石川/福井）": "福井",
    "アンケート回答日": "2025/05/04 12:00:00",
    "居住都道府県": "愛知県",
    "性別": "女",
    "年代": "40代",
    "回答時の年齢": "45",
    "目的": "温泉や露天風呂",
    "情報源": "友人・知人",
    "宿泊費": "使わない",
    "おすすめ度": "10",
  }, o);
}

export function csvText(rows: Record<string, string>[], header = RAW_COLUMNS): string {
  return stringify([header, ...rows.map((r) => RAW_COLUMNS.map((c) => r[c]))]);
}

const PAST_BASE: Record<string, string> = {
  "会員ID": "123456",
  "登録施設": "web",
  "性別": "女",
  "生まれ年": "1970",
  "回答時の年齢": "52",
  "年代": "50代",
  "都道府県": "福井県",
  "世帯年収": "100万円未満",
  "回答日時": "2022-05-03 09:08:07",
  "回答月": "5月",
  "回答エリア": "福井駅前 エリア",
  "回答エリア2": "04.福井駅前 エリア",
  "DMO": "",
  "宿泊数（全体）": "日帰り",
  "宿泊数（県内）": "福井県内には宿泊しない",
  "宿泊エリア（県外）": "福井県外には宿泊しない",
  "同行者": "自分ひとり",
  "訪問目的ALL": "温泉や露天風呂\n地元の美味しいものを食べる\n",
  "情報収集ALL": "Twitter\n観光協会等の案内所\n",
  "福井県までの交通手段ALL": "新幹線\n在来線\n",
  "福井県内での交通手段ALL": "徒歩\n",
  "福井県内での交通手段の満足度": "選択肢なし",
  "福井県内での交通手段の満足度の理由": "",
  "宿泊費": "使わない",
  "交通費": "1,000円未満",
  "県内消費額": "1,000円以上 3,000円未満",
  "エリア訪問回数": "初めて",
  "アンケート回答前に訪問した主な場所": "丸岡城",
  "アンケート回答前に訪問した主な場所FA": "",
  "アンケート回答後に訪問する予定の主な場所": "",
  "エリア総消費額": "1,000円未満",
  "満足度": "とても満足",
  "満足度の理由": "景色が\nよい",
  "NPS": "9",
  "推奨項目": "",
  "今後の来訪意向": "福井県在住",
};

/** 福井県の年度別CSV(2022年度形式、BOM付き) */
export function pastCsv(n: number, o: Record<string, string> = {}): string {
  const rows = Array.from(
    { length: n },
    (_, i) => ({ ...PAST_BASE, "満足度の理由": `理由${i}`, ...o }),
  );
  return "\uFEFF" + stringify([Object.keys(PAST_BASE), ...rows.map((r) => Object.values(r))]);
}
