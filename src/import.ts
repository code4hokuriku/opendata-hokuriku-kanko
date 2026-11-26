/** output_merge/*.csv と fiscalyearly/*.csv から SQLite データベースを作る: deno task import [csvDir] [dbPath] [pastDir] */
import { ensureDownloads } from "./download.ts";
import { DatabaseSync } from "node:sqlite";
import { CsvParseStream } from "@std/csv";
import { COMMENT_FIELDS, DERIVED_COLUMNS, FLAG_GROUPS, isFlag, q, RAW_COLUMNS } from "./columns.ts";
import { convertFukui, missingColumns, PAST_END, PAST_FILES } from "./fukui_fiscal.ts";
import { derive, type Value } from "./normalize.ts";

export interface ImportResult {
  files: { file: string; rows: number }[];
  rows: number;
  comments: number;
  duplicates: number;
  /** 統合CSVと期間が重なるため使わなかったファイル */
  skipped: string[];
}

function dirOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) || "/" : ".";
}

function removeIfExists(path: string) {
  try {
    Deno.removeSync(path);
  } catch (e) {
    if (!(e instanceof Deno.errors.NotFound)) throw e;
  }
}

/** 取り込みと自動更新が同時に走らないようにする(プロセス終了時は自動で解放される) */
export async function withLock<T>(dbPath: string, fn: () => Promise<T>): Promise<T> {
  Deno.mkdirSync(dirOf(dbPath), { recursive: true });
  using f = await Deno.open(`${dbPath}.lock`, { create: true, write: true });
  await f.lock(true);
  return await fn();
}

export interface ImportOptions {
  /** 福井県の年度別CSVのフォルダ。省略時は過去データなし */
  pastDir?: string;
  /** 例外を投げると、既存DBを置き換えずに終わる */
  verify?: (db: DatabaseSync) => void;
}

export async function importCsv(
  csvDir: string,
  dbPath: string,
  opt: ImportOptions = {},
): Promise<ImportResult> {
  const files = [...Deno.readDirSync(csvDir)]
    .filter((e) => e.isFile && /^merged_survey_\d{4}\.csv$/.test(e.name))
    .map((e) => e.name).sort();
  if (files.length === 0) throw new Error(`${csvDir} に merged_survey_YYYY.csv がありません`);

  const pastFiles = opt.pastDir
    ? [...Deno.readDirSync(opt.pastDir)].map((e) => e.name).filter((n) => PAST_FILES.includes(n))
    : [];
  Deno.mkdirSync(dirOf(dbPath), { recursive: true });
  // 途中で失敗しても既存DBを壊さないよう、別名で作って最後に置き換える
  const tmp = dbPath + ".tmp";
  removeIfExists(tmp);
  const db = new DatabaseSync(tmp);
  let result: ImportResult;
  try {
    result = await build(db, csvDir, files, opt.pastDir, pastFiles);
    opt.verify?.(db);
  } catch (e) {
    db.close();
    removeIfExists(tmp);
    throw e;
  }
  db.close();
  Deno.renameSync(tmp, dbPath);
  return result;
}

