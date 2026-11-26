/** MCPサーバー(stdioトランスポート)。改行区切りのJSON-RPCを標準入出力でやりとりする。 */
import { TextLineStream } from "@std/streams/text-line-stream";
import { handleMessage } from "./mcp.ts";
import { createHandler } from "./server.ts";

const dbPath = Deno.args[0] ?? new URL("../data/survey.db", import.meta.url).pathname;
try {
  Deno.statSync(dbPath);
} catch {
  console.error(`${dbPath} がありません。先に deno task update を実行してください。`);
  Deno.exit(1);
}
const { handler } = createHandler(dbPath);
const enc = new TextEncoder();
// writer は書き込みを順番に最後まで行うので、並行した応答が混ざらない
const out = Deno.stdout.writable.getWriter();
const write = (m: unknown) => out.write(enc.encode(JSON.stringify(m) + "\n"));

const lines = Deno.stdin.readable.pipeThrough(new TextDecoderStream()).pipeThrough(
  new TextLineStream(),
);
for await (const line of lines) {
  if (!line.trim()) continue;
  let msg: unknown;
  try {
    msg = JSON.parse(line);
  } catch {
    await write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    continue;
  }
  // 時間のかかるSQLで他の要求を止めないよう、待たずに並行処理する
  const msgs = Array.isArray(msg) ? msg : [msg];
  Promise.all(msgs.map((m) => handleMessage(handler, m))).then((res) => {
    const r = res.filter((x) => x);
    if (r.length) return write(Array.isArray(msg) ? r : r[0]);
  }).catch((e) => console.error(e));
}
