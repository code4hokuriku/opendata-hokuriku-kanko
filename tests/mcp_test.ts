import { assert, assertEquals } from "@std/assert";
import { importCsv } from "../src/import.ts";
import { createHandler } from "../src/server.ts";
import { csvText, row } from "./fixture.ts";

const dir = await Deno.makeTempDir();
await Deno.writeTextFile(
  `${dir}/merged_survey_2025.csv`,
  csvText([
    row({ "自由意見": "駐車場が狭い" }),
    row({ "おすすめ度": "5", "性別": "男" }),
    row({ "対象県（富山/石川/福井）": "石川", "年代": "1971", "生まれ年": "1971" }),
  ]),
);
const dbPath = `${dir}/db/survey.db`;
await importCsv(dir, dbPath);
const { handler } = createHandler(dbPath);

async function rpc(body: unknown, headers: Record<string, string> = {}) {
  const r = await handler(
    new Request("http://127.0.0.1:8000/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
  return { status: r.status, body: r.status === 202 ? null : await r.json() };
}
const call = async (name: string, args: unknown) => {
  const { body } = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const res = body.result;
  return { ...res, data: res.isError ? null : JSON.parse(res.content[0].text) };
};

Deno.test("MCP: 初期化とツール一覧", async () => {
  const init = await rpc({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t" } },
  });
  assertEquals(init.body.result.protocolVersion, "2025-06-18");
  assert(init.body.result.capabilities.tools);
  const n = await rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  assertEquals(n.status, 202);
  const list = await rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  const names = list.body.result.tools.map((t: { name: string }) => t.name);
  assert(names.includes("aggregate") && names.includes("run_sql"));
});

Deno.test("MCP: ツール呼び出し", async () => {
  assertEquals((await call("survey_meta", {})).data.total, 3);
  const agg = await call("aggregate", {
    by: ["prefecture"],
    metrics: "count,nps",
    filters: { gender: ["女", "男"] },
  });
  assertEquals(agg.data.rows.map((r: { count: number }) => r.count), [1, 2]);
  const v = await call("column_values", { column: "gender", filters: { prefecture: "福井" } });
  assertEquals(v.data.rows.length, 2);
  const c = await call("search_comments", { q: "駐車場", field: ["自由意見"] });
  assertEquals(c.data.total, 1);
  const f = await call("flag_rates", { group: "purpose", filters: { prefecture: "福井" } });
  assert(f.data.rows.length > 0);
  const s = await call("run_sql", {
    sql: "SELECT count(*) AS n FROM survey WHERE prefecture = ?",
    params: ["福井"],
  });
  assertEquals(s.data.rows, [{ n: 2 }]);
});

Deno.test("MCP: エラー", async () => {
  const bad = await call("aggregate", { by: "no_such_column" });
  assert(bad.isError);
  assert(bad.content[0].text.includes("不明な列"));
  const sql = await call("run_sql", { sql: "DELETE FROM survey" });
  assert(sql.isError);
  const unknown = await rpc({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "x" } });
  assertEquals(unknown.body.error.code, -32602);
  const m = await rpc({ jsonrpc: "2.0", id: 4, method: "resources/list" });
  assertEquals(m.body.error.code, -32601);
  const o = await rpc({ jsonrpc: "2.0", id: 5, method: "ping" }, {
    origin: "https://evil.example",
  });
  assertEquals(o.status, 403);
  const g = await handler(new Request("http://127.0.0.1:8000/mcp"));
  assertEquals(g.status, 405);
});
