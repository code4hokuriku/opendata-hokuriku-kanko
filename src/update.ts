/**
 * GitHubの最新CSVを取得し、変更があればDBを作り直す: deno task update [--force] [csvDir] [dbPath] [pastDir]
 *
 * ダウンロード・検証・DB作成はすべて作業フォルダで行い、成功したときだけ本番へ反映する。
 */
import { ensureDownloads } from "./download.ts";
import { DatabaseSync } from "node:sqlite";
import { PAST_FILES } from "./fukui_fiscal.ts";
import { importCsv, withLock } from "./import.ts";
import { readStatus, type UpdateStatus, writeStatus } from "./update_status.ts";

interface Source {
  repo: string;
  branch: string;
  dir: string;
  match: (name: string) => boolean;
}
/** 3県の統合CSV */
const MERGED: Source = {
  repo: "hokuriku-inbound-kanko/opendata",
  branch: "main",
  dir: "output_merge",
  match: (n) => /^merged_survey_\d{4}\.csv$/.test(n),
};
/** 福井県の過去データ(統合CSVにない年度だけ) */
const PAST: Source = {
  repo: "code4fukui/fukui-kanko-survey",
  branch: "master",
  dir: "fiscalyearly",
  match: (n) => PAST_FILES.includes(n),
};
/** 県別の件数がこの割合を下回ったら、上流の異常とみなして反映しない */
const MIN_RATIO = 0.95;

export interface UpdateOptions {
  csvDir: string;
  dbPath: string;
  pastDir: string;
  force?: boolean;
  apiBase?: string;
  rawBase?: string;
}
interface Remote {
  name: string;
  sha: string;
  size: number;
}

/** Gitのblobハッシュ(GitHubのファイル一覧にある sha と同じもの) */
export async function blobSha(data: Uint8Array): Promise<string> {
  const head = new TextEncoder().encode(`blob ${data.length}\0`);
  const buf = new Uint8Array(head.length + data.length);
  buf.set(head);
  buf.set(data, head.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-1", buf)).toHex();
}

async function fetchOk(url: string, ms: number): Promise<Response> {
  const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) {
    await r.body?.cancel();
    throw new Error(`取得に失敗しました: HTTP ${r.status} ${url}`);
  }
  return r;
}

/** 一覧とファイルの版がずれないよう、コミットを固定して取得する */
async function remoteFiles(
  src: Source,
  apiBase: string,
): Promise<{ commit: string; files: Remote[] }> {
  const base = `${apiBase}/repos/${src.repo}`;
  const c = await (await fetchOk(`${base}/commits/${src.branch}`, 30_000)).json();
  const commit: string = c.sha;
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("コミットIDを取得できません");
  const list: (Remote & { type: string })[] =
    await (await fetchOk(`${base}/contents/${src.dir}?ref=${commit}`, 30_000)).json();
  const files = list.filter((f) => f.type === "file" && src.match(f.name));
  if (files.length === 0) throw new Error(`上流の ${src.dir} にCSVがありません`);
  return { commit, files };
}

async function readIfExists(path: string): Promise<Uint8Array | null> {
  try {
    return await Deno.readFile(path);
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return null;
    throw e;
  }
}

function exists(path: string): boolean {
  try {
    Deno.statSync(path);
    return true;
  } catch (e) {
    if (e instanceof Deno.errors.NotFound) return false;
    throw e;
  }
}

function prefectureCounts(db: DatabaseSync): Map<string, number> {
  const rows = db.prepare("SELECT prefecture AS p, count(*) AS n FROM survey GROUP BY 1").all();
  return new Map(rows.map((r) => [r.p as string, r.n as number]));
}

function checkDecrease(oldDb: string, next: DatabaseSync) {
  const db = new DatabaseSync(oldDb, { readOnly: true });
  let before: Map<string, number>;
  try {
    before = prefectureCounts(db);
  } finally {
    db.close();
  }
  const after = prefectureCounts(next);
  for (const [p, n] of before) {
    const m = after.get(p) ?? 0;
    if (m < n * MIN_RATIO) {
      throw new Error(`${p}の件数が ${n} → ${m} に減ったため反映しません(反映するには --force)`);
    }
  }
}

/** 更新を1回行い、結果を記録して返す。失敗時も例外は投げず ok: false を返す。 */
export function update(opt: UpdateOptions): Promise<UpdateStatus> {
  return withLock(opt.dbPath, async () => {
    const prev = readStatus(opt.dbPath);
    const now = new Date().toISOString();
    let st: UpdateStatus;
    try {
      const r = await run(opt);
      st = {
        checked_at: now,
        ok: true,
        changed: r.changed,
        commit: r.commit,
        warnings: r.warnings,
        last_ok_at: now,
        updated_at: r.changed.length ? now : prev?.updated_at ?? null,
        error: null,
      };
    } catch (e) {
      st = {
        checked_at: now,
        ok: false,
        changed: [],
        commit: prev?.commit ?? null,
        warnings: [],
        last_ok_at: prev?.last_ok_at ?? null,
        updated_at: prev?.updated_at ?? null,
        error: (e as Error).message,
      };
    }
    // DBが変わったとき(または前回作れなかったとき)だけ作り直す
    try {
      if (exists(opt.dbPath)) await ensureDownloads(opt.dbPath);
    } catch (e) {
      st.warnings.push(`一括ダウンロード用ファイルを作れませんでした: ${(e as Error).message}`);
    }
    writeStatus(opt.dbPath, st);
    return st;
  });
}