async function build(
  db: DatabaseSync,
  csvDir: string,
  files: string[],
  pastDir: string | undefined,
  pastFiles: string[],
): Promise<ImportResult> {
  db.exec("PRAGMA page_size = 8192; PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;");
  const defs = [
    ...DERIVED_COLUMNS.map((c) => `${q(c.name)} ${c.type}${c.name === "id" ? " PRIMARY KEY" : ""}`),
    ...RAW_COLUMNS.map((c) => `${q(c)} ${isFlag(c) ? "INTEGER" : "TEXT"}`),
  ];
  db.exec(`CREATE TABLE survey (${defs.join(", ")});
    CREATE TABLE comments (
      id INTEGER PRIMARY KEY,
      survey_id INTEGER NOT NULL REFERENCES survey(id),
      field TEXT NOT NULL,
      text TEXT NOT NULL
    );
    CREATE TABLE import_info (key TEXT PRIMARY KEY, value TEXT);`);

  const names = [...DERIVED_COLUMNS.map((c) => c.name), ...RAW_COLUMNS];
  const insert = db.prepare(
    `INSERT INTO survey (${names.map(q).join(",")}) VALUES (${names.map(() => "?").join(",")})`,
  );
  const insertComment = db.prepare(
    "INSERT INTO comments (survey_id, field, text) VALUES (?, ?, ?)",
  );

  const seen = new Set<string>();
  const result: ImportResult = { files: [], rows: 0, comments: 0, duplicates: 0, skipped: [] };

  async function add(r: Record<string, string>, file: string, year: number, n: number) {
    const id = ++result.rows;
    const key = await digest(RAW_COLUMNS.map((c) => r[c]));
    const dup = seen.has(key) ? 1 : 0;
    seen.add(key);
    result.duplicates += dup;

    let d: Record<string, Value>;
    try {
      d = derive(r);
    } catch (e) {
      throw new Error(`${file} の${n}行目: ${(e as Error).message}`);
    }
    Object.assign(d, {
      id,
      source_file: file,
      source_year: year,
      source_row: n,
      is_duplicate: dup,
    });
    insert.run(
      ...DERIVED_COLUMNS.map((c) => d[c.name]),
      ...RAW_COLUMNS.map((c) => r[c] === "" ? null : isFlag(c) ? Number(r[c]) : r[c]),
    );
    for (const c of COMMENT_FIELDS) {
      const text = r[c].trim();
      if (text) {
        insertComment.run(id, c, text);
        result.comments++;
      }
    }
  }

  db.exec("BEGIN");
  for (const file of files) {
    const year = Number(file.match(/\d{4}/)![0]);
    let n = 0;
    let header = true;
    for await (const row of readCsv(`${csvDir}/${file}`)) {
      if (header) {
        checkHeader(file, row);
        header = false;
        continue;
      }
      n++;
      checkWidth(file, n, row, RAW_COLUMNS.length);
      await add(Object.fromEntries(RAW_COLUMNS.map((c, i) => [c, row[i]])), file, year, n);
    }
    result.files.push({ file, rows: n });
    console.log(`${file}: ${n} 件`);
  }

  // 福井県の過去データ。統合CSVに同じ期間が入ったら二重計上になるので使わない
  const overlap = db.prepare(
    "SELECT count(*) AS n FROM survey WHERE prefecture = '福井' AND answered_date < ?",
  ).get(PAST_END)!.n as number;
  for (const name of pastFiles) {
    const file = `fukui_fiscalyearly_${name}`;
    if (overlap > 0) {
      result.skipped.push(file);
      console.warn(
        `${file}: 統合CSVに${PAST_END}より前の福井データが${overlap}件あるため使いません`,
      );
      continue;
    }
    let n = 0, rows = 0;
    let header: string[] | null = null;
    for await (const row of readCsv(`${pastDir}/${name}`)) {
      if (!header) {
        header = row;
        const missing = missingColumns(header);
        if (missing.length) throw new Error(`${file}: 列がありません [${missing}]`);
        continue;
      }
      n++;
      checkWidth(file, n, row, header.length);
      if (row.every((v) => v === "")) continue; // 元データにまれにある空行
      const r = convertFukui(
        Object.fromEntries(header.map((c, i) => [c, row[i]])),
        Object.values(FLAG_GROUPS),
      );
      await add(r, file, Number(name.slice(0, 4)), n);
      rows++;
    }
    const late = db.prepare(
      "SELECT count(*) AS n FROM survey WHERE source_file = ? AND answered_date >= ?",
    ).get(file, PAST_END)!.n as number;
    if (late > 0) {
      throw new Error(`${file}: ${PAST_END}以降の回答が${late}件あり、統合CSVと重複します`);
    }
    result.files.push({ file, rows });
    console.log(`${file}: ${rows} 件`);
  }
  const info = db.prepare("INSERT INTO import_info VALUES (?, ?)");
  info.run("imported_at", new Date().toISOString());
  info.run("files", JSON.stringify(result.files));
  db.exec(`COMMIT;
    CREATE INDEX survey_pref_date ON survey (prefecture, answered_date);
    CREATE INDEX survey_date ON survey (answered_date);
    CREATE INDEX comments_survey ON comments (survey_id);
    ANALYZE;`);
  return result;
}

async function* readCsv(path: string): AsyncGenerator<string[]> {
  const f = await Deno.open(path);
  const stream = f.readable
    .pipeThrough(new TextDecoderStream("utf-8", { fatal: true })) // 先頭のBOMは除かれる
    .pipeThrough(new CsvParseStream({ lazyQuotes: true }));
  for await (const row of stream) yield row;
}

function checkWidth(file: string, n: number, row: string[], expected: number) {
  if (row.length !== expected) {
    throw new Error(`${file} の${n}行目: 列数が ${row.length} です(期待値 ${expected})`);
  }
}

function checkHeader(file: string, row: string[]) {
  const h = row.map((c, i) => i === 0 ? c.replace(/^﻿/, "") : c);
  const missing = RAW_COLUMNS.filter((c) => !h.includes(c));
  const extra = h.filter((c) => !RAW_COLUMNS.includes(c));
  if (missing.length || extra.length || h.some((c, i) => c !== RAW_COLUMNS[i])) {
    throw new Error(
      `${file}: ヘッダーが想定と異なります 不足=[${missing}] 追加=[${extra}]` +
        `(src/columns.ts の RAW_COLUMNS を確認してください)`,
    );
  }
}

async function digest(row: string[]): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(row)));
  return new Uint8Array(buf).toHex();
}

if (import.meta.main) {
  const [csvDir = "output_merge", dbPath = "data/survey.db", pastDir = "fiscalyearly"] = Deno.args;
  const hasPast = PAST_FILES.every((f) => {
    try {
      return Deno.statSync(`${pastDir}/${f}`).isFile;
    } catch {
      return false;
    }
  });
  if (!hasPast) {
    console.error(`${pastDir}/ に ${PAST_FILES.join(", ")} がありません(deno task update で取得)`);
    Deno.exit(1);
  }
  const t = performance.now();
  const r = await withLock(dbPath, async () => {
    const r = await importCsv(csvDir, dbPath, { pastDir });
    await ensureDownloads(dbPath);
    return r;
  });
  console.log(
    `完了: ${r.rows} 件 / 自由記述 ${r.comments} 件 / 完全重複 ${r.duplicates} 件 → ${dbPath}` +
      ` (${((performance.now() - t) / 1000).toFixed(1)}秒)`,
  );
}
