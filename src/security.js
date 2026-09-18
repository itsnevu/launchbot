import { ethers } from "ethers";

// Private key yang sedang aktif di memori (semua sesi). Diisi walletFromKey(), dihapus forgetSecret().
// redact() menyensor persis string-string ini (dengan/tanpa 0x, case-insensitive) — bukan "semua 64-hex",
// karena tx hash & salt juga 64-hex dan harus tetap terbaca user.
const SECRETS = new Set();
// Key yang baru dilupakan tetap disensor selama GRACE_MS: error/log yang muncul setelah sesi di-reset
// (mis. dari bot.catch) tidak boleh bocorkan key. Setelah itu hilang dari memori.
const RECENT = new Map(); // hex → expiry ms
const GRACE_MS = 60_000;

export function normalizeKey(pk) {
  let key = String(pk).trim();
  if (!key.startsWith("0x")) key = "0x" + key;
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("Private key tidak valid (harus 64 hex).");
  return key.toLowerCase();
}

// Validasi + normalisasi private key, daftarkan ke SECRETS. Lempar error kalau tidak valid.
export function walletFromKey(pk, provider) {
  const key = normalizeKey(pk);
  SECRETS.add(key.slice(2));
  return new ethers.Wallet(key, provider);
}

export function forgetSecret(pk) {
  let hex;
  try { hex = normalizeKey(pk).slice(2); } catch { return; /* bukan key valid, tidak pernah terdaftar */ }
  SECRETS.delete(hex);
  RECENT.set(hex, Date.now() + GRACE_MS);
}

const liveSecrets = () => {
  const now = Date.now();
  for (const [k, exp] of RECENT) if (exp <= now) RECENT.delete(k);
  return [...SECRETS, ...RECENT.keys()];
};

// Jangan pernah log private key. Sensor semua key terdaftar; plus fallback: hex ≥ 128 char
// (raw signed tx / calldata panjang) supaya log tetap ringkas & tidak bocorkan payload.
export function redact(s) {
  if (typeof s !== "string") return s;
  let out = s;
  for (const k of liveSecrets()) out = out.replace(new RegExp("(0x)?" + k, "gi"), "0x***REDACTED***");
  return out.replace(/(0x)?[0-9a-fA-F]{128,}/g, "0x***HEX***");
}

// Pesan error ethers/RPC yang ramah user.
export function errMsg(e) {
  const m = e?.shortMessage || e?.reason || e?.info?.error?.message || e?.message || String(e);
  return redact(m).slice(0, 400);
}

// Escape untuk parse_mode HTML Telegram.
export function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
