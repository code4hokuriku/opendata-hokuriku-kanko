/** 一括ダウンロード用のZIPファイル。DBを作り直すたびに作り直す。 */
import { DatabaseSync } from "node:sqlite";

export interface DownloadFile {
  name: string;
  description: string;
  /** ZIPファイルのバイト数 */
  size: number;
  /** 展開後のバイト数 */
  raw_size: number;
}
/** ファイルの形式を変えたら上げる(古い形式のものを作り直すため) */
const FORMAT = 2;

export interface Manifest {
  format?: number;
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

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(crc: number, b: Uint8Array): number {
  let c = ~crc;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

/** 日本時間の日時 → ZIPのDOS形式(時刻, 日付) */
function dosTime(d: Date): [number, number] {
  const j = new Date(d.getTime() + 9 * 3600_000);
  return [
    (j.getUTCHours() << 11) | (j.getUTCMinutes() << 5) | (j.getUTCSeconds() >> 1),
    ((j.getUTCFullYear() - 1980) << 9) | ((j.getUTCMonth() + 1) << 5) | j.getUTCDate(),
  ];
}

async function writeAll(f: Deno.FsFile, b: Uint8Array) {
  for (let off = 0; off < b.length;) off += await f.write(b.subarray(off));
}

/**
 * ファイル1つを収めたZIPを書き、展開後と圧縮後のサイズを返す。
 * 圧縮しながら書き、CRCとサイズは最後にローカルヘッダーへ書き戻す。ZIP64は使わない(4GB未満)。
 */
async function writeZip(path: string, entry: string, src: ReadableStream<Uint8Array>) {
  const name = new TextEncoder().encode(entry);
  const [time, date] = dosTime(new Date());
  const local = new Uint8Array(30 + name.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true); // 展開に必要なバージョン 2.0
  lv.setUint16(6, 0x0800, true); // ファイル名はUTF-8
  lv.setUint16(8, 8, true); // deflate
  lv.setUint16(10, time, true);
  lv.setUint16(12, date, true);
  lv.setUint16(26, name.length, true);
  local.set(name, 30);

  let crc = 0, raw = 0, packed = 0;
  const counted = src.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, c) {
        crc = crc32(crc, chunk);
        raw += chunk.byteLength;
        c.enqueue(chunk);
      },
    }),
  ).pipeThrough(new CompressionStream("deflate-raw") as TransformStream<Uint8Array, Uint8Array>);

  const part = `${path}.part`;
  const f = await Deno.open(part, { create: true, write: true, truncate: true });
  try {
    await writeBody(f);
  } catch (e) {
    f.close();
    await Deno.remove(part).catch(() => {});
    throw e;
  }
  f.close();
  await Deno.rename(part, path);
  return { raw_size: raw, size: Deno.statSync(path).size };

  async function writeBody(f: Deno.FsFile) {
    await writeAll(f, local);
    for await (const chunk of counted) {
      packed += chunk.byteLength;
      await writeAll(f, chunk);
    }
    if (raw >= 0xffffffff || packed >= 0xffffffff) throw new Error(`${entry} が4GBを超えます`);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // 作成したバージョン
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 8, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, packed, true);
    cv.setUint32(24, raw, true);
    cv.setUint16(28, name.length, true);
    cv.setUint32(42, 0, true); // ローカルヘッダーの位置
    central.set(name, 46);
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(8, 1, true);
    ev.setUint16(10, 1, true);
    ev.setUint32(12, central.length, true);
    ev.setUint32(16, local.length + packed, true);
    await writeAll(f, central);
    await writeAll(f, end);

    const fix = new Uint8Array(12);
    const fv = new DataView(fix.buffer);
    fv.setUint32(0, crc, true);
    fv.setUint32(4, packed, true);
    fv.setUint32(8, raw, true);
    await f.seek(14, Deno.SeekMode.Start);
    await writeAll(f, fix);
  }
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
  const prev = readManifest(dbPath);
  if (prev?.db_version === version && prev.format === FORMAT) return false;
  const dir = downloadDir(dbPath);
  Deno.mkdirSync(dir, { recursive: true });
  const files: DownloadFile[] = [];

  const db = await Deno.open(dbPath, { read: true });
  files.push({
    name: "survey.db.zip",
    description: "SQLiteデータベース(survey / comments / import_info テーブル)",
    ...await writeZip(`${dir}/survey.db.zip`, "survey.db", db.readable),
  });
  files.push({
    name: "survey.csv.zip",
    description: "survey テーブルのCSV(BOM付きUTF-8、派生列+元の126列)",
    ...await writeZip(`${dir}/survey.csv.zip`, "survey.csv", surveyCsv(dbPath)),
  });

  const manifest: Manifest = {
    format: FORMAT,
    db_version: version,
    created_at: new Date().toISOString(),
    files,
  };
  Deno.writeTextFileSync(`${dir}/manifest.json.part`, JSON.stringify(manifest, null, 1));
  Deno.renameSync(`${dir}/manifest.json.part`, `${dir}/manifest.json`);
  // 以前の形式など、一覧にないファイルを消す
  const keep = new Set(["manifest.json", ...files.map((f) => f.name)]);
  for (const e of Deno.readDirSync(dir)) {
    if (e.isFile && !keep.has(e.name)) Deno.removeSync(`${dir}/${e.name}`);
  }
  return true;
}
