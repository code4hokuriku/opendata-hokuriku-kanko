import { assert, assertEquals } from "@std/assert";
import { blobSha, update } from "../src/update.ts";
import { isDue, type UpdateStatus } from "../src/update_status.ts";
import { createHandler } from "../src/server.ts";
import { RAW_COLUMNS } from "../src/columns.ts";
import { csvText, pastCsv, row } from "./fixture.ts";

const COMMIT = "a".repeat(40);
const NAME = "merged_survey_2025.csv";
const rows = (n: number) => Array.from({ length: n }, (_, i) => row({ "自由意見": `意見${i}` }));

/** GitHubの代わりのサーバー */
function upstream() {
  const s = {
    files: {} as Record<string, string>,
    past: { "2022.csv": pastCsv(5) } as Record<string, string>,
    pastDown: false,
    corrupt: false,
    down: false,
    downloads: 0,
  };
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0, onListen() {} }, async (req) => {
    const path = new URL(req.url).pathname;
    if (s.down) return new Response("", { status: 503 });
    if (s.pastDown && path.includes("code4fukui")) return new Response("", { status: 503 });
    if (path.endsWith("/commits/main") || path.endsWith("/commits/master")) {
      return Response.json({ sha: COMMIT });
    }
    const isPast = path.includes("code4fukui/fukui-kanko-survey");
    const files = isPast ? s.past : s.files;
    if (path.endsWith(isPast ? "/contents/fiscalyearly" : "/contents/output_merge")) {
      return Response.json(
        await Promise.all(
          Object.entries(files).map(async ([name, t]) => ({
            type: "file",
            name,
            size: t.length,
            sha: await blobSha(new TextEncoder().encode(t)),
          })),
        ),
      );
    }
    assert(path.includes(`/${COMMIT}/${isPast ? "fiscalyearly" : "output_merge"}/`), path);
    s.downloads++;
    return new Response(files[path.split("/").pop()!] + (s.corrupt ? "x" : ""));
  });
  return { s, base: `http://127.0.0.1:${server.addr.port}`, close: () => server.shutdown() };
}

async function setup(n = 100) {
  const up = upstream();
  up.s.files[NAME] = csvText(rows(n));
  const dir = await Deno.makeTempDir();
  const opt = {
    csvDir: `${dir}/csv`,
    dbPath: `${dir}/db/survey.db`,
    pastDir: `${dir}/past`,
    apiBase: up.base,
    rawBase: up.base,
  };
  return { up, opt, local: () => Deno.readTextFileSync(`${opt.csvDir}/${NAME}`) };
}

async function total(h: (r: Request) => Promise<Response>): Promise<number> {
  return (await (await h(new Request("http://x/api/meta"))).json()).total;
}

Deno.test("初回取得 → 変更なし → 差分更新。稼働中のサーバーにも反映される", async () => {
  const { up, opt, local } = await setup();
  const a = await update(opt);
  assertEquals([a.ok, a.changed, a.commit], [true, [NAME, "fiscalyearly/2022.csv"], COMMIT]);
  const { handler, close } = createHandler(opt.dbPath);
  assertEquals(await total(handler), 105);

  const b = await update(opt);
  assertEquals([b.ok, b.changed, b.updated_at, up.s.downloads], [true, [], a.updated_at, 2]);

  up.s.files[NAME] = csvText(rows(103));
  up.s.files["merged_survey_2026.csv"] = csvText(rows(2));
  const c = await update(opt);
  assertEquals(c.changed, [NAME, "merged_survey_2026.csv"]);
  assertEquals(local(), up.s.files[NAME]);
  assertEquals(await total(handler), 110);
  const meta = await (await handler(new Request("http://x/api/meta"))).json();
  assertEquals(meta.last_update.ok, true);
  close();
  await up.close();
});

Deno.test("異常時は手元のCSVとDBを変えず、エラーを記録する", async () => {
  const { up, opt, local } = await setup();
  const first = await update(opt);
  const before = local();
  const { handler, close } = createHandler(opt.dbPath);
  const unchanged = async (msg: string) => {
    const st = await update(opt);
    assertEquals(st.ok, false);
    assert(st.error!.includes(msg), st.error!);
    assertEquals(st.last_ok_at, first.last_ok_at);
    assertEquals(local(), before);
    assertEquals(await total(handler), 105);
  };
  up.s.files[NAME] = csvText(rows(50));
  await unchanged("105 → 55");

  up.s.files[NAME] = csvText(rows(110), RAW_COLUMNS.map((c, i) => i === 5 ? "新しい列" : c));
  await unchanged("新しい列");

  up.s.files[NAME] = csvText(rows(110));
  up.s.corrupt = true;
  await unchanged("ハッシュ");
  up.s.corrupt = false;

  up.s.down = true;
  await unchanged("503");
  up.s.down = false;

  up.s.files = { "merged_survey_2026.csv": csvText(rows(200)) };
  await unchanged("消えた");

  // 復旧すれば更新でき、作業ファイルも残らない
  up.s.files = { [NAME]: csvText(rows(110)) };
  up.s.pastDown = true; // 過去データ側の障害では本体の更新を止めない
  const back = await update(opt);
  assertEquals([back.ok, back.warnings.length], [true, 1]);
  up.s.pastDown = false;
  assertEquals(await total(handler), 115);
  const left = [...Deno.readDirSync(opt.dbPath.replace("/survey.db", ""))].map((e) => e.name);
  assertEquals(left.sort(), [
    "download",
    "survey.db",
    "survey.db.lock",
    "survey.db.update.json",
  ]);

  // --force なら減少も反映する
  up.s.files[NAME] = csvText(rows(50));
  assertEquals((await update({ ...opt, force: true })).ok, true);
  assertEquals(await total(handler), 55);
  close();
  await up.close();
});

Deno.test("同時に実行しても1回だけ取り込む", async () => {
  const { up, opt } = await setup();
  const r = await Promise.all([update(opt), update(opt)]);
  assertEquals(r.map((x) => x.ok), [true, true]);
  assertEquals(up.s.downloads, 2);
  await up.close();
});

Deno.test("確認する時刻の判定", () => {
  const t = (s: string) => Date.parse(s + "+09:00");
  const st = (checked: string, updated: string | null, ok = true): UpdateStatus => ({
    checked_at: new Date(t(checked)).toISOString(),
    updated_at: updated && new Date(t(updated)).toISOString(),
    ok,
    changed: [],
    commit: null,
    last_ok_at: null,
    error: null,
    warnings: [],
  });
  const due = (s: UpdateStatus | null, now: string) => isDue(s, t(now));
  assertEquals(due(null, "2026-11-26T10:00"), true);
  // 昨日15時に更新済み → 今日の15時まで待つ
  const y = st("2026-11-25T15:00", "2026-11-25T15:00");
  assertEquals(due(y, "2026-11-26T14:59"), false);
  assertEquals(due(y, "2026-11-26T15:00"), true);
  // PCが止まっていて数日空いた
  assertEquals(due(st("2026-11-20T15:00", "2026-11-20T15:00"), "2026-11-26T09:00"), true);
  // 15時に未更新 → 3時間おき
  const n = st("2026-11-26T15:00", "2026-11-25T15:00");
  assertEquals(due(n, "2026-11-26T17:59"), false);
  assertEquals(due(n, "2026-11-26T18:00"), true);
  // 失敗 → 1時間おき
  const f = st("2026-11-26T15:00", "2026-11-25T15:00", false);
  assertEquals(due(f, "2026-11-26T15:59"), false);
  assertEquals(due(f, "2026-11-26T16:00"), true);
});
