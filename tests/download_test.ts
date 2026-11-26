import { assert, assertEquals } from "@std/assert";
import { importCsv } from "../src/import.ts";
import { ensureDownloads, readManifest } from "../src/download.ts";
import { createHandler } from "../src/server.ts";
import { csvText, row } from "./fixture.ts";

const dir = await Deno.makeTempDir();
await Deno.writeTextFile(
  `${dir}/merged_survey_2025.csv`,
  csvText([row({ "自由意見": '駐車場が\n狭い、"遅い"' }), row({ "性別": "男" })]),
);
const dbPath = `${dir}/db/survey.db`;
await importCsv(dir, dbPath);

/** BOMを残したまま展開する(Response.text() はBOMを取り除くため使わない) */
async function gunzip(r: Response) {
  const buf = await new Response(r.body!.pipeThrough(new DecompressionStream("gzip")))
    .arrayBuffer();
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(buf);
}

Deno.test("一括ダウンロード: 作成・配信・トップページ", async () => {
  const { handler, close } = createHandler(dbPath);
  try {
    assertEquals((await handler(new Request("http://x/download/survey.db.gz"))).status, 404);
    assert((await (await handler(new Request("http://x/"))).text()).includes("準備中"));

    assertEquals(await ensureDownloads(dbPath), true);
    assertEquals(await ensureDownloads(dbPath), false); // DBが同じなら作り直さない
    const m = readManifest(dbPath)!;
    assertEquals(m.files.map((f) => f.name), ["survey.db.gz", "survey.csv.gz"]);

    const csv = await handler(new Request("http://x/download/survey.csv.gz"));
    assertEquals(csv.headers.get("content-type"), "application/gzip");
    assertEquals(Number(csv.headers.get("content-length")), m.files[1].size);
    const text = await gunzip(csv);
    assert(text.startsWith("\uFEFFid,"));
    assert(text.includes('"駐車場が\n狭い、""遅い"""'));

    const db = await handler(new Request("http://x/download/survey.db.gz"));
    const bytes = new Uint8Array(
      await new Response(db.body!.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer(),
    );
    assertEquals(new TextDecoder().decode(bytes.slice(0, 15)), "SQLite format 3");

    const etag = db.headers.get("etag")!;
    const again = await handler(
      new Request("http://x/download/survey.db.gz", { headers: { "if-none-match": etag } }),
    );
    assertEquals(again.status, 304);

    const page = await (await handler(new Request("http://x/"))).text();
    assert(page.includes('href="/download/survey.db.gz"') && page.includes(" KB"));
    const meta = await (await handler(new Request("http://x/api/meta"))).json();
    assertEquals(meta.downloads.length, 2);
    assertEquals((await handler(new Request("http://x/download/manifest.json"))).status, 404);
    assertEquals((await handler(new Request("http://x/download/..%2Fsurvey.db"))).status, 404);
  } finally {
    close();
  }
});
