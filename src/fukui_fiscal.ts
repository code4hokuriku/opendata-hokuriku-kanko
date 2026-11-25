/**
 * 福井県(FTAS)の年度別CSVを、統合CSVと同じ126列に変換する。
 * 規則は統合CSVを作っている hokuriku-inbound-kanko/opendata の convert_fukui.py と
 * column_mapping_fukui.json に合わせており、既存の福井データと同じ基準で比較できる。
 */
import { RAW_COLUMNS } from "./columns.ts";

/** 統合CSVに含まれない年度。2023年度以降は統合CSV側に入っている */
export const PAST_FILES = ["2022.csv"];
/** 統合CSVの福井データの開始より前かどうかの境目(2022年度末の翌日) */
export const PAST_END = "2023-04-01";

/** 126列のうち、値を写す列 → 年度別CSVの列(候補を順に探す) */
const COPY: Record<string, string[]> = {
  "居住都道府県": ["都道府県"],
  "性別": ["性別"],
  "年代": ["年代"],
  "世帯年収": ["世帯年収"],
  "同伴者": ["同行者"],
  "宿泊数（全行程）": ["宿泊数（全体）"],
  "宿泊エリア（県外）": ["宿泊エリア（県外）"],
  "宿泊数（県内）": ["宿泊数（県内）"],
  "交通手段１（目的地まで）": ["福井県までの交通手段ALL"],
  "交通手段２（目的地から）": ["福井県内での交通手段ALL"],
  "交通の満足度の理由": ["福井県内での交通手段の満足度の理由"],
  "エリアへの訪問回数": ["エリア訪問回数"],
  "施設への訪問回数": ["エリア訪問回数"],
  "目的": ["訪問目的ALL"],
  "情報源": ["情報収集ALL"],
  "交通費": ["交通費"],
  "宿泊費": ["宿泊費"],
  "施設orエリア消費総額": ["エリア総消費額"],
  "観光費": ["県内消費額"],
  "満足度理由": ["満足度の理由"],
  "おすすめ度": ["NPS"],
  "再訪意向": ["今後の来訪意向"],
  "回答場所": ["回答エリア"],
  "アンケート前に訪れた主な場所（施設やスポット名称、エリアなど）": [
    "アンケート回答前に訪問した主な場所",
  ],
  "上記名称リストにない場合について、具体的にお答えください。(前)": [
    "アンケート回答前に訪問した主な場所FA",
  ],
  "アンケート後に訪れる予定の場所（施設やスポット名称、エリア）": [
    "アンケート回答後に訪問する予定の主な場所",
  ],
  "登録エリア": ["登録エリア", "登録施設"], // 2022年度は「登録施設」
  "生まれ年": ["生まれ年"],
  "回答時の年齢": ["回答時の年齢"],
  "回答月": ["回答月"],
  "回答エリア2": ["回答エリア2"],
  "DMO": ["DMO"],
  "推奨項目": ["推奨項目"],
};

/** 5段階の言葉を数値にする列 */
const SATISFACTION: Record<string, string> = {
  "交通の満足度": "福井県内での交通手段の満足度",
  "満足度（旅行全体）": "満足度",
  "満足度（商品・サービス）": "満足度(商品・サービス)", // 2022年度は設問なし
};
const SCORES: Record<string, string> = {
  "とても満足": "5",
  "満足": "4",
  "どちらでもない": "3",
  "不満": "2",
  "とても不満": "1",
};

/** 設問自体がない年度があってよい列 */
const OPTIONAL = new Set(["満足度(商品・サービス)"]);

/** フラグ → 元の複数回答に含まれていれば1とする語(省略時はフラグ名そのもの) */
const FLAG_WORDS: Record<string, string[]> = {
  "その他の目的": ["その他"],
  "X（旧Twitter）": ["X（旧Twitter）", "X(旧：Twitter)", "Twitter"],
  "YouTube": ["YouTube", "YOUTUBE"],
  "インターネット・アプリ": ["インターネット・アプリ", "蜃気楼マラソン公式ページ"],
  "デジタルニュース": ["デジタルニュースサイト"],
  "宿泊予約Webサイト": ["宿泊予約Webサイト", "OTA"],
  "新聞・雑誌・ガイドブック": ["新聞", "雑誌", "ガイドブック"],
  "友人・知人": ["友人", "知人"],
  "地元の人": ["タクシードライバー", "地元の人"],
  "観光パンフレット・ポスター": ["観光パンフレット", "ポスター"],
  "観光案内所": ["観光案内所", "観光協会等の案内所"],
  "観光展・物産展": ["観光展", "物産展"],
};

/** フラグのグループは columns.ts の FLAG_GROUPS を渡す(循環を避け、純粋な変換にするため) */
export interface FlagSource {
  source: string;
  flags: string[];
}

/** 必要な列が揃っているか。欠けていれば列名を返す */
export function missingColumns(header: string[]): string[] {
  const need = [
    "会員ID",
    "回答日時",
    ...Object.values(COPY).map((c) => c.find((x) => header.includes(x)) ?? c[0]),
    ...Object.values(SATISFACTION).filter((c) => !OPTIONAL.has(c)),
  ];
  return need.filter((c) => !header.includes(c));
}

export function convertFukui(
  r: Record<string, string>,
  groups: FlagSource[],
): Record<string, string> {
  const out: Record<string, string> = Object.fromEntries(RAW_COLUMNS.map((c) => [c, ""]));
  for (const [to, from] of Object.entries(COPY)) {
    out[to] = r[from.find((c) => c in r)!];
  }
  // 選択肢は改行区切りだが、統合CSVでは改行を除いて連結されているので揃える
  for (const g of groups) out[g.source] = out[g.source].replaceAll("\n", "");

  for (const [to, from] of Object.entries(SATISFACTION)) {
    const v = (r[from] ?? "").trim();
    out[to] = SCORES[v] ?? v;
  }
  for (const g of groups) {
    const text = out[g.source];
    let any = false;
    for (const f of g.flags) {
      if (f === "その他") continue;
      const hit = (FLAG_WORDS[f] ?? [f]).some((w) => text.includes(w));
      out[f] = hit ? "1" : "0";
      any ||= hit;
    }
    // 情報源の「その他」は、どの語にも当てはまらない回答
    if (g.flags.includes("その他")) out["その他"] = text && !any ? "1" : "0";
  }
  out["対象県（富山/石川/福井）"] = "福井";
  out["アンケート回答日"] = r["回答日時"].replace(/^(\d{4})-(\d{2})-(\d{2}) /, "$1/$2/$3 ");
  out["会員ID"] = "000000"; // 統合CSVと同じく匿名化する
  return out;
}
