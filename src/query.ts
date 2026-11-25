/** URLパラメータ → SQL。列名はホワイトリスト照合し、値は必ずバインドする。 */
import {
  ALL_COLUMNS,
  COMMENT_FIELDS,
  FLAG_GROUPS,
  flagPrefectures,
  flagSource,
  isColumn,
  isDerived,
  isFlag,
  isNumeric,
  q,
} from "./columns.ts";

export class BadRequest extends Error {}

type Bind = string | number;
export interface Sql {
  sql: string;
  params: Bind[];
}

const OPS: Record<string, string> = { gte: ">=", lte: "<=", gt: ">", lt: "<", ne: "<>" };
const COMMON = new Set(["from", "to", "format"]);

export function column(name: string): string {
  if (!isColumn(name)) throw new BadRequest(`不明な列です: ${name}(一覧は /api/columns)`);
  return name;
}

export function intParam(p: URLSearchParams, name: string, def: number, max: number): number {
  const s = p.get(name);
  if (s === null) return def;
  if (!/^\d{1,9}$/.test(s)) throw new BadRequest(`${name} は0以上の整数で指定してください: ${s}`);
  return Math.min(Number(s), max);
}

function list(p: URLSearchParams, name: string): string[] {
  return p.getAll(name).flatMap((s) => s.split(",")).map((s) => s.trim()).filter(Boolean);
}

function bindValue(col: string, v: string): Bind {
  if (!isNumeric(col)) return v;
  if (!/^-?\d+(\.\d+)?$/.test(v)) throw new BadRequest(`${col} は数値で指定してください: ${v}`);
  return Number(v);
}

/** 絞り込み条件。own はそのエンドポイント固有のパラメータ名。 */
export function where(p: URLSearchParams, own: string[]): Sql {
  const conds: string[] = [];
  const params: Bind[] = [];
  const eq = new Map<string, Bind[]>();
  for (const [key, value] of p) {
    if (own.includes(key)) continue;
    if (key === "from" || key === "to") {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        throw new BadRequest(`${key} は YYYY-MM-DD で指定してください: ${value}`);
      }
      conds.push(`"answered_date" ${key === "from" ? ">=" : "<="} ?`);
      params.push(value);
      continue;
    }
    if (COMMON.has(key)) continue;
    const m = key.match(/^(.+)__([a-z]+)$/);
    const col = m ? m[1] : key;
    if (!isColumn(col)) {
      throw new BadRequest(`不明なパラメータです: ${key}(列の一覧は /api/columns)`);
    }
    if (!m) {
      eq.set(col, [...(eq.get(col) ?? []), bindValue(col, value)]);
      continue;
    }
    const op = m[2];
    if (OPS[op]) {
      conds.push(`${q(col)} ${OPS[op]} ?`);
      params.push(bindValue(col, value));
    } else if (op === "like") {
      conds.push(`instr(${q(col)}, ?) > 0`);
      params.push(value);
    } else if (op === "null") {
      if (value !== "true" && value !== "false") {
        throw new BadRequest(`${key} は true か false で指定してください`);
      }
      conds.push(`${q(col)} IS ${value === "true" ? "" : "NOT "}NULL`);
    } else {
      throw new BadRequest(`不明な演算子です: __${op}(gte, lte, gt, lt, ne, like, null)`);
    }
  }
  for (const [col, vs] of eq) {
    conds.push(`${q(col)} IN (${vs.map(() => "?").join(",")})`);
    params.push(...vs);
  }
  return { sql: conds.length ? `WHERE ${conds.join(" AND ")}` : "", params };
}

function orderBy(p: URLSearchParams, allowed: (c: string) => boolean, def: string): string {
  const cols = list(p, "sort");
  if (cols.length === 0) return def ? `ORDER BY ${def}` : "";
  return "ORDER BY " + cols.map((s) => {
    const desc = s.startsWith("-");
    const c = desc ? s.slice(1) : s;
    if (!allowed(c)) throw new BadRequest(`sort に使えない列です: ${c}`);
    return q(c) + (desc ? " DESC" : "");
  }).join(", ");
}

/** /api/responses */
export function responsesQuery(p: URLSearchParams) {
  const w = where(p, ["fields", "sort", "limit", "offset"]);
  const f = list(p, "fields").map(column);
  const fields = f.length ? [...new Set(f)] : ALL_COLUMNS;
  const limit = intParam(p, "limit", 100, 200_000);
  const offset = intParam(p, "offset", 0, 1e9);
  const order = orderBy(p, isColumn, '"id"');
  return {
    count: { sql: `SELECT count(*) AS n FROM survey ${w.sql}`, params: w.params },
    rows: {
      sql: `SELECT ${fields.map(q).join(", ")} FROM survey ${w.sql} ${order} LIMIT ? OFFSET ?`,
      params: [...w.params, limit, offset],
    },
    fields,
    limit,
    offset,
  };
}

