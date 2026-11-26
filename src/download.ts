/** 一括ダウンロード用のgzipファイル。DBを作り直すたびに作り直す。 */
import { DatabaseSync } from "node:sqlite";

export interface DownloadFile {
  name: string;
  description: string;
  /** gzip後のバイト数 */
  size: number;
  /** 展開後のバイト数 */
  raw_size: number;
}
export interface Manifest {
  /** 元にしたDBのバージョン(ファイルの更新時刻とサイズ) */
  db_version: string;
  created_at: string;
  files: DownloadFile[];
}

export const downloadDir = (dbPath: string) =>
  `${dbPath.includes("/") ? dbPath.slice(0, dbPath.lastIndexOf("/")) : "."}/download`;

function dbVersion(dbPath: string): string {
  const s = Deno.statSync(dbPath);
  return `${s.mtime?.getTime()}:${s.size}`;
}

export function readManifest(dbPath: string): Manifest | null {
  try {
    return JSON.parse(Deno.readTextFileSync(`${downloadDir(dbPath)}/manifest.json`));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound || e instanceof SyntaxError) return null;
    throw e;
  }
}

/** バイト列の流れを gzip にしてファイルへ書き、展開後と圧縮後のサイズを返す */
async function writeGzip(path: string, src: ReadableStream<Uint8Array>) {
  let raw = 0;
  const counted = src.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        raw += chunk.byteLength;
        c.enqueue(chunk);
      },
    }),
  );
  const part = `${path}.part`;
  const f = await Deno.open(part, { create: true, write: true, truncate: true });
  await counted.pipeThrough(
    new CompressionStream("gzip") as TransformStream<Uint8Array, Uint8Array>,
  )
    .pipeTo(f.writable);
  await Deno.rename(part, path);
  return { raw_size: raw, size: Deno.statSync(path).size };
}

/** survey テーブル全体をCSV(BOM付き)の流れにする */
function surveyCsv(dbPath: string): ReadableStream<Uint8Array> {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const stmt = db.prepare("SELECT * FROM survey ORDER BY id");
  const cols = stmt.columns().map((c) => c.name);
  const rows = stmt.iterate();
  const enc = new TextEncoder();
  const cell = (v: unknown): string => {
    const t = v === null || v === undefined ? "" : String(v);
    return /[",\r\n]/.test(t) ? `"${t.replaceAll('"', '""')}"` : t;
  };
  let header = true;
  return new ReadableStream({
    pull(c) {
      if (header) {
        header = false;
        c.enqueue(enc.encode("﻿" + cols.map(cell).join(",") + "\r\n"));
        return;
      }
      const lines: string[] = [];
      for (let i = 0; i < 2000; i++) {
        const r = rows.next();
        if (r.done) break;
        const row = r.value as Record<string, unknown>;
        lines.push(cols.map((k) => cell(row[k])).join(","));
      }
      if (lines.length) c.enqueue(enc.encode(lines.join("\r\n") + "\r\n"));
      else {
        db.close();
        c.close();
      }
    },
    cancel() {
      db.close();
    },
  });
}

/** ダウンロード用ファイルが無いか古ければ作り直す。作り直したら true */
export async function ensureDownloads(dbPath: string): Promise<boolean> {
  const version = dbVersion(dbPath);
  if (readManifest(dbPath)?.db_version === version) return false;
  const dir = downloadDir(dbPath);
  Deno.mkdirSync(dir, { recursive: true });
  const files: DownloadFile[] = [];

  const db = await Deno.open(dbPath, { read: true });
  files.push({
    name: "survey.db.gz",
    description: "SQLiteデータベース(survey / comments / import_info テーブル)",
    ...await writeGzip(`${dir}/survey.db.gz`, db.readable),
  });
  files.push({
    name: "survey.csv.gz",
    description: "survey テーブルのCSV(BOM付きUTF-8、派生列+元の126列)",
    ...await writeGzip(`${dir}/survey.csv.gz`, surveyCsv(dbPath)),
  });

  const manifest: Manifest = { db_version: version, created_at: new Date().toISOString(), files };
  Deno.writeTextFileSync(`${dir}/manifest.json.part`, JSON.stringify(manifest, null, 1));
  Deno.renameSync(`${dir}/manifest.json.part`, `${dir}/manifest.json`);
  return true;
}
