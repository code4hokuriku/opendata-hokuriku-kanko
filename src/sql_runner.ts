import { BadRequest } from "./query.ts";

export interface SqlResult {
  columns: string[];
  rows: Record<string, unknown>[];
  truncated: boolean;
}
export class SqlTimeout extends Error {}
export class Busy extends Error {}

const MAX_CONCURRENT = 4;
let running = 0;

export async function runSql(
  db: string,
  sql: string,
  params: unknown[] | Record<string, unknown>,
  limit: number,
  timeoutMs: number,
): Promise<SqlResult> {
  const head = sql.replace(/^(\s|--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/)+/, "");
  if (!/^(select|with|values|explain)\b/i.test(head)) {
    throw new BadRequest("SELECT / WITH / VALUES / EXPLAIN のみ実行できます");
  }
  if (running >= MAX_CONCURRENT) {
    throw new Busy("実行中のSQLが多すぎます。少し待って再実行してください");
  }
  running++;
  const path = Deno.realPathSync(db);
  const dir = path.slice(0, path.lastIndexOf("/"));
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const child = new Deno.Command("deno", {
      args: [
        "run",
        "--no-prompt",
        "--no-config",
        "--no-remote",
        `--allow-read=${dir}`,
        new URL("./sql_child.ts", import.meta.url).pathname,
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      signal,
    }).spawn();
    const output = child.output();
    const w = child.stdin.getWriter();
    try {
      await w.write(new TextEncoder().encode(JSON.stringify({ db: path, sql, params, limit })));
      await w.close();
    } catch { /* 子が先に終了した場合は下の終了コードで判定する */ }
    const { success, stdout, stderr } = await output;
    if (signal.aborted) throw new SqlTimeout(`${timeoutMs / 1000}秒で打ち切りました`);
    if (!success) throw new Error("SQL子プロセスの異常終了: " + new TextDecoder().decode(stderr));
    const r = JSON.parse(new TextDecoder().decode(stdout));
    if (r.error) throw new BadRequest(r.error);
    return r;
  } finally {
    running--;
  }
}
