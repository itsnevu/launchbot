// Alur percakapan end-to-end tanpa Telegram & tanpa RPC: API di-stub lewat transformer grammY, platform palsu.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HISTORY_FILE = join(mkdtempSync(join(tmpdir(), "launch-bot-")), "h.jsonl");
process.env.ALLOWED_USER_IDS = "";
const { createBot } = await import("../src/bot.js");

const PK = "0x" + "ab".repeat(32);
const TOKEN_ADDR = "0x" + "11".repeat(20);
const TX = "0x" + "cd".repeat(32);

function fakePlatform(id, launchImpl) {
  return {
    id, label: `${id} (fake)`, nativeSymbol: "ETH", explorer: "https://explorer.test", health: { ok: true, msg: "" },
    provider: () => null, selfCheck: async () => "ok",
    walletInfo: async () => "1.0 ETH",
    precheck: async (w, d) => ({ ok: true, text: `Saldo 1.0 ETH | Butuh ≈ ${d.devBuy} + fee` }),
    launch: launchImpl || (async (wallet, data, onStatus, { dryRun }) => {
      await onStatus("⏳ simulasi...");
      return {
        token: TOKEN_ADDR, curve: "0x" + "22".repeat(20), tokensOut: "1234.5", devBuy: String(data.devBuy), fee: "0.0005",
        gas: "3600000", gasCost: "0.0002", totalCost: "0.0107", dryRun, txHash: dryRun ? undefined : TX,
        links: { token: "https://explorer.test/token/x", tx: dryRun ? undefined : `https://explorer.test/tx/${TX}` },
        note: "",
      };
    }),
  };
}

// Harness: kumpulkan semua panggilan API, balas dengan objek minimal.
function harness(platforms) {
  const { bot, storage } = createBot(platforms, { token: "123456789:AAtesttesttesttesttesttesttesttesttes", botInfo: { id: 1, is_bot: true, first_name: "t", username: "t_bot", can_join_groups: false, can_read_all_group_messages: false, supports_inline_queries: false } });
  const calls = [];
  let mid = 100;
  bot.api.config.use(async (prev, method, payload) => {
    calls.push({ method, payload });
    if (method === "sendMessage") return { ok: true, result: { message_id: ++mid, chat: { id: payload.chat_id, type: "private" }, date: 1, text: payload.text } };
    return { ok: true, result: true };
  });
  let uid = 1;
  const chat = (id = 7, type = "private") => ({ id, type });
  const from = (id = 7) => ({ id, is_bot: false, first_name: "u" });
  const api = {
    calls, storage,
    sent: () => calls.filter((c) => c.method === "sendMessage").map((c) => c.payload),
    last: () => api.sent().at(-1),
    async text(t, { chatId = 7, userId = 7, type = "private" } = {}) {
      const ents = t.startsWith("/") ? [{ type: "bot_command", offset: 0, length: t.split(" ")[0].length }] : [];
      await bot.handleUpdate({ update_id: ++uid, message: { message_id: ++mid, date: 1, chat: chat(chatId, type), from: from(userId), text: t, entities: ents } });
    },
    async cb(data, { chatId = 7, userId = 7 } = {}) {
      await bot.handleUpdate({ update_id: ++uid, callback_query: { id: String(uid), from: from(userId), chat_instance: "x", data, message: { message_id: 1, date: 1, chat: chat(chatId), text: "kb" } } });
    },
    async photo({ chatId = 7, userId = 7 } = {}) {
      await bot.handleUpdate({ update_id: ++uid, message: { message_id: ++mid, date: 1, chat: chat(chatId), from: from(userId), photo: [{ file_id: "f", file_unique_id: "u", width: 1, height: 1 }] } });
    },
    session: (chatId = 7) => storage.read(String(chatId)),
    async untilSent(pred, ms = 2000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (api.sent().some(pred)) return; await new Promise((r) => setTimeout(r, 10)); } throw new Error("pesan tidak muncul: " + pred); },
  };
  return api;
}

