// Upload logo dari foto Telegram ke IPFS via Pinata (opsional; butuh PINATA_JWT di .env).
// Alur: ctx.getFile() → download dari api.telegram.org/file/bot<TOKEN>/<path> → POST pinFileToIPFS → ipfs://CID
import { CFG } from "./config.js";

export const ipfsEnabled = () => !!CFG.pinataJwt;

const MAX_BYTES = 2 * 1024 * 1024; // logo > 2 MB ditolak (launchpad umumnya menampilkan thumbnail kecil)

export async function uploadTelegramPhoto(ctx) {
  if (!ipfsEnabled()) throw new Error("Upload foto belum aktif: isi PINATA_JWT di .env, atau kirim URL logo.");
  const file = await ctx.getFile(); // ukuran terbesar untuk message:photo
  if (file.file_size && file.file_size > MAX_BYTES) throw new Error("Foto terlalu besar (maks 2 MB).");
  // URL download memuat BOT_TOKEN → jangan pernah di-log.
  const res = await fetch(`https://api.telegram.org/file/bot${CFG.botToken}/${file.file_path}`);
  if (!res.ok) throw new Error("Gagal download foto dari Telegram.");
  const blob = await res.blob();
  const ext = (file.file_path.split(".").pop() || "jpg").toLowerCase();

  const form = new FormData();
  form.append("file", blob, `logo.${ext}`);
  form.append("pinataMetadata", JSON.stringify({ name: `launch-bot-logo-${Date.now()}` }));
  const up = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", {
    method: "POST", headers: { Authorization: `Bearer ${CFG.pinataJwt}` }, body: form,
  });
  if (!up.ok) throw new Error(`Pinata error ${up.status}: ${(await up.text()).slice(0, 120)}`);
  const j = await up.json();
  if (!j.IpfsHash) throw new Error("Pinata tidak mengembalikan CID.");
  return { uri: `ipfs://${j.IpfsHash}`, gateway: `https://gateway.pinata.cloud/ipfs/${j.IpfsHash}` };
}