/** 有効な県かつ元設問に回答がある行だけフラグ値、それ以外はNULL */
function flagExpr(flag: string): string {
  const prefs = flagPrefectures(flag).map((x) => `'${x}'`).join(",");
  return `CASE WHEN "prefecture" IN (${prefs}) AND ${q(flagSource(flag))} IS NOT NULL THEN ${
    q(flag)
  } END`;
}

/** 指標1つ → SELECT句。値と一緒に有効回答数 n_* も返す。 */
function metric(m: string): { sql: string; name: string }[] {
  if (m === "count") return [{ sql: "count(*)", name: "count" }];
  const i = m.indexOf(":");
  const fn = i < 0 ? m : m.slice(0, i);
  const arg = i < 0 ? "" : m.slice(i + 1);
  const r = (e: string, d = 3) => `round(${e}, ${d})`;

  if (fn === "nps" && !arg) {
    const c = '"recommend"';
    return [
      { sql: r(`100.0 * (sum(${c} >= 9) - sum(${c} <= 6)) / count(${c})`, 2), name: "nps" },
      { sql: `count(${c})`, name: "n_nps" },
    ];
  }
  if (!arg) throw new BadRequest(`不明な指標です: ${m}`);
  const col = column(arg);
  if (fn === "rate") {
    if (!isFlag(col)) throw new BadRequest(`rate はフラグ列専用です: ${col}`);
    if (flagPrefectures(col).length === 0) {
      throw new BadRequest(`${col} は元データのフラグが有効でないため集計できません`);
    }
    const e = flagExpr(col);
    return [
      { sql: r(`avg(${e})`, 4), name: `rate_${col}` },
      { sql: `count(${e})`, name: `n_${col}` },
    ];
  }
  if (fn === "distinct") return [{ sql: `count(DISTINCT ${q(col)})`, name: `distinct_${col}` }];
  if (fn === "n") return [{ sql: `count(${q(col)})`, name: `n_${col}` }];
  const n = { sql: `count(${q(col)})`, name: `n_${col}` };
  if (!isNumeric(col)) throw new BadRequest(`${fn} は数値列専用です: ${col}`);
  if (isFlag(col)) {
    throw new BadRequest(`フラグ列には rate を使ってください(未設問の県を除くため): rate:${col}`);
  }
  switch (fn) {
    case "avg":
      return [{ sql: r(`avg(${q(col)})`), name: `avg_${col}` }, n];
    case "sum":
    case "min":
    case "max":
      return [{ sql: `${fn}(${q(col)})`, name: `${fn}_${col}` }, n];
    case "top2": // 満足度の上位2段階の割合
      if (!col.startsWith("sat_")) throw new BadRequest(`top2 は sat_* 専用です: ${col}`);
      return [{ sql: r(`avg(${q(col)} >= 4)`, 4), name: `top2_${col}` }, n];
  }
  throw new BadRequest(
    `不明な指標です: ${m}(count, n:, distinct:, avg:, sum:, min:, max:, top2:, rate:, nps)`,
  );
}

/** /api/aggregate */
export function aggregateQuery(p: URLSearchParams) {
  const own = ["by", "metrics", "share_by", "sort", "limit", "offset"];
  const w = where(p, own);
  const by = [...new Set(list(p, "by").map(column))];
  // 列名にASCIIコンマは含まれないので、コンマ区切りで安全に分割できる
  const metrics = list(p, "metrics");
  const sel = new Map<string, string>();
  for (const m of metrics.length ? metrics : ["count"]) {
    for (const s of metric(m)) sel.set(s.name, s.sql);
  }
  const shareBy = list(p, "share_by");
  if (p.has("share_by")) {
    for (const c of shareBy) {
      if (!by.includes(c)) {
        throw new BadRequest(`share_by は by に含まれる列を指定してください: ${c}`);
      }
    }
    const part = shareBy.length ? `PARTITION BY ${shareBy.map(q).join(", ")}` : "";
    sel.set("count", "count(*)");
    sel.set("share", `round(1.0 * count(*) / sum(count(*)) OVER (${part}), 4)`);
  }
  const limit = intParam(p, "limit", 10_000, 100_000);
  const offset = intParam(p, "offset", 0, 1e9);
  const columns = [...by, ...sel.keys()];
  const order = orderBy(p, (c) => columns.includes(c), by.map(q).join(", "));
  const items = [...by.map(q), ...[...sel].map(([n, s]) => `${s} AS ${q(n)}`)];
  const group = by.length ? `GROUP BY ${by.map(q).join(", ")}` : "";
  return {
    sql: `SELECT ${items.join(", ")} FROM survey ${w.sql} ${group} ${order} LIMIT ? OFFSET ?`,
    params: [...w.params, limit, offset],
    columns,
  };
}