// Jalankan flow pons lengkap sampai layar konfirmasi.
async function toConfirm(api) {
  await api.text("/start");
  assert.match(api.last().text, /Pilih platform/);
  await api.cb("pf:pons");
  assert.match(api.last().text, /PRIVATE KEY/);
  await api.text(PK);
  assert.ok(api.calls.some((c) => c.method === "deleteMessage"), "pesan key harus dihapus");
  assert.match(api.last().text, /Nama token/);
  assert.equal(api.session().pk, PK);
  for (const t of ["Meme Coin", "meme", "-", "-", "-", "-", "-", "-", "-"]) await api.text(t); // nama..farcaster
  assert.match(api.last().text, /Creator tax/);
  await api.cb("opt:300");
  assert.match(api.last().text, /penerima fee/i);
  await api.text("-"); // pakai launcher
  assert.match(api.last().text, /buyback/i);
  await api.cb("opt:y");
  await api.text("-"); // exemptions
  assert.match(api.last().text, /Pair token/);
  await api.cb("opt:eth");
  await api.text("0.01"); // dev buy
  assert.match(api.last().text, /Konfirmasi launch/);
  assert.match(api.last().text, /Creator tax: 300 bps \(3%\)/);
  assert.match(api.last().text, /Saldo 1.0 ETH/);
  assert.equal(api.session().step, "confirm");
}

