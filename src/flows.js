// Definisi langkah percakapan per platform. Murni data + validasi (tanpa Telegram/RPC) → bisa di-unit-test.
//
// Tiap step: { label, ask, handle(text, data) -> error string | undefined, options?: [[label, value], ...] }
// options → ditampilkan sebagai tombol inline; value-nya di-handle lewat jalur yang sama dengan teks ketikan.
import { ethers } from "ethers";
import { CFG } from "./config.js";

const skip = (t) => (t === "-" ? "" : t);
const isUrl = (t) => /^(https?:\/\/|ipfs:\/\/)\S+$/i.test(t);
const SKIP = [["⏭️ Skip", "-"]];
const YN = [["✅ Ya", "y"], ["❌ Tidak", "n"]];

const social = (key, label, ask) => ({
  label, ask: `${ask} (url/handle, - untuk skip)`, options: SKIP,
  handle: (t, d) => { d.socials ??= {}; d.socials[key] = skip(t).slice(0, 120); },
});

const COMMON = {
  name: { label: "Nama", ask: "📝 Nama token?", handle: (t, d) => { if (t.length < 2 || t.length > 32) return "Nama 2–32 karakter."; d.name = t; } },
  symbol: { label: "Symbol", ask: "🔤 Symbol/ticker? (mis. MEME)", handle: (t, d) => { const s = t.toUpperCase(); if (!/^[A-Z0-9]{2,10}$/.test(s)) return "Ticker 2–10 huruf/angka."; d.symbol = s; } },
  description: { label: "Deskripsi", ask: "🧾 Deskripsi token? (- untuk skip)", options: SKIP, handle: (t, d) => { d.description = skip(t).slice(0, 280); } },
  logo: {
    label: "Logo", ask: "🖼️ Logo: kirim URL (ipfs:// atau https://), atau kirim FOTO langsung (di-upload ke IPFS). - untuk skip.", options: SKIP,
    handle: (t, d) => { if (t !== "-" && !isUrl(t)) return "URL tidak valid (harus https:// atau ipfs://)."; d.logo = skip(t); },
  },
  website: social("website", "Website", "🌐 Website?"),
  twitter: social("twitter", "Twitter/X", "🐦 Twitter/X?"),
  telegram: social("telegram", "Telegram", "✈️ Telegram?"),
  discord: social("discord", "Discord", "🎮 Discord?"),
  farcaster: social("farcaster", "Farcaster", "🟪 Farcaster?"),
};

// Angka desimal positif (dev buy). Terima koma sebagai desimal.
const parseAmount = (t) => { const n = Number(t.replace(",", ".")); return Number.isFinite(n) && n >= 0 && /^[\d.,]+$/.test(t) ? n : NaN; };
const bpsInRange = (t, lo, hi) => { const n = parseInt(t, 10); return String(n) === t.trim() && n >= lo && n <= hi ? n : NaN; };

