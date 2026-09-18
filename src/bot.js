// Semua handler Telegram. Dipisah dari index.js supaya bisa di-test offline (bot.handleUpdate + API stub, platform palsu).
import { Bot, InlineKeyboard, MemorySessionStorage, session } from "grammy";
import { ethers } from "ethers";
import { CFG } from "./config.js";
import { FLOWS, stepIndex, stepDef, summary } from "./flows.js";
import { walletFromKey, forgetSecret, redact, errMsg, esc } from "./security.js";
import { recordLaunch, readHistory } from "./history.js";
import { uploadTelegramPhoto, ipfsEnabled } from "./ipfs.js";

// platforms: { id: { id, label, nativeSymbol, explorer, health, provider(), selfCheck(), walletInfo(), precheck(), launch() } }
export function createBot(PLATFORMS, { token = CFG.botToken, botInfo } = {}) {
const bot = new Bot(token, botInfo ? { botInfo } : undefined);

// ---------------- sesi ----------------
const storage = new MemorySessionStorage();
const initial = () => ({ step: null, platform: null, data: {}, pk: null, busy: false, ownerId: null, editing: false, mode: "launch", token: null, lastActive: Date.now() });

// Gate dulu (sebelum session): update dari grup / user tak diizinkan tidak pernah membuat entri sesi.
bot.use(async (ctx, next) => {
  if (!ctx.chat) return; // update tanpa chat (my_chat_member, inline query, dll) → abaikan
  if (ctx.chat.type !== "private") {
    // Di grup: private key bisa terbaca anggota lain sebelum dihapus (dan hapus bisa gagal kalau bot bukan admin).
    if (ctx.message?.text?.startsWith("/") || ctx.callbackQuery) await ctx.reply("Bot ini hanya bisa dipakai di chat pribadi (DM). Key tidak boleh dikirim di grup.").catch(() => {});
    return;
  }
  if (CFG.allowedUserIds.length && !CFG.allowedUserIds.includes(String(ctx.from?.id))) return ctx.reply("Akses ditolak.");
  await next();
});
bot.use(session({ initial, storage }));
bot.use(async (ctx, next) => { ctx.session.lastActive = Date.now(); await next(); });

const reset = (s) => { if (s.pk) forgetSecret(s.pk); s.step = null; s.platform = null; s.data = {}; s.pk = null; s.busy = false; s.ownerId = null; s.editing = false; s.mode = "launch"; s.token = null; };

// Sweeper: hapus key dari memori kalau sesi idle > SESSION_TTL (tanpa menunggu user kirim pesan lagi).
// Session key default grammY = chat id → bisa langsung kirim notifikasi ke chat itu.
if (CFG.sessionTtlMs > 0) {
  setInterval(async () => {
    for (const key of storage.readAllKeys()) {
      const s = storage.read(key);
      if (!s || s.busy || !(s.pk || s.step) || Date.now() - s.lastActive < CFG.sessionTtlMs) continue;
      reset(s); storage.delete(key);
      try { await bot.api.sendMessage(key, `⏰ Sesi kadaluarsa (idle ${CFG.sessionTtlMs / 60_000} menit). Key dihapus dari memori. /start untuk mulai lagi.`); } catch { /* chat tidak bisa dihubungi */ }
    }
  }, 60_000).unref();
}

// ---------------- helper ----------------
const kbFromOptions = (opts) => {
  const kb = new InlineKeyboard();
  opts.forEach(([label, value], i) => { kb.text(label, `opt:${value}`); if (i % 4 === 3) kb.row(); });
  return kb;
};

async function askStep(ctx) {
  const s = ctx.session;
  const def = stepDef(s.platform, s.step);
  if (!def) return;
  await ctx.reply(def.ask, def.options ? { reply_markup: kbFromOptions(def.options) } : undefined);
}

// Layar konfirmasi: ringkasan + saldo vs kebutuhan + tombol.
async function showConfirm(ctx) {
  const s = ctx.session;
  const platform = PLATFORMS[s.platform];
  s.step = "confirm"; s.editing = false;
  let pre = "";
  try {
    const wallet = walletFromKey(s.pk, platform.provider());
    const r = await platform.precheck(wallet, s.data);
    pre = `\n\n${r.ok ? "💰" : "⚠️ SALDO KURANG —"} ${r.text}`;
  } catch (e) { pre = `\n\n(gagal cek saldo: ${errMsg(e)})`; }
  const kb = new InlineKeyboard()
    .text("🚀 LAUNCH", "launch:go").text("🔎 Simulasi", "launch:sim").row()
    .text("✏️ Ubah", "launch:edit").text("✖️ Batal", "launch:cancel");
  await ctx.reply(
    "Konfirmasi launch:\n\n" + summary(s.platform, platform.label, s.data) + pre +
    "\n\nTax/alokasi TIDAK bisa diubah setelah launch. Simulasi = cek tanpa kirim tx.",
    { reply_markup: kb, link_preview_options: { is_disabled: true } }
  );
}

// Proses satu jawaban (dari teks ketikan atau tombol opt:) untuk step aktif.
async function advance(ctx, text) {
  const s = ctx.session;
  const i = stepIndex(s.platform, s.step);
  if (i === -1) { reset(s); return ctx.reply("Sesi rusak. /start untuk mulai."); }
  const err = FLOWS[s.platform][i][1].handle(text, s.data);
  if (err) return ctx.reply("❌ " + err);
  if (s.step === "pair" && s.data.pairNeedsCheck) {
    // alamat non-preset: cek approvedPairTokens + symbol on-chain sebelum lanjut
    try {
      const info = await PLATFORMS[s.platform].checkPair(s.data.pairToken);
      s.data.pairSymbol = info.symbol; s.data.pairNeedsCheck = false;
      await ctx.reply(`✅ Pair ${info.symbol} (${info.decimals} desimal) disetujui factory.`);
    } catch (e) { s.data.pairToken = ""; s.data.pairSymbol = "ETH"; s.data.pairNeedsCheck = false; return ctx.reply("❌ " + errMsg(e) + " Kirim alamat lain atau pilih ETH."); }
  }
  if (s.editing) return showConfirm(ctx);
  if (i + 1 < FLOWS[s.platform].length) { s.step = FLOWS[s.platform][i + 1][0]; return askStep(ctx); }
  return showConfirm(ctx);
}

// Sesi per chat; di DM ownerId == user, tapi tetap dicek supaya callback lama/forward tidak bisa memicu launch.
const notOwner = (ctx) => ctx.session.ownerId && ctx.session.ownerId !== ctx.from?.id;

const fmtResult = (platform, s, res) => {
  const extra = s.platform === "argus"
    ? `Hook: <code>${res.hook}</code>\nLocker: <code>${res.locker || "-"}</code>\nSplitter: <code>${res.splitter || "-"}</code>\nPool id: <code>${res.poolId || "-"}</code>\n`
    : `Curve: <code>${res.curve}</code>\n`;
  const links = [res.links.tx && `<a href="${res.links.tx}">Tx</a>`, `<a href="${res.links.token}">Token</a>`, res.links.explorerToken && `<a href="${res.links.explorerToken}">Explorer</a>`].filter(Boolean).join(" | ");
  return `${res.dryRun ? "🔎 SIMULASI OK" : "✅ LAUNCHED"} di <b>${esc(platform.label)}</b>\n\n` +
    `Token: <code>${res.token}</code>\n${extra}` +
    `Dev buy: ${esc(res.devBuy)} ${esc(res.devBuySymbol || platform.nativeSymbol)} → ${res.dryRun ? "≈" : "~"}${esc(Number(res.tokensOut).toLocaleString("en-US", { maximumFractionDigits: 2 }))} ${esc(s.data.symbol)}\n` +
    `Gas: ${esc(res.gas)} (≈ ${esc(res.gasCost)} ${platform.nativeSymbol}) | Total: ≈ ${esc(res.totalCost)} ${platform.nativeSymbol}\n` +
    `${links}\n${res.note ? "ℹ️ " + esc(res.note) : ""}`;
};

// Launch / simulasi. Dijalankan TANPA await dari handler supaya bot tetap merespons user lain
// (grammY bot.start() memproses update berurutan).
async function runLaunch(ctx, { dryRun }) {
  const s = ctx.session;
  const platform = PLATFORMS[s.platform];
  const status = await ctx.reply(dryRun ? "⏳ Simulasi..." : "⏳ Mulai...");
  const onStatus = async (text) => { try { await ctx.api.editMessageText(status.chat.id, status.message_id, redact(text)); } catch { /* rate limit / same text */ } };
  const wallet = walletFromKey(s.pk, platform.provider());
  const snap = { platform: s.platform, data: s.data }; // sesi bisa di-reset user selama proses
  let res, err, errText = "";
  try { res = await platform.launch(wallet, snap.data, onStatus, { dryRun }); }
  catch (e) { err = e; errText = errMsg(e); console.error(`${dryRun ? "simulate" : "launch"} error:`, redact(e?.stack || String(e))); }
  // Key dibersihkan dari memori SEGERA setelah launch selesai/gagal — sebelum kirim pesan apa pun.
  // (pesan error sudah diredaksi di atas, saat key masih terdaftar)
  if (dryRun) s.busy = false; else reset(s);

  const rec = (extra) => recordLaunch({ userId: ctx.from.id, platform: snap.platform, wallet: wallet.address, name: snap.data.name, symbol: snap.data.symbol, ...extra });
  try {
    if (!err) {
      await ctx.reply(fmtResult(platform, snap, res), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      if (!dryRun) await rec({ token: res.token, tx: res.txHash, devBuy: res.devBuy, tokensOut: res.tokensOut, status: "ok" });
    } else {
      if (err.pending) {
        await ctx.reply(`⏳ ${esc(errText)}\n<a href="${platform.explorer}/tx/${err.hash}">Lihat di explorer</a>\nDana mungkin sudah terpakai — cek dulu sebelum launch ulang.`, { parse_mode: "HTML" });
        await rec({ tx: err.hash, status: "pending" });
      } else {
        await ctx.reply("❌ Error: " + errText + (dryRun ? "\n\nPerbaiki lewat ✏️ Ubah, atau /cancel." : ""));
      }
    }
  } catch (e) { console.error("reply error:", redact(String(e))); }
  if (dryRun && s.step === "confirm") await showConfirm(ctx).catch(() => {});
}

// ---------------- commands ----------------
bot.command("start", async (ctx) => {
  const had = !!ctx.session.pk;
  reset(ctx.session);
  const kb = new InlineKeyboard();
  for (const p of Object.values(PLATFORMS)) kb.text(`${p.health.ok ? "" : "⚠️ "}${p.label}`, `pf:${p.id}`).row();
  await ctx.reply(`${had ? "Sesi sebelumnya dihapus.\n" : ""}🚀 Launch token. Pilih platform:`, { reply_markup: kb });
});
bot.command("cancel", async (ctx) => { reset(ctx.session); await ctx.reply("Dibatalkan. Key dihapus dari memori. /start untuk mulai lagi."); });

// /manage — aksi pasca-launch: status, jual, klaim fee creator. Pilih platform → key → alamat token → menu.
bot.command("manage", async (ctx) => {
  const had = !!ctx.session.pk;
  reset(ctx.session);
  const kb = new InlineKeyboard();
  for (const p of Object.values(PLATFORMS)) kb.text(`${p.health.ok ? "" : "⚠️ "}${p.label}`, `mpf:${p.id}`).row();
  await ctx.reply(`${had ? "Sesi sebelumnya dihapus.\n" : ""}🛠️ Kelola token (status / jual / klaim fee). Pilih platform:`, { reply_markup: kb });
});
bot.command("help", (ctx) => ctx.reply(
  "/start — mulai launch\n/manage — kelola token: status, jual, klaim fee creator\n/cancel — batalkan & hapus key dari memori\n/history — 10 launch terakhir kamu\n\n" +
  "pons v2 (Robinhood, chainId 4663): bonding curve, fee 0.0005 ETH, dev buy ETH, graduate ke Uniswap v4 di 4.2 ETH.\n" +
  "Argus (Arc, chainId 5042): langsung pool Uniswap v4, gas & dev buy pakai USDC, tax 1–10%/sisi, liquidity locked selamanya.\n\n" +
  `Sesi idle ${CFG.sessionTtlMs / 60_000} menit → key dihapus otomatis. Logo: URL atau kirim foto${ipfsEnabled() ? "" : " (upload foto belum aktif di server ini)"}.`
));
bot.command("history", async (ctx) => {
  const rows = await readHistory(ctx.from.id, 10);
  if (!rows.length) return ctx.reply("Belum ada riwayat launch.");
  const lines = rows.map((r) => {
    const p = PLATFORMS[r.platform];
    const tx = r.tx ? ` · <a href="${p?.explorer}/tx/${r.tx}">tx</a>` : "";
    return `${r.ts.slice(0, 16).replace("T", " ")} · ${esc(p?.label || r.platform)} · <b>${esc(r.symbol || "?")}</b> ${r.status === "pending" ? "⏳" : ""}\n<code>${r.token || "-"}</code>${tx}`;
  });
  await ctx.reply("📜 Riwayat launch:\n\n" + lines.join("\n\n"), { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
});

// ---------------- callbacks ----------------
bot.callbackQuery(/^pf:(pons|argus)$/, async (ctx) => {
  const s = ctx.session;
  const platform = PLATFORMS[ctx.match[1]];
  await ctx.answerCallbackQuery();
  if (!platform.health.ok) {
    // coba lagi (mungkin RPC sempat down saat startup)
    try { platform.health = { ok: true, msg: await platform.selfCheck() }; }
    catch (e) { return ctx.reply(`⚠️ ${platform.label} tidak tersedia: ${errMsg(e)}\nLaunch di platform ini dinonaktifkan sampai check lolos.`); }
  }
  reset(s);
  s.platform = platform.id; s.step = "pk"; s.ownerId = ctx.from.id;
  await ctx.reply(
    `Platform: ${platform.label}\n\n` +
    "⚠️ Kirim PRIVATE KEY wallet launcher (pesan akan langsung dihapus).\n" +
    "Pakai wallet khusus dengan dana secukupnya! /cancel untuk batal."
  );
});

bot.callbackQuery(/^mpf:(pons|argus)$/, async (ctx) => {
  const s = ctx.session;
  const platform = PLATFORMS[ctx.match[1]];
  await ctx.answerCallbackQuery();
  if (!platform.health.ok) {
    try { platform.health = { ok: true, msg: await platform.selfCheck() }; }
    catch (e) { return ctx.reply(`⚠️ ${platform.label} tidak tersedia: ${errMsg(e)}`); }
  }
  reset(s);
  s.mode = "manage"; s.platform = platform.id; s.step = "pk"; s.ownerId = ctx.from.id;
  await ctx.reply(`Platform: ${platform.label}\n\n⚠️ Kirim PRIVATE KEY wallet pemilik token (pesan akan langsung dihapus). /cancel untuk batal.`);
});

// Menu kelola: status + tombol aksi.
async function showManage(ctx) {
  const s = ctx.session;
  const platform = PLATFORMS[s.platform];
  s.step = "mmenu";
  let text;
  try {
    const wallet = walletFromKey(s.pk, platform.provider());
    text = (await platform.status(wallet, s.token)).text;
  } catch (e) { text = "(gagal baca status: " + errMsg(e) + ")"; }
  const kb = new InlineKeyboard()
    .text("💸 Jual 25%", "m:sell:25").text("💸 Jual 50%", "m:sell:50").text("💸 Jual 100%", "m:sell:100").row()
    .text("🎁 Klaim fee", "m:claim").text("🔄 Refresh", "m:status").row()
    .text("🔁 Token lain", "m:token").text("✖️ Selesai", "m:done");
  await ctx.reply(`🛠️ <b>${esc(platform.label)}</b>\nToken: <code>${s.token}</code>\n\n${esc(text)}`, { parse_mode: "HTML", reply_markup: kb, link_preview_options: { is_disabled: true } });
}

// Aksi kelola (jual/klaim) dijalankan tanpa await, status di-edit live; key TETAP di sesi (user bisa lanjut aksi lain).
async function runManage(ctx, action, arg) {
  const s = ctx.session;
  const platform = PLATFORMS[s.platform];
  const status = await ctx.reply("⏳ Mulai...");
  const onStatus = async (text) => { try { await ctx.api.editMessageText(status.chat.id, status.message_id, redact(text)); } catch { /* rate limit / same text */ } };
  const wallet = walletFromKey(s.pk, platform.provider());
  const snap = { platform: s.platform, token: s.token };
  try {
    const res = action === "sell" ? await platform.sell(wallet, snap.token, Number(arg), onStatus) : await platform.claim(wallet, snap.token, onStatus);
    await ctx.reply(`${esc(res.text)}\n<a href="${res.links.tx}">Tx</a>`, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    await recordLaunch({ userId: ctx.from.id, platform: snap.platform, wallet: wallet.address, token: snap.token, tx: res.txHash, status: action, amount: res.amountIn || res.amount });
  } catch (e) {
    const errText = errMsg(e);
    console.error(`manage ${action} error:`, redact(e?.stack || String(e)));
    if (e.pending) await ctx.reply(`⏳ ${esc(errText)}\n<a href="${platform.explorer}/tx/${e.hash}">Lihat di explorer</a>`, { parse_mode: "HTML" }).catch(() => {});
    else await ctx.reply("❌ Error: " + errText).catch(() => {});
  }
  s.busy = false;
  if (s.step === "mmenu" && s.pk) await showManage(ctx).catch(() => {});
}

bot.callbackQuery(/^m:(status|token|done|claim|sell)(?::(\d+))?$/, async (ctx) => {
  const s = ctx.session;
  const [, action, arg] = ctx.match;
  if (notOwner(ctx)) return ctx.answerCallbackQuery();
  if (s.mode !== "manage" || s.step !== "mmenu" || !s.pk) { await ctx.answerCallbackQuery(); return ctx.reply("Sesi tidak valid. /manage untuk mulai."); }
  if (action === "done") { await ctx.answerCallbackQuery(); reset(s); return ctx.reply("Selesai. Key dihapus dari memori."); }
  if (action === "token") { await ctx.answerCallbackQuery(); s.step = "mtoken"; return ctx.reply("Kirim alamat token (0x…) yang mau dikelola."); }
  if (action === "status") { await ctx.answerCallbackQuery(); return showManage(ctx); }
  if (s.busy) return ctx.answerCallbackQuery({ text: "Masih diproses..." });
  s.busy = true;
  await ctx.answerCallbackQuery();
  void runManage(ctx, action, arg);
});

bot.callbackQuery(/^mt:(0x[0-9a-fA-F]{40})$/, async (ctx) => {
  const s = ctx.session;
  await ctx.answerCallbackQuery();
  if (notOwner(ctx) || s.mode !== "manage" || s.step !== "mtoken") return;
  s.token = ethers.getAddress(ctx.match[1]);
  return showManage(ctx);
});

bot.callbackQuery(/^opt:(.+)$/, async (ctx) => {
  const s = ctx.session;
  await ctx.answerCallbackQuery();
  if (notOwner(ctx)) return;
  if (!s.step || s.step === "pk" || s.step === "confirm") return ctx.reply("Tombol ini sudah tidak berlaku.");
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  return advance(ctx, ctx.match[1]);
});

bot.callbackQuery("launch:edit", async (ctx) => {
  const s = ctx.session;
  await ctx.answerCallbackQuery();
  if (notOwner(ctx) || s.step !== "confirm") return;
  const kb = new InlineKeyboard();
  FLOWS[s.platform].forEach(([key, def], i) => { kb.text(def.label, `edit:${key}`); if (i % 3 === 2) kb.row(); });
  kb.row().text("↩️ Kembali", "edit:back");
  await ctx.reply("Mau ubah yang mana?", { reply_markup: kb });
});

bot.callbackQuery(/^edit:(\w+)$/, async (ctx) => {
  const s = ctx.session;
  await ctx.answerCallbackQuery();
  if (notOwner(ctx) || s.step !== "confirm") return;
  if (ctx.match[1] === "back") return showConfirm(ctx);
  if (stepIndex(s.platform, ctx.match[1]) === -1) return;
  s.step = ctx.match[1]; s.editing = true;
  return askStep(ctx);
});

for (const [action, dryRun] of [["launch:go", false], ["launch:sim", true]]) {
  bot.callbackQuery(action, async (ctx) => {
    const s = ctx.session;
    if (notOwner(ctx)) return ctx.answerCallbackQuery();
    if (s.step !== "confirm" || !s.pk) { await ctx.answerCallbackQuery(); return ctx.reply("Sesi tidak valid. /start untuk mulai."); }
    if (s.busy) return ctx.answerCallbackQuery({ text: "Masih diproses..." });
    s.busy = true; // set sebelum await apa pun → tekan 2x tidak bisa double launch
    await ctx.answerCallbackQuery();
    void runLaunch(ctx, { dryRun });
  });
}

bot.callbackQuery("launch:cancel", async (ctx) => { await ctx.answerCallbackQuery(); if (notOwner(ctx)) return; reset(ctx.session); await ctx.reply("Dibatalkan. Key dihapus dari memori. /start untuk mulai lagi."); });

// ---------------- text flow ----------------
bot.on("message:text", async (ctx) => {
  const s = ctx.session;
  const text = ctx.message.text.trim();
  if (text.startsWith("/")) return ctx.reply("Perintah tidak dikenal. /help");
  if (!s.step) return ctx.reply("Ketik /start untuk mulai.");
  if (notOwner(ctx)) return;

  try {
    if (s.step === "pk") {
      try { await ctx.deleteMessage(); } catch { /* seharusnya selalu bisa di DM */ }
      let wallet;
      try { wallet = walletFromKey(text, PLATFORMS[s.platform].provider()); }
      catch (e) { return ctx.reply("❌ " + e.message + " Kirim ulang atau /cancel."); }
      s.pk = text;
      let info = "";
      try { info = "\nSaldo: " + (await PLATFORMS[s.platform].walletInfo(wallet)); } catch { info = "\n(gagal baca saldo, lanjut)"; }
      await ctx.reply(`✅ Key diterima & pesan dihapus.\nWallet: <code>${wallet.address}</code>${esc(info)}`, { parse_mode: "HTML" });
      if (s.mode === "manage") {
        s.step = "mtoken";
        const mine = (await readHistory(ctx.from.id, 50)).filter((r) => r.platform === s.platform && r.token && r.wallet?.toLowerCase() === wallet.address.toLowerCase() && r.status === "ok");
        const seen = new Set(); const kb = new InlineKeyboard();
        for (const r of mine) { if (seen.has(r.token) || seen.size >= 8) continue; seen.add(r.token); kb.text(r.symbol || r.token.slice(0, 10), `mt:${r.token}`).row(); }
        return ctx.reply("Kirim alamat token (0x…) yang mau dikelola" + (seen.size ? ", atau pilih dari riwayat launch wallet ini:" : "."), seen.size ? { reply_markup: kb } : undefined);
      }
      s.step = FLOWS[s.platform][0][0];
      return askStep(ctx);
    }
    if (s.step === "mtoken") {
      if (!ethers.isAddress(text)) return ctx.reply("❌ Alamat token tidak valid.");
      s.token = ethers.getAddress(text);
      return await showManage(ctx);
    }
    if (s.step === "mmenu") return ctx.reply("Pakai tombol di menu kelola, atau /cancel.");
    if (s.step === "confirm") return ctx.reply("Tekan tombol LAUNCH / Simulasi / Ubah / Batal di atas.");
    return await advance(ctx, text);
  } catch (e) {
    console.error("flow error:", redact(e?.stack || String(e)));
    return ctx.reply("❌ Error: " + errMsg(e));
  }
});

// Foto → logo (upload ke IPFS) kalau sedang di step logo.
bot.on("message:photo", async (ctx) => {
  const s = ctx.session;
  if (notOwner(ctx)) return;
  if (s.step !== "logo") return ctx.reply(s.step ? "Kirim foto hanya saat ditanya logo." : "Ketik /start untuk mulai.");
  if (!ipfsEnabled()) return ctx.reply("Upload foto belum aktif (PINATA_JWT kosong). Kirim URL logo (https:// atau ipfs://), atau - untuk skip.");
  try {
    await ctx.reply("⬆️ Upload logo ke IPFS...");
    const { uri, gateway } = await uploadTelegramPhoto(ctx);
    await ctx.reply(`✅ Logo: <code>${uri}</code>\n${gateway}`, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    return await advance(ctx, uri);
  } catch (e) {
    console.error("ipfs error:", redact(e?.stack || String(e)));
    return ctx.reply("❌ " + errMsg(e) + "\nKirim URL logo saja, atau - untuk skip.");
  }
});

bot.catch((err) => console.error("bot error:", redact(String(err.error?.stack || err.error || err))));

return { bot, storage };
}
