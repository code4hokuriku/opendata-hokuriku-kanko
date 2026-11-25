/** 自動更新の記録と、次に確認すべき時刻の判定 */

export interface UpdateStatus {
  checked_at: string;
  ok: boolean;
  /** 今回変わったファイル */
  changed: string[];
  commit: string | null;
  last_ok_at: string | null;
  /** 最後に内容が変わった日時 */
  updated_at: string | null;
  error: string | null;
  /** 更新はできたが知っておくべきこと */
  warnings: string[];
}

const statusPath = (dbPath: string) => `${dbPath}.update.json`;

export function readStatus(dbPath: string): UpdateStatus | null {
  try {
    return JSON.parse(Deno.readTextFileSync(statusPath(dbPath)));
  } catch (e) {
    if (e instanceof Deno.errors.NotFound || e instanceof SyntaxError) return null;
    throw e;
  }
}

export function writeStatus(dbPath: string, st: UpdateStatus) {
  const p = statusPath(dbPath);
  Deno.writeTextFileSync(`${p}.part`, JSON.stringify(st, null, 1));
  Deno.renameSync(`${p}.part`, p);
}

const HOUR = 3600_000;
const DAY = 24 * HOUR;
/** 上流の更新は6時(JST)予定だが、実際の反映は9〜14時ごろになるため15時に確認する */
const CHECK_UTC = 6 * HOUR; // 15:00 JST

/** 直近の定時(15時JST)を過ぎたか */
function lastSlot(now: number): number {
  return Math.floor((now - CHECK_UTC) / DAY) * DAY + CHECK_UTC;
}

/** 今確認すべきか。失敗時は1時間おき、今日分がまだ無ければ3時間おきに再確認する */
export function isDue(st: UpdateStatus | null, now: number): boolean {
  if (!st) return true;
  const checked = Date.parse(st.checked_at);
  if (!Number.isFinite(checked)) return true;
  if (!st.ok) return now - checked >= HOUR;
  const slot = lastSlot(now);
  if (checked < slot) return true;
  const updated = st.updated_at ? Date.parse(st.updated_at) : 0;
  // 定時後(定時前の当日分も含む)に更新が取れていれば、次の定時まで待つ
  if (updated >= slot - 6.5 * HOUR) return false;
  return now - checked >= 3 * HOUR;
}
