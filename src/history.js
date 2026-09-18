// Riwayat launch: 1 baris JSON per launch di HISTORY_FILE (default ./launches.jsonl).
// Tanpa private key, tanpa data sensitif — hanya siapa/kapan/platform/token/tx.
import { appendFile, readFile } from "node:fs/promises";
import { CFG } from "./config.js";

export async function recordLaunch(entry) {
  try {
    await appendFile(CFG.historyFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch (e) {
    console.error("history: gagal tulis", e.message);
  }
}

export async function readHistory(userId, limit = 10) {
  let raw;
  try { raw = await readFile(CFG.historyFile, "utf8"); } catch { return []; }
  const rows = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { const r = JSON.parse(line); if (!userId || String(r.userId) === String(userId)) rows.push(r); } catch { /* baris rusak, lewati */ }
  }
  return rows.slice(-limit).reverse();
}
