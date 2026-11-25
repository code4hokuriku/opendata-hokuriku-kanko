/** 列の定義。生データ126列(元の日本語名のまま)と、分析用に正規化した派生列を持つ。 */

export type Prefecture = "富山" | "石川" | "福井";
export const PREFECTURES: Prefecture[] = ["富山", "石川", "福井"];

/** 配布CSVのヘッダー(順序も同一)。インポート時に一致を検証する。 */
export const RAW_COLUMNS: string[] = [
  "対象県（富山/石川/福井）",
  "アンケート回答日",
  "居住都道府県",
  "性別",
  "年代",
  "職業",
  "世帯年収",
  "同伴者",
  "宿泊数（全行程）",
  "宿泊エリア（県外）",
  "宿泊エリア（県内）",
  "宿泊数（県内）",
  "１泊目　宿泊先",
  "１泊目　食事プラン",
  "２泊目　宿泊先",
  "２泊目　食事プラン",
  "３泊目　宿泊先",
  "３泊目　食事プラン",
  "４泊目　宿泊先",
  "４泊目　食事プラン",
  "交通手段１（目的地まで）",
  "自家用車",
  "レンタカー",
  "新幹線",
  "在来線",
  "飛行機",
  "旅行会社ツアーバス",
  "県外から訪れていない（福井県在住）",
  "交通手段２（目的地から）",
  "タクシー",
  "路線バス",
  "徒歩",
  "レンタサイクル",
  "交通の満足度",
  "交通の満足度の理由",
  "来県回数（観光）",
  "エリアへの訪問回数",
  "施設への訪問回数",
  "目的",
  "宿でのんびり過ごす",
  "温泉や露天風呂",
  "地元の美味しいものを食べる",
  "花見や紅葉などの自然鑑賞",
  "名所、旧跡の観光",
  "テーマパーク（遊園地、動物園、博物館など）",
  "買い物、アウトレット",
  "お祭りやイベントへの参加・見物",
  "スポーツ観戦や芸能鑑賞（コンサート等）",
  "アウトドア（海水浴、釣り、登山など）",
  "まちあるき、都市散策",
  "各種体験（手作り、果物狩りなど）",
  "スキー・スノボ、マリンスポーツ",
  "その他スポーツ（ゴルフ、テニスなど）",
  "ドライブ・ツーリング",
  "友人・親戚を尋ねる",
  "出張など仕事関係",
  "その他の目的",
  "情報源",
  "Facebook",
  "Google",
  "Googleマップ",
  "Instagram",
  "TikTok",
  "X（旧Twitter）",
  "YouTube",
  "SNS広告",
  "ブログ",
  "まとめサイト",
  "インターネット・アプリ",
  "デジタルニュース",
  "宿泊予約Webサイト",
  "宿泊施設",
  "TV・ラジオ番組やCM",
  "ラブライブのスタンプラリー",
  "新聞・雑誌・ガイドブック",
  "旅行会社",
  "友人・知人",
  "地元の人",
  "観光パンフレット・ポスター",
  "観光案内所",
  "観光展・物産展",
  "観光連盟やDMOのHP",
  "その他",
  "他を検討した？",
  "どこと比較した？（県）",
  "どこと比較した？（観光地）",
  "交通費",
  "飲食費",
  "宿泊費",
  "買い物費",
  "施設orエリア消費総額",
  "観光費",
  "訪問場所",
  "寿司",
  "ます寿司",
  "海の幸食べたか",
  "海の幸感動",
  "満足度（食べ物・料理）",
  "満足度（宿泊施設）",
  "満足度（買い物（工芸品・特産品など））",
  "満足度（観光・体験）",
  "満足度（旅行全体）",
  "満足度（商品・サービス）",
  "満足度理由(サービス)",
  "満足度理由",
  "不便に感じたこと・困ったこと",
  "最も幸せを感じた食べ物",
  "最も幸せを感じた観光・体験",
  "おすすめ度",
  "再訪意向",
  "自由意見",
  "回答場所",
  "個人情報保護の方針について",
  "アンケート前に訪れた主な場所（施設やスポット名称、エリアなど）",
  "上記名称リストにない場合について、具体的にお答えください。(前)",
  "アンケート後に訪れる予定の場所（施設やスポット名称、エリア）",
  "上記名称リストにない場合について、具体的にお答えください。(後)",
  "会員ID",
  "登録エリア",
  "生まれ年",
  "回答時の年齢",
  "UA(UserAgent)",
  "回答月",
  "回答エリア2",
  "DMO",
  "推奨項目",
];

function slice(from: string, to: string): string[] {
  const a = RAW_COLUMNS.indexOf(from), b = RAW_COLUMNS.indexOf(to);
  if (a < 0 || b < a) throw new Error(`bad column range: ${from}..${to}`);
  return RAW_COLUMNS.slice(a, b + 1);
}