export const FLOWS = {
  pons: [
    ["name", COMMON.name], ["symbol", COMMON.symbol], ["description", COMMON.description], ["logo", COMMON.logo],
    ["website", COMMON.website], ["twitter", COMMON.twitter], ["telegram", COMMON.telegram],
    ["discord", COMMON.discord], ["farcaster", COMMON.farcaster],
    ["creatorTax", {
      label: "Creator tax",
      ask: "💸 Creator tax dalam bps (0–1000; 100 bps = 1%). Pilih preset atau ketik angka.",
      options: [["0%", "0"], ["1%", "100"], ["3%", "300"], ["5%", "500"], ["10%", "1000"]],
      handle: (t, d) => { const n = bpsInRange(t, 0, 1000); if (isNaN(n)) return "Masukkan angka 0–1000 (bps)."; d.creatorTaxBps = n; },
    }],
    ["feeRecipient", {
      label: "Penerima fee",
      ask: "👛 Wallet penerima fee creator trading? Kirim alamat 0x… atau klik '-' untuk pakai wallet launcher saat ini.",
      options: [["⏭️ Pakai launcher", "-"]],
      handle: (t, d) => {
        if (t === "-" || !t) { d.creatorFeeRecipient = ""; return; }
        if (!ethers.isAddress(t)) return "Alamat wallet penerima tidak valid (harus 0x…).";
        d.creatorFeeRecipient = ethers.getAddress(t);
      },
    }],
    ["buyback", { label: "Buyback", ask: "🔁 Aktifkan buyback?", options: YN, handle: (t, d) => { if (!/^[yn]/i.test(t)) return "Jawab y atau n."; d.buybackEnabled = /^y/i.test(t); } }],
    ["exemptions", {
      label: "Bebas snipe tax",
      ask: "🎯 Wallet lain yang bebas snipe tax (mis. wallet sniper kamu)? Alamat 0x…, pisah koma. Wallet launcher sudah otomatis bebas. - untuk skip.",
      options: SKIP,
      handle: (t, d) => {
        if (t === "-") { d.exemptions = []; return; }
        const list = t.split(",").map((x) => x.trim()).filter(Boolean);
        if (!list.length || list.length > 10) return "Maks 10 alamat.";
        if (list.some((a) => !ethers.isAddress(a))) return "Ada alamat tidak valid.";
        d.exemptions = list.map((a) => ethers.getAddress(a));
      },
    }],
    ["pair", {
      label: "Pair token",
      ask: "🔗 Pair token curve: ETH (default) atau ERC-20 yang disetujui factory (USDG, cbBTC, saham tokenized…). Pilih preset atau ketik alamat 0x… (dicek on-chain).",
      options: [["ETH", "eth"], ...CFG.pons.pairPresets],
      // Alamat non-preset divalidasi on-chain di bot (checkPair) sebelum lanjut; di sini hanya format.
      handle: (t, d) => {
        if (/^eth$/i.test(t) || t === "-") { d.pairToken = ""; d.pairSymbol = "ETH"; d.pairNeedsCheck = false; return; }
        if (!ethers.isAddress(t)) return "Ketik 'eth' atau alamat 0x… yang valid.";
        const preset = CFG.pons.pairPresets.find(([, a]) => a.toLowerCase() === t.toLowerCase());
        d.pairToken = ethers.getAddress(t); d.pairSymbol = preset ? preset[0] : "?"; d.pairNeedsCheck = !preset;
      },
    }],
    ["devbuy", {
      label: "Dev buy", ask: "🛒 Dev buy awal (dalam pair token: ETH/USDG/…). 0 = tanpa beli. Fee launch 0.0005 ETH ditambahkan otomatis.",
      options: [["0", "0"], ["0.01", "0.01"], ["0.05", "0.05"], ["0.1", "0.1"]],
      handle: (t, d) => { const n = parseAmount(t); if (isNaN(n)) return "Masukkan angka valid."; d.devBuy = n; },
    }],
  ],
  argus: [
    ["name", COMMON.name], ["symbol", COMMON.symbol], ["description", COMMON.description], ["logo", COMMON.logo],
    ["website", COMMON.website], ["twitter", COMMON.twitter], ["telegram", COMMON.telegram],
    ["buyTax", {
      label: "Buy tax", ask: "💸 Buy tax dalam bps (100–1000 = 1–10%). Pilih preset atau ketik angka.",
      options: [["1%", "100"], ["2%", "200"], ["3%", "300"], ["5%", "500"], ["10%", "1000"]],
      handle: (t, d) => { const n = bpsInRange(t, 100, 1000); if (isNaN(n)) return "Masukkan angka 100–1000 (bps)."; d.buyTaxBps = n; },
    }],
    ["sellTax", {
      label: "Sell tax", ask: "💸 Sell tax dalam bps (100–1000 = 1–10%).",
      options: [["1%", "100"], ["2%", "200"], ["3%", "300"], ["5%", "500"], ["10%", "1000"]],
      handle: (t, d) => { const n = bpsInRange(t, 100, 1000); if (isNaN(n)) return "Masukkan angka 100–1000 (bps)."; d.sellTaxBps = n; },
    }],
    ["alloc", {
      label: "Alokasi tax",
      ask: "📊 Alokasi tax (bps, total 10000) format: creator/buyback/dividends/liquidity\nContoh: 10000/0/0/0 atau 7000/1000/1000/1000",
      options: [["100% creator", "10000/0/0/0"], ["70/10/10/10", "7000/1000/1000/1000"], ["50/25/0/25", "5000/2500/0/2500"], ["50/0/50/0", "5000/0/5000/0"]],
      handle: (t, d) => {
        const p = t.split("/").map((x) => parseInt(x.trim(), 10));
        if (p.length !== 4 || p.some((n) => isNaN(n) || n < 0)) return "Format: a/b/c/d (4 angka).";
        if (p.reduce((a, b) => a + b, 0) !== 10000) return "Total harus 10000.";
        d.alloc = { creatorFunds: p[0], buybackBurn: p[1], dividends: p[2], liquidity: p[3] };
      },
    }],
    ["quote", {
      label: "Quote",
      ask: "💱 Quote asset pool: USDC (default) atau ARGUS. Dengan ARGUS, startMcap/bondMcap dihitung dari harga ARGUS saat launch (≈ 2.500 / 45.000 USDC).",
      options: [["USDC", "USDC"], ["ARGUS", "ARGUS"]],
      handle: (t, d) => { const q = t.toUpperCase(); if (!["USDC", "ARGUS"].includes(q)) return "Pilih USDC atau ARGUS."; d.quote = q; },
    }],
    ["devbuy", {
      label: "Dev buy", ask: "🛒 Dev buy awal (dalam quote asset: USDC/ARGUS). 0 = tanpa beli. Tidak ada fee launch, hanya gas (~0.06 USDC).",
      options: [["0", "0"], ["10", "10"], ["50", "50"], ["100", "100"]],
      handle: (t, d) => { const n = parseAmount(t); if (isNaN(n)) return "Masukkan angka valid."; d.devBuy = n; },
    }],
  ],
};

