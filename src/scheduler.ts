/** サーバー稼働中の自動更新。更新処理は別プロセスで行い、APIの応答を止めない。 */
import { isDue, readStatus } from "./update_status.ts";

const POLL_MS = 5 * 60_000; // スリープ復帰後もすぐ追いつけるよう、短い間隔で期限を判定する

export function startAutoUpdate(csvDir: string, dbPath: string, pastDir: string) {
  const db = Deno.realPathSync(dbPath);
  const csv = Deno.realPathSync(csvDir);
  const past = Deno.realPathSync(".") + "/" + pastDir; // まだ無いこともある
  const dbDir = db.slice(0, db.lastIndexOf("/"));
  let lastTry = 0;

  const tick = async () => {
    try {
      // 記録が書けずに終わった場合でも、1時間以内には再試行しない
      if (Date.now() - lastTry >= 3600_000 && isDue(readStatus(db), Date.now())) {
        lastTry = Date.now();
        await new Deno.Command("deno", {
          args: [
            "run",
            "--no-prompt",
            `--allow-read=${dbDir},${csv},${past}`,
            `--allow-write=${dbDir},${csv},${past}`,
            "--allow-net=api.github.com,raw.githubusercontent.com",
            `${import.meta.dirname}/update.ts`,
            csv,
            db,
            past,
          ],
          stdin: "null",
          stdout: "inherit",
          stderr: "inherit",
        }).spawn().status;
      }
    } catch (e) {
      console.error("自動更新でエラー:", e);
    }
    setTimeout(tick, POLL_MS);
  };
  tick();
}
