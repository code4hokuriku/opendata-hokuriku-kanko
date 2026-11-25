/**
 * 任意SQLを実行する子プロセス。読み取り専用で開き、Denoの権限もDBフォルダの読み取りのみ。
 * SQLiteの実行は同期的で途中停止できないため、時間切れは親がプロセスごと終了させる。
 */
import { DatabaseSync, type StatementSync } from "node:sqlite";

const { db: path, sql, params, limit } = JSON.parse(await new Response(Deno.stdin.readable).text());

function run() {
  const db = new DatabaseSync(path, { readOnly: true });
  const original = db.prepare(sql);
  const names = new Map<string, number>();
  const columns = original.columns().map((c: { name: string }) => {
    const n = (names.get(c.name) ?? 0) + 1; // 同名列は _2, _3 … を付けて区別
    names.set(c.name, n);
    return n === 1 ? c.name : `${c.name}_${n}`;
  });
  if (columns.length === 0) throw new Error("結果を返すSELECT文を指定してください");

  // Denoの iterate() は実行途中のエラーを無視して途中までの結果で終わってしまうため、
  // 外側に LIMIT を付けて all() で取得する。複数文はここで構文エラーになる。
  const explain = /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*explain\b/i.test(sql);
  const st = explain
    ? original
    : db.prepare(`SELECT * FROM (\n${sql.replace(/[;\s]+$/, "")}\n) LIMIT ${limit + 1}`);
  // Denoには実装があるが、型定義にまだ含まれていない
  (st as StatementSync & { setReturnArrays(v: boolean): void }).setReturnArrays(true);
  const all =
    (Array.isArray(params) ? st.all(...params) : st.all(params)) as unknown as unknown[][];
  const rows = all.slice(0, limit)
    .map((r) => Object.fromEntries(columns.map((c: string, i: number) => [c, r[i]])));
  return { columns, rows, truncated: all.length > limit };
}

let out: string;
try {
  out = JSON.stringify(run());
} catch (e) {
  out = JSON.stringify({ error: (e as Error).message });
}
await new Response(out).body!.pipeTo(Deno.stdout.writable);
