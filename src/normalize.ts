/** 1回答(生データ)から分析用の派生列を作る */

const REGIONS: Record<string, string> = {};
for (
  const [region, prefs] of Object.entries({
    "北海道": "北海道",
    "東北": "青森県 岩手県 宮城県 秋田県 山形県 福島県",
    "関東": "茨城県 栃木県 群馬県 埼玉県 千葉県 東京都 神奈川県",
    "甲信越": "新潟県 山梨県 長野県",
    "北陸": "富山県 石川県 福井県",
    "東海": "岐阜県 静岡県 愛知県 三重県",
    "近畿": "滋賀県 京都府 大阪府 兵庫県 奈良県 和歌山県",
    "中国": "鳥取県 島根県 岡山県 広島県 山口県",
    "四国": "徳島県 香川県 愛媛県 高知県",
    "九州・沖縄": "福岡県 佐賀県 長崎県 熊本県 大分県 宮崎県 鹿児島県 沖縄県",
  })
) for (const p of prefs.split(" ")) REGIONS[p] = region;

export const regionOf = (residence: string): string | null => REGIONS[residence] ?? null;

export interface ParsedDate {
  at: string;
  date: string;
  year: number;
  month: string;
  dow: number;
  hour: number | null;
}

/** "2023/12/31 9:46:58" → ISO風。dateOnly のときは時刻を捨てる(富山は常に00:00:00のため) */
export function parseDate(s: string, dateOnly: boolean): ParsedDate | null {
  const m = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2}) (\d{1,2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [Y, M, D, h] = [m[1], m[2].padStart(2, "0"), m[3].padStart(2, "0"), m[4].padStart(2, "0")];
  const date = `${Y}-${M}-${D}`;
  const d = new Date(`${date}T00:00:00Z`);
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date) return null;
  return {
    at: dateOnly ? date : `${date}T${h}:${m[5]}:${m[6]}`,
    date,
    year: Number(Y),
    month: `${Y}-${M}`,
    dow: d.getUTCDay() || 7,
    hour: dateOnly ? null : Number(h),
  };
}

export function ageToGroup(age: number): string {
  if (age < 10) return "10歳未満";
  if (age >= 80) return "80歳以上";
  return `${Math.floor(age / 10) * 10}代`;
}

/** 3県で区分が異なる世帯年収を共通区分へ */
export function incomeGroup(s: string): string | null {
  if (s === "") return null;
  if (s.includes("無回答")) return "無回答";
  const code = s.match(/^([1-5]):/); // 富山: "2: 300〜599万円" / "2:300～500万円"
  if (code) {
    return [
      "1:300万円未満",
      "2:300-600万円未満",
      "3:600-1000万円未満",
      "4:1000万円以上",
      "4:1000万円以上",
    ][
      Number(code[1]) - 1
    ];
  }
  const m = s.match(/^([\d,]+)万円(未満|以上)/);
  if (!m) return null;
  const v = Number(m[1].replaceAll(",", ""));
  const low = m[2] === "未満" ? 0 : v;
  if (low < 300) return "1:300万円未満";
  if (low < 600) return "2:300-600万円未満";
  if (low < 1000) return "3:600-1000万円未満";
  return "4:1000万円以上";
}

/** "1泊" "4泊以上" "日帰り" "福井県内には宿泊しない" → 泊数 */
export function nights(s: string): number | null {
  const m = s.match(/^(\d)泊/);
  if (m) return Number(m[1]);
  if (s === "日帰り" || s.endsWith("宿泊しない")) return 0;
  return null;
}

/** 金額レンジの代表値(円)。上限のない最上位は下限値を使う */
export function yen(s: string): number | null {
  const t = s.trim();
  if (t === "使わない") return 0;
  const num = (x: string) => Number(x.replaceAll(",", ""));
  let m = t.match(/^([\d,]+)円以上 ([\d,]+)円未満$/);
  if (m) return (num(m[1]) + num(m[2])) / 2;
  m = t.match(/^([\d,]+)円未満$/);
  if (m) return num(m[1]) / 2;
  m = t.match(/^([\d,]+)円以上$/);
  if (m) return num(m[1]);
  return null;
}

export function score(s: string, min: number, max: number): number | null {
  const m = s.match(/^(\d+)(?:\s*\(.*\))?$/); // "10 (ぜひ薦めたい)" を許容
  if (!m) return null;
  const n = Number(m[1]);
  return n >= min && n <= max ? n : null;
}

export const npsCategory = (n: number | null): string | null =>
  n === null ? null : n >= 9 ? "推奨者" : n >= 7 ? "中立者" : "批判者";

export function revisitGroup(s: string): string | null {
  if (s === "") return null;
  if (s.endsWith("在住")) return "在住者";
  if (s.startsWith("また行きたい") || s === "来年もまた行きたい") return "また行きたい";
  return s;
}

export type Value = string | number | null;

/** id/source_*, is_duplicate 以外の派生列 */
export function derive(r: Record<string, string>): Record<string, Value> {
  const pref = r["対象県（富山/石川/福井）"];
  const d = parseDate(r["アンケート回答日"], pref === "富山");
  if (!d) throw new Error(`回答日を解釈できません: ${r["アンケート回答日"]}`);

  let age: number | null = null;
  if (pref === "福井") age = score(r["回答時の年齢"], 0, 110);
  else if (pref === "石川") {
    const birth = score(r["生まれ年"], 1900, d.year);
    if (birth !== null && d.year - birth <= 110) age = d.year - birth;
  }
  // 石川の「年代」列には生年が入っている
  const ageGroup = /代$|以上$|未満$/.test(r["年代"])
    ? r["年代"]
    : age !== null
    ? ageToGroup(age)
    : null;
  const residence = r["居住都道府県"] || null;
  const recommend = score(r["おすすめ度"], 0, 10);
  const sat = (c: string) => score(r[c], 1, 5);

  return {
    prefecture: pref,
    answered_at: d.at,
    answered_date: d.date,
    answered_year: d.year,
    answered_month: d.month,
    answered_dow: d.dow,
    answered_hour: d.hour,
    residence,
    residence_region: residence && regionOf(residence),
    is_local: residence === null ? null : residence === pref + "県" ? 1 : 0,
    gender: r["性別"] || null,
    age,
    age_group: ageGroup,
    income_group: incomeGroup(r["世帯年収"]),
    nights_total: nights(r["宿泊数（全行程）"]),
    nights_in_prefecture: nights(r["宿泊数（県内）"]),
    sat_trip: sat("満足度（旅行全体）"),
    sat_service: sat("満足度（商品・サービス）"),
    sat_transport: sat("交通の満足度"),
    sat_food: sat("満足度（食べ物・料理）"),
    sat_lodging: sat("満足度（宿泊施設）"),
    sat_shopping: sat("満足度（買い物（工芸品・特産品など））"),
    sat_activity: sat("満足度（観光・体験）"),
    recommend,
    nps_category: npsCategory(recommend),
    revisit_group: revisitGroup(r["再訪意向"]),
    spend_transport_yen: yen(r["交通費"]),
    spend_food_yen: yen(r["飲食費"]),
    spend_lodging_yen: yen(r["宿泊費"]),
    spend_facility_yen: yen(r["施設orエリア消費総額"]),
    spend_sightseeing_yen: yen(r["観光費"]),
  };
}
