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

/** ZIP(1ファイル)を展開し、ファイル名と中身を返す。ヘッダーと末尾の情報の整合も確かめる */
async function unzip(r: Response): Promise<{ name: string; data: Uint8Array }> {
  const zip = new Uint8Array(await r.arrayBuffer());
  const v = new DataView(zip.buffer);
  assertEquals(v.getUint32(0, true), 0x04034b50);
  assertEquals(v.getUint16(8, true), 8); // deflate
  const [crc, packed, raw] = [14, 18, 22].map((o) => v.getUint32(o, true));
  const nameLen = v.getUint16(26, true);
  const name = new TextDecoder().decode(zip.subarray(30, 30 + nameLen));
  const body = zip.subarray(30 + nameLen, 30 + nameLen + packed);
  const data = new Uint8Array(
    await new Response(
      new Blob([body]).stream().pipeThrough(new DecompressionStream("deflate-raw")),
    )
      .arrayBuffer(),
  );
  assertEquals(data.length, raw);
  const end = zip.length - 22;
  assertEquals(v.getUint32(end, true), 0x06054b50);
  const cd = v.getUint32(end + 16, true);
  assertEquals(cd, 30 + nameLen + packed);
  assertEquals([16, 20, 24].map((o) => v.getUint32(cd + o, true)), [crc, packed, raw]);
  return { name, data };
}

Deno.test("一括ダウンロード: 作成・配信・トップページ", async () => {
  const { handler, close } = createHandler(dbPath);
  try {
    assertEquals((await handler(new Request("http://x/download/survey.db.zip"))).status, 404);
    assert((await (await handler(new Request("http://x/"))).text()).includes("準備中"));

    assertEquals(await ensureDownloads(dbPath), true);
    assertEquals(await ensureDownloads(dbPath), false); // DBが同じなら作り直さない
    // 以前の形式(gzip)の一覧と残りファイルは、作り直して消す
    const dl = `${dir}/db/download`;
    const old = JSON.parse(await Deno.readTextFile(`${dl}/manifest.json`));
    delete old.format;
    await Deno.writeTextFile(`${dl}/manifest.json`, JSON.stringify(old));
    await Deno.writeTextFile(`${dl}/survey.db.gz`, "old");
    assertEquals(await ensureDownloads(dbPath), true);
    assertEquals([...Deno.readDirSync(dl)].map((e) => e.name).sort(), [
      "manifest.json",
      "survey.csv.zip",
      "survey.db.zip",
    ]);
    const m = readManifest(dbPath)!;
    assertEquals(m.files.map((f) => f.name), ["survey.db.zip", "survey.csv.zip"]);

    const csv = await handler(new Request("http://x/download/survey.csv.zip"));
    assertEquals(csv.headers.get("content-type"), "application/zip");
    assertEquals(Number(csv.headers.get("content-length")), m.files[1].size);
    const c = await unzip(csv);
    assertEquals(c.name, "survey.csv");
    const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(c.data);
    assert(text.startsWith("\uFEFFid,"));
    assert(text.includes('"駐車場が\n狭い、""遅い"""'));

    const db = await handler(new Request("http://x/download/survey.db.zip"));
    const d = await unzip(db.clone());
    assertEquals(d.name, "survey.db");
    assertEquals(new TextDecoder().decode(d.data.slice(0, 15)), "SQLite format 3");
    assertEquals(d.data, await Deno.readFile(dbPath));

    const etag = db.headers.get("etag")!;
    const again = await handler(
      new Request("http://x/download/survey.db.zip", { headers: { "if-none-match": etag } }),
    );
    assertEquals(again.status, 304);

    const page = await (await handler(new Request("http://x/"))).text();
    assert(page.includes('href="/download/survey.db.zip"') && page.includes(" KB"));
    const meta = await (await handler(new Request("http://x/api/meta"))).json();
    assertEquals(meta.downloads.length, 2);
    assertEquals((await handler(new Request("http://x/download/manifest.json"))).status, 404);
    assertEquals((await handler(new Request("http://x/download/..%2Fsurvey.db"))).status, 404);
  } finally {
    close();
  }
});