export interface FlagGroup {
  label: string;
  /** フラグの元になった複数回答の列 */
  source: string;
  flags: string[];
}

/** 複数回答を展開した0/1フラグ列のグループ */
export const FLAG_GROUPS: Record<string, FlagGroup> = {
  transport_to: {
    label: "交通手段(目的地まで)",
    source: "交通手段１（目的地まで）",
    flags: slice("自家用車", "県外から訪れていない（福井県在住）"),
  },
  transport_local: {
    label: "交通手段(目的地から)",
    source: "交通手段２（目的地から）",
    flags: slice("タクシー", "レンタサイクル"),
  },
  purpose: {
    label: "旅行の目的",
    source: "目的",
    flags: slice("宿でのんびり過ごす", "その他の目的"),
  },
  info_source: {
    label: "情報源",
    source: "情報源",
    flags: slice("Facebook", "その他"),
  },
};

/**
 * フラグが有効に使えない県。元データでは県ごとに選択肢が違うのに、
 * 選択肢がない県でも一律 0 が入っている。そのまま平均すると割合が過小になるため、
 * ここに挙げた県は割合の分母から外す。
 * (自由記述にたまたま含まれて少数の 1 が立っているだけのものも含む)
 */
const FLAG_UNAVAILABLE: Record<string, Prefecture[]> = {
  "県外から訪れていない（福井県在住）": ["富山", "石川"],
  "タクシー": ["石川"],
  "路線バス": ["石川"],
  "徒歩": ["石川"],
  "レンタサイクル": ["石川"],
  "名所、旧跡の観光": ["富山"],
  "テーマパーク（遊園地、動物園、博物館など）": ["富山"],
  "買い物、アウトレット": ["富山"],
  "スポーツ観戦や芸能鑑賞（コンサート等）": ["富山", "石川"],
  "スキー・スノボ、マリンスポーツ": ["富山", "石川"],
  "友人・親戚を尋ねる": ["富山", "石川"],
  // 石川・富山では「その他スポーツ」への部分一致で 1 が立っており信頼できない
  "その他の目的": ["富山", "石川"],
  "Google": ["石川", "福井"],
  "Googleマップ": ["石川", "福井"],
  "TikTok": ["石川", "福井"],
  "YouTube": ["石川", "福井"],
  "SNS広告": ["石川", "福井"],
  "ブログ": ["富山"],
  "まとめサイト": ["石川", "福井"],
  "インターネット・アプリ": ["富山"],
  // 富山の情報源には選択肢があるが、元データの変換でフラグが立っていない
  "デジタルニュース": ["富山", "石川", "福井"],
  "宿泊予約Webサイト": ["石川", "福井"],
  "宿泊施設": ["石川"],
  "TV・ラジオ番組やCM": ["富山"],
  "ラブライブのスタンプラリー": ["富山", "石川", "福井"],
  "旅行会社": ["石川", "福井"],
  "地元の人": ["富山"],
  "観光パンフレット・ポスター": ["富山"],
  "観光案内所": ["富山"],
};

export const FLAG_COLUMNS: string[] = Object.values(FLAG_GROUPS).flatMap((g) => g.flags);
const FLAG_SET = new Set(FLAG_COLUMNS);
export const isFlag = (name: string): boolean => FLAG_SET.has(name);

/** そのフラグを割合として集計してよい県 */
export function flagPrefectures(flag: string): Prefecture[] {
  const ng = FLAG_UNAVAILABLE[flag] ?? [];
  return PREFECTURES.filter((p) => !ng.includes(p));
}
export function flagSource(flag: string): string {
  const g = Object.values(FLAG_GROUPS).find((g) => g.flags.includes(flag));
  if (!g) throw new Error(`not a flag: ${flag}`);
  return g.source;
}

/** 自由記述の列(comments テーブルにも展開する) */
export const COMMENT_FIELDS: string[] = [
  "交通の満足度の理由",
  "満足度理由(サービス)",
  "満足度理由",
  "不便に感じたこと・困ったこと",
  "最も幸せを感じた食べ物",
  "最も幸せを感じた観光・体験",
  "自由意見",
  "推奨項目",
];

export interface DerivedColumn {
  name: string;
  type: "TEXT" | "INTEGER";
  description: string;
}