interface Synced {
  commit: string;
  changed: string[];
}

/** 最新の一式を staging に揃える。手元と同じものは写し、違うものだけ取得する。 */
async function sync(
  src: Source,
  localDir: string,
  staging: string,
  opt: UpdateOptions,
): Promise<Synced> {
  const { commit, files } = await remoteFiles(src, opt.apiBase ?? "https://api.github.com");
  const names = new Set(files.map((f) => f.name));
  const gone = [...Deno.readDirSync(localDir)].map((e) => e.name)
    .filter((n) => src.match(n) && !names.has(n));
  if (gone.length) {
    throw new Error(`上流から消えたファイルがあります: ${gone.join(", ")}(手元は変更していません)`);
  }
  const changed: string[] = [];
  for (const f of files) {
    const local = await readIfExists(`${localDir}/${f.name}`);
    if (local && await blobSha(local) === f.sha) {
      Deno.copyFileSync(`${localDir}/${f.name}`, `${staging}/${f.name}`);
      continue;
    }
    const raw = opt.rawBase ?? "https://raw.githubusercontent.com";
    const r = await fetchOk(`${raw}/${src.repo}/${commit}/${src.dir}/${f.name}`, 300_000);
    const data = new Uint8Array(await r.arrayBuffer());
    if (await blobSha(data) !== f.sha) throw new Error(`${f.name} のハッシュが一致しません`);
    await Deno.writeFile(`${staging}/${f.name}`, data);
    changed.push(f.name);
  }
  return { commit, changed };
}

async function run(opt: UpdateOptions): Promise<Synced & { warnings: string[] }> {
  const { csvDir, dbPath, pastDir } = opt;
  for (const d of [csvDir, pastDir]) Deno.mkdirSync(d, { recursive: true });

  const staging = `${dbPath}.staging`;
  if (exists(staging)) Deno.removeSync(staging, { recursive: true }); // 前回の中断の残り
  const [newCsv, newPast] = [`${staging}/csv`, `${staging}/past`];
  for (const d of [newCsv, newPast]) Deno.mkdirSync(d, { recursive: true });
  try {
    const warnings: string[] = [];
    const merged = await sync(MERGED, csvDir, newCsv, opt);

    // 過去データはほぼ変わらないので、取得できなくても手元にあればそれを使い、本体の更新は続ける
    let pastChanged: string[] = [];
    try {
      pastChanged = (await sync(PAST, pastDir, newPast, opt)).changed;
    } catch (e) {
      if (!PAST_FILES.every((n) => exists(`${pastDir}/${n}`))) throw e;
      for (const n of PAST_FILES) Deno.copyFileSync(`${pastDir}/${n}`, `${newPast}/${n}`);
      warnings.push(`福井県の過去データは手元のものを使用: ${(e as Error).message}`);
    }

    const changed = [...merged.changed, ...pastChanged.map((n) => `${PAST.dir}/${n}`)];
    const hasDb = exists(dbPath);
    if (changed.length || !hasDb) {
      const r = await importCsv(newCsv, dbPath, {
        pastDir: newPast,
        verify: (db) => {
          if (hasDb && !opt.force) checkDecrease(dbPath, db);
        },
      });
      for (const f of r.skipped) warnings.push(`${f} は統合CSVと期間が重なるため使っていません`);
      // ここで中断しても、次回に再び差分として検出され、同じ結果になる
      for (const n of merged.changed) await replaceFile(`${newCsv}/${n}`, `${csvDir}/${n}`);
      for (const n of pastChanged) await replaceFile(`${newPast}/${n}`, `${pastDir}/${n}`);
    }
    return { commit: merged.commit, changed, warnings };
  } finally {
    Deno.removeSync(staging, { recursive: true });
  }
}

/** 書きかけのCSVが見えないように置き換える */
async function replaceFile(from: string, to: string) {
  await Deno.copyFile(from, `${to}.part`);
  await Deno.rename(`${to}.part`, to);
}

if (import.meta.main) {
  const force = Deno.args.includes("--force");
  const [csvDir = "output_merge", dbPath = "data/survey.db", pastDir = "fiscalyearly"] = Deno.args
    .filter((a) => a !== "--force");
  const st = await update({ csvDir, dbPath, pastDir, force });
  const at = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" });
  for (const w of st.warnings) console.warn(`[update ${at}] 警告: ${w}`);
  if (st.ok) {
    const what = st.changed.length ? `更新: ${st.changed.join(", ")}` : "変更なし";
    console.log(`[update ${at}] ${what} (commit ${st.commit!.slice(0, 8)})`);
  } else {
    console.error(`[update ${at}] 失敗: ${st.error}`);
    Deno.exit(1);
  }
}