/** /api/flags: フラグを横断集計し、縦持ち(フラグ1つ1行)にして返す */
export function flagsQuery(p: URLSearchParams) {
  const w = where(p, ["group", "by"]);
  const name = p.get("group") ?? "";
  const g = Object.hasOwn(FLAG_GROUPS, name) ? FLAG_GROUPS[name] : null;
  if (!g) {
    throw new BadRequest(`group を指定してください: ${Object.keys(FLAG_GROUPS).join(", ")}`);
  }
  const by = [...new Set(list(p, "by").map(column))];
  const flags = g.flags.filter((f) => flagPrefectures(f).length > 0);
  const items = [
    ...by.map(q),
    ...flags.flatMap((f, i) => [
      `sum(${flagExpr(f)}) AS "c${i}"`,
      `count(${flagExpr(f)}) AS "n${i}"`,
    ]),
  ];
  const group = by.length
    ? `GROUP BY ${by.map(q).join(", ")} ORDER BY ${by.map(q).join(", ")}`
    : "";
  return {
    sql: `SELECT ${items.join(", ")} FROM survey ${w.sql} ${group}`,
    params: w.params,
    columns: [...by, "flag", "count", "n", "rate"],
    excluded: g.flags.filter((f) => !flags.includes(f)),
    partial: Object.fromEntries(
      flags.filter((f) => flagPrefectures(f).length < 3).map((f) => [f, flagPrefectures(f)]),
    ),
    unpivot(rows: Record<string, unknown>[]): Record<string, unknown>[] {
      return rows.flatMap((r) => {
        const key = Object.fromEntries(by.map((b) => [b, r[b]]));
        return flags.map((flag, i) => {
          const count = r[`c${i}`] as number | null, n = r[`n${i}`] as number;
          return { ...key, flag, count, n, rate: n ? Math.round(count! / n * 1e4) / 1e4 : null };
        }).filter((x) => x.n > 0).sort((a, b) => b.rate! - a.rate!);
      });
    },
  };
}

/** /api/comments */
export function commentsQuery(p: URLSearchParams) {
  const w = where(p, ["q", "field", "order", "limit", "offset"]);
  const order = p.get("order") ?? "oldest";
  if (order !== "newest" && order !== "oldest") {
    throw new BadRequest(`order は newest(新しい順)か oldest(古い順)です: ${order}`);
  }
  const dir = order === "newest" ? "DESC" : "ASC";
  const conds: string[] = [];
  const params: Bind[] = [];
  const words = p.getAll("q").flatMap((s) => s.split(/\s+/)).filter(Boolean);
  for (const word of words) { // 空白区切りはAND
    conds.push("instr(lower(c.text), lower(?)) > 0");
    params.push(word);
  }
  const fields = p.getAll("field");
  for (const f of fields) {
    if (!COMMENT_FIELDS.includes(f)) {
      throw new BadRequest(`不明な field です: ${f}(${COMMENT_FIELDS.join(" / ")})`);
    }
  }
  if (fields.length) {
    conds.push(`c.field IN (${fields.map(() => "?").join(",")})`);
    params.push(...fields);
  }
  const filter = w.sql ? `c.survey_id IN (SELECT "id" FROM survey ${w.sql})` : "";
  if (filter) {
    conds.push(filter);
    params.push(...w.params);
  }
  const cond = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const limit = intParam(p, "limit", 100, 200_000);
  const offset = intParam(p, "offset", 0, 1e9);
  return {
    count: { sql: `SELECT count(*) AS n FROM comments c ${cond}`, params },
    rows: {
      sql:
        `SELECT c.survey_id, c.field, c.text, s.prefecture, s.answered_at, s.answered_date, s.gender,
          s.age_group, s.residence, s.recommend, s.sat_trip, s."回答場所"
        FROM comments c JOIN survey s ON s.id = c.survey_id ${cond}
        ORDER BY s.answered_at ${dir}, s.id ${dir}, c.id LIMIT ? OFFSET ?`,
      params: [...params, limit, offset],
    },
    order,
    limit,
    offset,
  };
}

/** /api/columns/:name — 値の分布 */
export function valuesQuery(name: string, p: URLSearchParams): Sql {
  const c = column(name);
  const w = where(p, ["limit", "offset"]);
  const order = isDerived(c) && isNumeric(c) ? q(c) : `"count" DESC, ${q(c)}`;
  return {
    sql: `SELECT ${q(c)} AS "value", count(*) AS "count" FROM survey ${w.sql}
      GROUP BY ${q(c)} ORDER BY ${order} LIMIT ? OFFSET ?`,
    params: [...w.params, intParam(p, "limit", 200, 100_000), intParam(p, "offset", 0, 1e9)],
  };
}
