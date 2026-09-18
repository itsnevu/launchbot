import { CFG } from "./config.js";
import { pons } from "./chains/pons.js";
import { argus } from "./chains/argus.js";
import { createBot } from "./bot.js";
import { errMsg } from "./security.js";

if (!/^\d{8,11}:[A-Za-z0-9_-]{35}$/.test(CFG.botToken || "")) {
  console.error("BOT_TOKEN di .env kosong/tidak valid (format: 123456789:AAxxxxxxxx…, dapat dari @BotFather).");
  process.exit(1);
}

const PLATFORMS = { pons, argus };

// Self-check tiap platform saat startup (RPC, chainId, kontrak/selector). Gagal → platform dinonaktifkan, bukan crash.
for (const p of Object.values(PLATFORMS)) {
  try { p.health = { ok: true, msg: await p.selfCheck() }; console.log(`[${p.id}] ✅ ${p.health.msg}`); }
  catch (e) { p.health = { ok: false, msg: errMsg(e) }; console.error(`[${p.id}] ⚠️ ${p.health.msg} — platform dinonaktifkan sampai check lolos.`); }
}

const { bot, storage } = createBot(PLATFORMS);

const shutdown = async (sig) => {
  const busy = storage.readAll().filter((s) => s.busy).length;
  console.log(`${sig}: berhenti${busy ? ` (⚠️ ${busy} launch masih berjalan — tx yang sudah terkirim tetap jalan di chain)` : ""}...`);
  await bot.stop();
  process.exit(0);
};
process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

bot.start({ onStart: () => console.log(`Bot jalan. Platform: pons v2 (4663), Argus (5042). Sesi idle ${CFG.sessionTtlMs / 60_000} mnt → key dihapus.`) });