export const stepIndex = (platform, key) => FLOWS[platform].findIndex(([k]) => k === key);
export const stepDef = (platform, key) => FLOWS[platform][stepIndex(platform, key)]?.[1];

// Ringkasan untuk layar konfirmasi (plain text; di-escape oleh pemanggil kalau pakai HTML).
export function summary(platform, label, d) {
  const s = d.socials || {};
  const base = `Platform: ${label}\nNama: ${d.name}\nSymbol: ${d.symbol}\nDeskripsi: ${d.description || "-"}\nLogo: ${d.logo || "-"}\n` +
    `Website: ${s.website || "-"} | X: ${s.twitter || "-"} | TG: ${s.telegram || "-"}\n`;
  if (platform === "pons") {
    return base + `Discord: ${s.discord || "-"} | Farcaster: ${s.farcaster || "-"}\n` +
      `Creator tax: ${d.creatorTaxBps} bps (${d.creatorTaxBps / 100}%) | Penerima fee: ${d.creatorFeeRecipient || "wallet launcher"}\n` +
      `Buyback: ${d.buybackEnabled ? "on" : "off"} | Bebas snipe tax: ${d.exemptions?.length ? d.exemptions.join(", ") : "hanya launcher"}\n` +
      `Pair: ${d.pairSymbol || "ETH"}${d.pairToken ? ` (${d.pairToken})` : ""}\nDev buy: ${d.devBuy} ${d.pairSymbol || "ETH"} (+ fee 0.0005 ETH)`;
  }
  const a = d.alloc;
  return base + `Buy tax: ${d.buyTaxBps} bps (${d.buyTaxBps / 100}%) | Sell tax: ${d.sellTaxBps} bps (${d.sellTaxBps / 100}%)\n` +
    `Alokasi: creator ${a.creatorFunds} / buyback ${a.buybackBurn} / dividends ${a.dividends} / liquidity ${a.liquidity}\nQuote: ${d.quote || "USDC"} | Dev buy: ${d.devBuy} ${d.quote || "USDC"}`;
}
