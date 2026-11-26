import { DatabaseSync } from "node:sqlite";
import {
  COMMENT_FIELDS,
  DERIVED_COLUMNS,
  FLAG_GROUPS,
  flagPrefectures,
  isFlag,
  RAW_COLUMNS,
} from "./columns.ts";
import {
  aggregateQuery,
  BadRequest,
  commentsQuery,
  flagsQuery,
  intParam,
  responsesQuery,
  type Sql,
  valuesQuery,
} from "./query.ts";
import { downloadDir, type Manifest, readManifest } from "./download.ts";
import { handleMcpHttp } from "./mcp.ts";
import { startAutoUpdate } from "./scheduler.ts";
import { readStatus } from "./update_status.ts";
import { Busy, runSql, SqlTimeout } from "./sql_runner.ts";

const CREDIT =
  "北陸インバウンド観光DX・データコンソーシアム(原データ: 富山県 / 石川県 / 福井観光協会「FTAS」)CC BY";
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
type Rows = Record<string, unknown>[];

function fileVersion(path: string): string {
  const s = Deno.statSync(path);
  return `${s.ino}:${s.mtime?.getTime()}:${s.size}`;
}

export interface Options {
  sqlTimeoutMs?: number;
}

export function createHandler(dbPath: string, opt: Options = {}) {
  let db = new DatabaseSync(dbPath, { readOnly: true });
  let version = fileVersion(dbPath);
  // 列ごとの県別の有効回答数。DBが替わるまで使い回す
  let coverage: Map<string, Record<string, number>> | null = null;

  /** 自動更新などでDBファイルが置き換わっていたら開き直す */
  function refresh() {
    let v: string;
    try {
      v = fileVersion(dbPath);
      if (v === version) return;
      const next = new DatabaseSync(dbPath, { readOnly: true });
      db.close();
      db = next;
    } catch (e) {
      console.error("DBを開き直せないため、前のデータで続行します:", e);
      return;
    }
    version = v;
    coverage = null;
  }
  const all = (s: Sql): Rows => db.prepare(s.sql).all(...s.params) as Rows;
  const count = (s: Sql): number => all(s)[0].n as number;
  const timeout = opt.sqlTimeoutMs ?? 30_000;

  async function route(req: Request, url: URL): Promise<Response> {
    const p = url.searchParams;
    const path = url.pathname;
    const isSql = path === "/api/sql";
    if (req.method !== "GET" && !(isSql && req.method === "POST")) {
      return json({ error: "Method Not Allowed" }, 405);
    }
    const format = p.get("format") ?? "json";
    if (format !== "json" && format !== "csv") throw new BadRequest("format は json か csv です");
    const reply = (columns: string[], rows: Rows, meta: Record<string, unknown> = {}) =>
      format === "csv" ? csv(columns, rows) : json({ ...meta, rows });

    if (path === "/") return index(readManifest(dbPath));
    if (path.startsWith("/download/")) {
      return download(req, decodeURIComponent(path.slice("/download/".length)));
    }
    if (path === "/api/meta") return meta();
    if (path === "/api/columns") return columnsInfo();
    if (path.startsWith("/api/columns/")) {
      const name = decodeURIComponent(path.slice("/api/columns/".length));
      return reply(["value", "count"], all(valuesQuery(name, p)), { column: name });
    }
    if (path === "/api/responses") {
      const r = responsesQuery(p);
      return reply(r.fields, all(r.rows), {
        total: count(r.count),
        limit: r.limit,
        offset: r.offset,
      });
    }
    if (path === "/api/aggregate") {
      const r = aggregateQuery(p);
      return reply(r.columns, all(r));
    }
    if (path === "/api/flags") {
      const r = flagsQuery(p);
      return reply(r.columns, r.unpivot(all(r)), {
        excluded_flags: r.excluded,
        partial_flags: r.partial,
      });
    }
    if (path === "/api/comments") {
      const r = commentsQuery(p);
      const rows = all(r.rows);
      return reply(rows.length ? Object.keys(rows[0]) : ["survey_id", "field", "text"], rows, {
        total: count(r.count),
        order: r.order,
        limit: r.limit,
        offset: r.offset,
      });
    }
    if (isSql) {
      const body = req.method === "POST" ? await sqlBody(req) : { sql: p.get("sql"), params: [] };
      if (typeof body.sql !== "string" || !body.sql.trim()) {
        throw new BadRequest("sql を指定してください");
      }
      const params = body.params ?? [];
      if (typeof params !== "object") throw new BadRequest("params は配列かオブジェクトです");
      const limit = intParam(p, "limit", 1000, 100_000);
      const r = await runSql(dbPath, body.sql, params, limit, timeout);
      return reply(r.columns, r.rows, { columns: r.columns, truncated: r.truncated });
    }
    return json({ error: "Not Found", see: "/" }, 404);
  }

  function meta(): Response {
    const info = Object.fromEntries(
      all({ sql: "SELECT key, value FROM import_info", params: [] }).map((r) => [r.key, r.value]),
    );
    return json({
      imported_at: info.imported_at,
      last_update: readStatus(dbPath),
      downloads: downloadsInfo(),
      files: JSON.parse(info.files as string),
      total: count({ sql: "SELECT count(*) AS n FROM survey", params: [] }),
      prefectures: all({
        sql: `SELECT prefecture, count(*) AS count, min(answered_date) AS "from",
          max(answered_date) AS "to", sum(is_duplicate) AS duplicates
          FROM survey GROUP BY prefecture`,
        params: [],
      }),
      comments: all({
        sql: "SELECT field, count(*) AS count FROM comments GROUP BY field ORDER BY 2 DESC",
        params: [],
      }),
      credit: CREDIT,
      sources: [
        "https://github.com/hokuriku-inbound-kanko/opendata/",
        "https://github.com/code4fukui/fukui-kanko-survey/tree/master/fiscalyearly",
      ],
    });
  }

  function downloadsInfo() {
    const m = readManifest(dbPath);
    return m?.files.map((f) => ({ ...f, url: `/download/${f.name}`, created_at: m.created_at })) ??
      [];
  }

  async function download(req: Request, name: string): Promise<Response> {
    const m = readManifest(dbPath);
    if (!m?.files.some((f) => f.name === name)) return json({ error: "Not Found", see: "/" }, 404);
    const etag = `"${m.db_version}:${name}"`;
    const headers = {
      ...CORS,
      etag,
      "cache-control": "public, max-age=3600",
    };
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, { status: 304, headers });
    }
    const f = await Deno.open(`${downloadDir(dbPath)}/${name}`, { read: true });
    return new Response(f.readable, {
      headers: {
        ...headers,
        "content-type": "application/gzip",
        "content-length": String((await f.stat()).size),
        "content-disposition": `attachment; filename="${name}"`,
      },
    });
  }

  function columnsInfo(): Response {
    if (!coverage) {
      coverage = new Map();
      const names = [...DERIVED_COLUMNS.map((c) => c.name), ...RAW_COLUMNS];
      const rows = all({
        sql: `SELECT prefecture AS p, ${
          names.map((n, i) => `count("${n.replaceAll('"', '""')}") AS "c${i}"`).join(",")
        } FROM survey GROUP BY prefecture`,
        params: [],
      });
      names.forEach((n, i) =>
        coverage!.set(n, Object.fromEntries(rows.map((r) => [r.p, r[`c${i}`] as number])))
      );
    }
    return json({
      derived: DERIVED_COLUMNS.map((c) => ({ ...c, answered: coverage!.get(c.name) })),
      raw: RAW_COLUMNS.map((name) => ({
        name,
        type: isFlag(name) ? "INTEGER" : "TEXT",
        answered: coverage!.get(name),
        ...(isFlag(name) ? { flag: true, valid_prefectures: flagPrefectures(name) } : {}),
      })),
      flag_groups: FLAG_GROUPS,
      comment_fields: COMMENT_FIELDS,
    });
  }

  const handler = async (req: Request): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === "/mcp") return handleMcpHttp(handler, req);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    try {
      refresh();
      return await route(req, url);
    } catch (e) {
      if (e instanceof BadRequest || e instanceof URIError) return json({ error: e.message }, 400);
      if (e instanceof SqlTimeout) return json({ error: e.message }, 408);
      if (e instanceof Busy) return json({ error: e.message }, 503);
      console.error(e);
      return json({ error: "Internal Server Error" }, 500);
    }
  };
  return { handler, close: () => db.close() };
}

async function sqlBody(
  req: Request,
): Promise<{ sql?: unknown; params?: unknown[] | Record<string, unknown> }> {
  const text = await req.text();
  if (!req.headers.get("content-type")?.includes("json")) return { sql: text };
  try {
    const b = JSON.parse(text);
    if (b && typeof b === "object") return b;
  } catch { /* 下でエラーにする */ }
  throw new BadRequest('JSONの形式が不正です。例: {"sql": "SELECT ...", "params": []}');
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 1), {
    status,
    headers: { ...CORS, "content-type": "application/json; charset=utf-8" },
  });
}

function csv(columns: string[], rows: Rows): Response {
  const cell = (v: unknown): string => {
    const t = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
  };
  const lines = [columns.map(cell).join(",")];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c])).join(","));
  const body = "\uFEFF" + lines.join("\r\n") + "\r\n"; // BOM付き(Excelで文字化けしないように)
  return new Response(new TextEncoder().encode(body), {
    headers: { ...CORS, "content-type": "text/csv; charset=utf-8" },
  });
}

/** ISO日時 → "2026-11-26 10:26(日本時間)" */
function jst(iso: string): string {
  const d = new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)}(日本時間)`;
}

/** 1234567 → "1.2 MB" */
function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

function index(manifest: Manifest | null): Response {
  const ex: [string, string][] = [
    ["データの概要", "/api/meta"],
    ["列の一覧", "/api/columns"],
    ["列の値の分布", "/api/columns/age_group?prefecture=福井"],
    [
      "県×年のNPSと満足度",
      "/api/aggregate?by=prefecture,answered_year&metrics=count,nps,avg:sat_trip",
    ],
    [
      "県ごとの居住地方の構成比",
      "/api/aggregate?by=prefecture,residence_region&share_by=prefecture",
    ],
    ["福井の目的(年代別)", "/api/flags?group=purpose&by=age_group&prefecture=福井"],
    ["情報源", "/api/flags?group=info_source&by=prefecture"],
    ["自由記述の検索(新しい順)", "/api/comments?q=駐車場&prefecture=石川&order=newest&limit=20"],
    [
      "回答の抽出",
      "/api/responses?fields=answered_at,residence,recommend,回答場所&recommend__lte=3&limit=20",
    ],
    ["CSV出力", "/api/aggregate?by=answered_month,prefecture&format=csv"],
    [
      "SQL",
      "/api/sql?sql=SELECT 回答場所, count(*) n FROM survey GROUP BY 1 ORDER BY n DESC LIMIT 10",
    ],
  ];
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  return new Response(
    `<!doctype html><html lang="ja"><meta charset="utf-8">
<meta name="viewport" content="width=device-width">
<title>北陸観光アンケート API</title>
<style>body{font-family:sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;line-height:1.6}
dd{margin:0 0 .8rem}a{word-break:break-all}textarea{width:100%;height:6rem;box-sizing:border-box}
pre{overflow:auto;background:#8881;padding:.5rem;max-height:30rem}
table{border-collapse:collapse}th,td{border:1px solid #8884;padding:.3rem .6rem;text-align:left}
td.n{text-align:right;white-space:nowrap}</style>
<h1>北陸観光アンケート API</h1>
<dl>${
      ex.map(([t, u]) => `<dt>${esc(t)}</dt><dd><a href="${esc(encodeURI(u))}">${esc(u)}</a></dd>`)
        .join("\n")
    }</dl>
<h2>一括ダウンロード</h2>
${
      manifest
        ? `<table><tr><th>ファイル</th><th>容量</th><th>展開後</th><th>内容</th></tr>${
          manifest.files.map((f) =>
            `<tr><td><a href="/download/${esc(f.name)}" download>${esc(f.name)}</a></td>
<td class="n">${formatSize(f.size)}</td><td class="n">${formatSize(f.raw_size)}</td>
<td>${
              esc(f.description)
            }</td></tr>`
          ).join("")
        }</table>
<p><small>作成: ${
          esc(jst(manifest.created_at))
        }。gzip圧縮のため展開して使います(例: <code>gunzip survey.db.gz</code>)。</small></p>`
        : "<p>準備中です(<code>deno task import</code> または <code>deno task update</code> で作成されます)。</p>"
    }
<h2>SQL</h2>
<textarea id="sql">SELECT prefecture, count(*) AS n, round(avg(recommend), 2) AS avg_recommend
FROM survey GROUP BY prefecture</textarea>
<button id="run">実行</button><pre id="out"></pre>
<p><small>出典: ${esc(CREDIT)}</small></p>
<script>
document.getElementById("run").onclick = async () => {
  const out = document.getElementById("out");
  out.textContent = "実行中…";
  try {
    const r = await fetch("/api/sql", { method: "POST", body: document.getElementById("sql").value });
    out.textContent = await r.text();
  } catch (e) { out.textContent = e; }
};
</script></html>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );
}

if (import.meta.main) {
  const dbPath = Deno.args[0] ?? "data/survey.db";
  try {
    Deno.statSync(dbPath);
  } catch {
    console.error(`${dbPath} がありません。先に deno task update を実行してください。`);
    Deno.exit(1);
  }
  const hostname = Deno.env.get("HOST") ?? "127.0.0.1";
  const port = Number(Deno.env.get("PORT") ?? 8000);
  Deno.serve({ hostname, port }, createHandler(dbPath).handler);
  if (Deno.env.get("AUTO_UPDATE") !== "0") startAutoUpdate("output_merge", dbPath, "fiscalyearly");
}