test("flow pons: start → key → step → konfirmasi → ubah field → simulasi → launch → sesi bersih + riwayat", async () => {
  const api = harness({ pons: fakePlatform("pons") });
  await toConfirm(api);

  // ubah nama lewat tombol
  await api.cb("launch:edit");
  assert.match(api.last().text, /Mau ubah yang mana/);
  await api.cb("edit:symbol");
  assert.match(api.last().text, /Symbol/);
  await api.text("pepe");
  assert.match(api.last().text, /Konfirmasi launch/);
  assert.match(api.last().text, /Symbol: PEPE/);

  // simulasi: tidak reset sesi, konfirmasi muncul lagi
  await api.cb("launch:sim");
  await api.untilSent((m) => /SIMULASI OK/.test(m.text));
  await api.untilSent((m) => /Konfirmasi launch/.test(m.text) && api.sent().indexOf(m) > api.sent().findIndex((x) => /SIMULASI OK/.test(x.text)));
  assert.equal(api.session().pk, PK, "simulasi tidak boleh hapus key");
  assert.equal(api.session().busy, false);

  // launch sungguhan
  await api.cb("launch:go");
  await api.untilSent((m) => /LAUNCHED/.test(m.text));
  const res = api.sent().find((m) => /LAUNCHED/.test(m.text));
  assert.equal(res.parse_mode, "HTML");
  assert.match(res.text, new RegExp(`<code>${TOKEN_ADDR}</code>`));
  assert.match(res.text, /href="https:\/\/explorer.test\/tx\//);
  assert.match(res.text, /PEPE/);
  assert.equal(api.session().pk, null, "key harus dihapus setelah launch");
  assert.equal(api.session().step, null);

  // riwayat tercatat
  await api.text("/history");
  assert.match(api.last().text, /PEPE/);
  assert.match(api.last().text, new RegExp(TOKEN_ADDR));
});

test("tekan LAUNCH 2x cepat → hanya 1 launch", async () => {
  let n = 0;
  const api = harness({ pons: fakePlatform("pons", async (w, d, onStatus, { dryRun }) => { n++; await new Promise((r) => setTimeout(r, 50)); return { token: TOKEN_ADDR, curve: "0x", tokensOut: "1", devBuy: "0", fee: "0", gas: "1", gasCost: "0", totalCost: "0", dryRun, txHash: TX, links: { token: "https://x", tx: "https://x" } }; }) });
  await toConfirm(api);
  await Promise.all([api.cb("launch:go"), api.cb("launch:go")]);
  await api.untilSent((m) => /LAUNCHED/.test(m.text));
  assert.equal(n, 1);
  assert.ok(api.calls.some((c) => c.method === "answerCallbackQuery" && /Masih diproses/.test(c.payload.text || "")));
});

test("tx pending (timeout) → pesan pending + link, bukan ❌; riwayat status pending", async () => {
  const api = harness({ pons: fakePlatform("pons", async () => { const e = new Error("Launch belum terkonfirmasi dalam 180 dtk. Cek explorer: " + TX); e.pending = true; e.hash = TX; throw e; }) });
  await toConfirm(api);
  await api.cb("launch:go");
  await api.untilSent((m) => /belum terkonfirmasi/.test(m.text));
  const m = api.sent().find((x) => /belum terkonfirmasi/.test(x.text));
  assert.doesNotMatch(m.text, /❌/);
  assert.match(m.text, new RegExp(`explorer.test/tx/${TX}`));
  assert.equal(api.session().pk, null);
});

test("error launch → pesan error diredaksi (key tidak bocor), sesi di-reset", async () => {
  const api = harness({ pons: fakePlatform("pons", async () => { throw new Error("boom " + PK); }) });
  await toConfirm(api);
  await api.cb("launch:go");
  await api.untilSent((m) => /Error/.test(m.text));
  const m = api.sent().find((x) => /Error/.test(x.text));
  assert.doesNotMatch(m.text, new RegExp(PK.slice(2), "i"));
  assert.match(m.text, /REDACTED/);
  assert.equal(api.session().pk, null);
});

test("grup ditolak; user lain tidak bisa tekan tombol sesi orang; foto di luar step logo ditolak", async () => {
  const api = harness({ pons: fakePlatform("pons") });
  await api.text("/start", { chatId: -100, type: "supergroup" });
  assert.match(api.last().text, /chat pribadi/);
  assert.equal(api.storage.readAllKeys().includes("-100"), false, "grup tidak boleh bikin sesi");

  await toConfirm(api);
  const before = api.sent().length;
  await api.cb("launch:go", { userId: 999 }); // orang lain di chat yang sama (ownerId = 7)
  assert.equal(api.sent().length, before, "tidak ada balasan untuk non-owner");
  assert.equal(api.session().busy, false);

  await api.photo();
  assert.match(api.last().text, /hanya saat ditanya logo/);
});

test("validasi input salah → pesan ❌ dan step tidak maju; /cancel hapus key", async () => {
  const api = harness({ pons: fakePlatform("pons") });
  await api.text("/start"); await api.cb("pf:pons");
  await api.text("bukan-key");
  assert.match(api.last().text, /Private key tidak valid/);
  await api.text(PK);
  await api.text("A"); // nama terlalu pendek
  assert.match(api.last().text, /❌ Nama 2–32/);
  assert.equal(api.session().step, "name");
  await api.text("/cancel");
  assert.equal(api.session().pk, null);
  assert.match(api.last().text, /Key dihapus/);
});

test("flow /manage: platform → key → token → status → jual → klaim → selesai (key dihapus)", async () => {
  const p = fakePlatform("pons");
  p.status = async (w, token) => ({ text: `Token: FAKE ${token.slice(0, 6)}\nSaldo kamu: 100 FAKE` });
  p.sell = async (w, token, pct, onStatus) => { await onStatus("🔎 Quote jual..."); return { txHash: TX, amountIn: String(pct), text: `✅ Terjual ${pct}%`, links: { tx: `https://explorer.test/tx/${TX}` } }; };
  p.claim = async () => { throw new Error("Belum ada fee creator yang bisa diklaim."); };
  const api = harness({ pons: p });
  await api.text("/manage");
  assert.match(api.last().text, /Kelola token/);
  await api.cb("mpf:pons");
  assert.match(api.last().text, /PRIVATE KEY/);
  await api.text(PK);
  assert.match(api.last().text, /alamat token/i);
  assert.equal(api.session().mode, "manage");
  await api.text("bukan-alamat");
  assert.match(api.last().text, /tidak valid/);
  await api.text(TOKEN_ADDR);
  assert.match(api.last().text, /Saldo kamu: 100 FAKE/);
  assert.equal(api.session().step, "mmenu");
  await api.cb("m:sell:50");
  await api.untilSent((m) => /Terjual 50%/.test(m.text));
  await api.untilSent((m) => m.text.includes("Saldo kamu") && api.sent().indexOf(m) > api.sent().findIndex((x) => /Terjual/.test(x.text)));
  assert.equal(api.session().pk, PK, "key tetap di sesi selama menu kelola");
  await api.cb("m:claim");
  await api.untilSent((m) => /Belum ada fee/.test(m.text));
  await api.cb("m:done");
  assert.match(api.last().text, /Key dihapus/);
  assert.equal(api.session().pk, null);
  const rows = (await import("../src/history.js")).readHistory ? await (await import("../src/history.js")).readHistory(7, 50) : [];
  assert.ok(rows.some((r) => r.status === "sell" && r.tx === TX), "jual tercatat di riwayat");
});