export const DERIVED_COLUMNS: DerivedColumn[] = [
  { name: "id", type: "INTEGER", description: "連番(主キー)" },
  {
    name: "source_year",
    type: "INTEGER",
    description: "取り込み元CSVの年(福井県の過去データは年度)",
  },
  {
    name: "source_file",
    type: "TEXT",
    description:
      "取り込み元(merged_survey_YYYY.csv、または福井県の過去データ fukui_fiscalyearly_YYYY.csv)",
  },
  {
    name: "source_row",
    type: "INTEGER",
    description: "取り込み元CSVでのデータ行番号(1始まり、ヘッダー除く)",
  },
  { name: "is_duplicate", type: "INTEGER", description: "126列すべてが同じ行が先に存在すれば1" },
  { name: "prefecture", type: "TEXT", description: "対象県(富山/石川/福井)" },
  {
    name: "answered_at",
    type: "TEXT",
    description: "回答日時 YYYY-MM-DDTHH:MM:SS(富山は日付のみのため時刻なし)",
  },
  { name: "answered_date", type: "TEXT", description: "回答日 YYYY-MM-DD" },
  { name: "answered_year", type: "INTEGER", description: "回答年" },
  { name: "answered_month", type: "TEXT", description: "回答年月 YYYY-MM" },
  { name: "answered_dow", type: "INTEGER", description: "回答曜日(1=月 … 7=日)" },
  { name: "answered_hour", type: "INTEGER", description: "回答時(0-23)。富山はNULL" },
  { name: "residence", type: "TEXT", description: "居住都道府県" },
  { name: "residence_region", type: "TEXT", description: "居住地方" },
  { name: "is_local", type: "INTEGER", description: "対象県の在住者なら1" },
  { name: "gender", type: "TEXT", description: "性別" },
  {
    name: "age",
    type: "INTEGER",
    description: "年齢。福井は回答時の年齢、石川は回答年−生年(最大1歳の誤差)、富山はNULL",
  },
  { name: "age_group", type: "TEXT", description: "年代。石川は元データが生年のため年齢から算出" },
  { name: "income_group", type: "TEXT", description: "世帯年収を3県共通の4区分+無回答に統合" },
  { name: "nights_total", type: "INTEGER", description: "宿泊数(全行程) 0=日帰り、4=4泊以上" },
  {
    name: "nights_in_prefecture",
    type: "INTEGER",
    description: "宿泊数(県内) 0=県内宿泊なし、4=4泊以上",
  },
  { name: "sat_trip", type: "INTEGER", description: "満足度(旅行全体) 1-5" },
  {
    name: "sat_service",
    type: "INTEGER",
    description: "満足度(商品・サービス) 1-5。富山は設問なし",
  },
  { name: "sat_transport", type: "INTEGER", description: "交通の満足度 1-5。数値以外の記述はNULL" },
  { name: "sat_food", type: "INTEGER", description: "満足度(食べ物・料理) 1-5。富山のみ" },
  { name: "sat_lodging", type: "INTEGER", description: "満足度(宿泊施設) 1-5。富山のみ" },
  { name: "sat_shopping", type: "INTEGER", description: "満足度(買い物) 1-5。富山のみ" },
  { name: "sat_activity", type: "INTEGER", description: "満足度(観光・体験) 1-5。富山のみ" },
  { name: "recommend", type: "INTEGER", description: "おすすめ度 0-10" },
  { name: "nps_category", type: "TEXT", description: "推奨者(9-10)/中立者(7-8)/批判者(0-6)" },
  {
    name: "revisit_group",
    type: "TEXT",
    description: "再訪意向(表記ゆれ統合。富山の「来年もまた行きたい」は「また行きたい」に統合)",
  },
  {
    name: "spend_transport_yen",
    type: "INTEGER",
    description: "交通費(円、レンジの中央値。10万円以上は100000)。石川は設問なし",
  },
  { name: "spend_food_yen", type: "INTEGER", description: "飲食費(同上)。富山のみ" },
  { name: "spend_lodging_yen", type: "INTEGER", description: "宿泊費(同上)" },
  {
    name: "spend_facility_yen",
    type: "INTEGER",
    description: "施設orエリア消費総額(同上)。富山は設問なし",
  },
  { name: "spend_sightseeing_yen", type: "INTEGER", description: "観光費(同上)。石川は設問なし" },
];

const DERIVED_MAP = new Map(DERIVED_COLUMNS.map((c) => [c.name, c]));
const RAW_SET = new Set(RAW_COLUMNS);

export const isDerived = (name: string): boolean => DERIVED_MAP.has(name);
export const isColumn = (name: string): boolean => DERIVED_MAP.has(name) || RAW_SET.has(name);
/** 数値として比較・集計できる列か */
export const isNumeric = (name: string): boolean =>
  DERIVED_MAP.get(name)?.type === "INTEGER" || FLAG_SET.has(name);
export const ALL_COLUMNS: string[] = [...DERIVED_COLUMNS.map((c) => c.name), ...RAW_COLUMNS];

/** SQL識別子のクォート */
export const q = (name: string): string => `"${name.replaceAll('"', '""')}"`;
