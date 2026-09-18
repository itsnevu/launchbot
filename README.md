# launch-bot — Telegram bot launch token: pons v2 (Robinhood Chain) + Argus (Arc)

Satu bot, dua platform. User kirim private key → isi detail token → bot launch + dev buy dalam satu tx.

| | pons v2 | Argus |
|---|---|---|
| Chain | Robinhood Chain, chainId **4663** | Arc (Circle L1), chainId **5042** |
| Gas / dev buy | ETH | USDC (native == ERC-20 `0x3600…0000`) |
| Kontrak | Factory `0x7eD5…EC7e`, Router `0xe33E…2948` | Portal #7 `0xB021…97Da` |
| Fee launch | 0.0005 ETH | 0 (gas ≈ 0.06 USDC) |
| Mekanisme | Bonding curve → auto-graduate ke Uniswap v4 @ 4.2 ETH | Langsung pool Uniswap v4 (full supply di 1 posisi), liquidity locked selamanya |
| Tax | Creator tax 0–10% | Buy & sell tax masing-masing 1–10%, permanen; alokasi creator/buyback/dividends/liquidity |
| Dev buy | `router.launchAndBuy` (exempt snipe tax) | `devBuyAmount` di `createLaunch` (Portal exempt snipe tax) |

Semua nilai di atas diverifikasi on-chain 2026-09-17 (`npm run check` mengulang verifikasinya tanpa dana).

## Setup

```bash
npm install
cp .env.example .env   # isi BOT_TOKEN (BotFather), ALLOWED_USER_IDS
npm run check          # dry-run kedua chain: RPC, gate, encoding, mining hook salt, simulasi launch
npm test               # unit test offline: encoding vs calldata nyata, validasi step, alur Telegram (API di-stub)
npm start
```

VPS persisten:

```bash
npm i -g pm2 && pm2 start src/index.js --name launch-bot && pm2 save && pm2 startup
```

## Alur di Telegram

`/start` → pilih platform (tombol) → kirim private key (pesan langsung dihapus) → nama, symbol, deskripsi, logo (URL atau **kirim foto**), website/X/TG (pons: + Discord/Farcaster) → tax (tombol preset atau ketik bps) → (pons) wallet bebas snipe tax → dev buy → layar **konfirmasi** dengan saldo vs kebutuhan + estimasi tokensOut.

Di konfirmasi: **🚀 LAUNCH** · **🔎 Simulasi** (mining + simulasi + estimasi gas, tanpa kirim tx) · **✏️ Ubah** (perbaiki satu field tanpa kirim key ulang) · **✖️ Batal**.

`/history` — 10 launch terakhir kamu (disimpan di `launches.jsonl`, tanpa key). `/cancel` kapan saja menghapus key dari memori.

Status progres (mining, approve, simulasi, tx hash) di-edit live di satu pesan. Hasil dikirim dalam HTML: alamat bisa di-tap untuk copy. Kalau tx belum terkonfirmasi dalam 3 menit, bot menampilkan hash + link explorer (bukan "error") — dana mungkin sudah terpakai, cek dulu sebelum launch ulang.

Bot hanya melayani **chat pribadi**; di grup semua perintah ditolak (key tidak boleh dikirim di grup).

## Yang dilakukan bot di balik layar

**pons v2** ([src/chains/pons.js](src/chains/pons.js))
1. Cek `launchEnabled()` + `canLaunch(wallet)`.
2. Baca `launchFee()` + `previewLaunchEconomics(0, 0x0)` tepat sebelum kirim (pin terms).
3. `launchAndBuy.staticCall` → dapat `token`, `curve`, `tokensOut` → `minTokensOut = tokensOut − SLIPPAGE_BPS`.
4. Estimasi gas (+25%), cek saldo, kirim, tunggu receipt. Tanpa dev buy → `factory.launchToken`.

**Argus** ([src/chains/argus.js](src/chains/argus.js)) — ABI Portal tidak dipublikasikan (bundle `arguspad.io` di balik browser-check), jadi layout direkonstruksi dari calldata 40+ tx launch nyata dan diverifikasi via dry-run:
1. `createLaunch` = selector `0x11b8f0f1` + `(struct1, struct2, bytes32 tokenSalt, bytes32 hookSalt)`.
   - struct1: `name, symbol, supply 1e27, startMcap 2500 USDC, bondMcap 45000 USDC, buyTax, sellTax, creatorFunds, buybackBurn, dividends, liquidity, devBuyAmount (6 des), quoteAsset, flag=1`
   - struct2: `imageURI, website, twitter, telegram, description`
2. Hook Uniswap v4 wajib punya flag `0x2044` di alamatnya → **hookSalt di-mining** lewat view Portal `0x3ae04f1d(creator, tokenSalt, hookSalt, buyTax, sellTax, quote) → (hook, flags, valid)`. Mining dipercepat dengan `eth_call` + state override ([contracts/HookSaltMiner.sol](contracts/HookSaltMiner.sol), ~900 percobaan/call, paralel di semua RPC) → biasanya < 2 detik. Fallback: batch JSON-RPC.
3. Dividends > 0 → creator harus terdaftar di registry `0x87fe…1dd3` (`configFor(creator).mode != 0`); bot mengirim `0x47f8b269(1, 0)` dulu kalau belum (persis seperti frontend).
4. Dev buy > 0 → `approve(USDC → Portal)` kalau allowance kurang.
5. Dry-run `eth_call` (dapat alamat token), `eth_estimateGas` (+20%), kirim, parse event `TokenCreated` / `PartsDeployed` / dev-buy dari receipt.
6. Estimasi tokensOut dev buy (ditampilkan di konfirmasi): dev buy = trade pertama di pool yang mulai di startMcap 2500 USDC dengan seluruh supply → constant product − fee pool 0.25% − buy tax. Dicocokkan dengan 3 tx nyata, selisih < 0.1%.

Saat startup, bot menjalankan `selfCheck()` tiap platform (RPC, chainId, kontrak punya kode, Portal masih punya selector `0x11b8f0f1`/`0x3ae04f1d`). Gagal → platform itu ditandai ⚠️ dan launch ditolak sampai check lolos (dicoba ulang saat dipilih).

## Catatan jaringan

- `rpc.mainnet.chain.robinhood.com` **dibelokkan DNS oleh ISP Indonesia** (TrustPositif). Isi `DNS_PINS=rpc.mainnet.chain.robinhood.com=<IP>` di `.env`; IP asli bisa dicek di `https://cloudflare-dns.com/dns-query?name=rpc.mainnet.chain.robinhood.com&type=A`. Di VPS luar negeri biasanya tidak perlu.
- Endpoint publik Arc rate-limit agresif; default `.env` pakai 3 endpoint dengan fallback.

## Keamanan private key

- Pesan berisi key langsung dihapus; key hanya di memori sesi dan dihapus **segera** setelah `launch()` selesai/gagal (sebelum pesan hasil dikirim), saat `/cancel`, atau otomatis setelah idle `SESSION_TTL_MIN` menit (default 10; sweeper tiap 60 dtk, user diberi tahu).
- Semua log & pesan error diredaksi: key yang terdaftar disensor persis (dengan/tanpa `0x`, case-insensitive) + 60 dtk setelah dilupakan; hex ≥ 128 char (raw tx/calldata) diringkas. Tx hash **tidak** disensor (versi lama menyensor semua 64-hex, termasuk tx hash di pesan status).
- Tombol LAUNCH/Ubah/Simulasi hanya bereaksi untuk user yang memulai sesi (`ownerId`). Tekan LAUNCH 2× → hanya 1 launch.
- Hanya chat pribadi. `ALLOWED_USER_IDS` untuk membatasi pengguna — **isi ini** kalau bot bisa ditemukan orang lain. **Jangan** taruh `.env` di repo publik.
- Pakai wallet khusus berisi dana per-launch saja. Uji dengan **🔎 Simulasi** dan dev buy kecil dulu.

## Struktur

| File | Isi |
|---|---|
| [src/index.js](src/index.js) | startup: validasi token, self-check platform, jalankan bot, graceful shutdown |
| [src/bot.js](src/bot.js) | semua handler Telegram (`createBot(platforms)` — bisa di-test offline) |
| [src/flows.js](src/flows.js) | definisi step per platform (ask/validasi/preset) + ringkasan |
| [src/chains/pons.js](src/chains/pons.js), [src/chains/argus.js](src/chains/argus.js) | adapter chain: `selfCheck`, `walletInfo`, `precheck`, `launch(…, {dryRun})` |
| [src/security.js](src/security.js) | key → wallet, redaksi, escape HTML |
| [src/rpc.js](src/rpc.js) | DNS pin, raw RPC fallback, retry, `waitTx` (timeout ≠ revert) |
| [src/history.js](src/history.js), [src/ipfs.js](src/ipfs.js) | riwayat JSONL; upload foto → Pinata |
| [test/](test/) | `npm test` — tanpa network |
| [scripts/build-miner.js](scripts/build-miner.js) | compile ulang `HookSaltMiner.sol` → json (`npm i -D solc`; `--check` membandingkan bytecode) |

## Yang belum

- Argus: launch dengan quote selain USDC (ARGUS) — encoding sama, hanya `quoteAsset` + approve yang beda; belum diuji.
- pons: pair ERC-20 selain ETH (`approvedPairTokens`) belum diimplementasi.
- pons: `tokensOut` di hasil masih dari `staticCall` (ABI event curve tidak diketahui); Argus sudah dari event.
- Aksi pasca-launch (jual, klaim fee creator, status graduasi) belum ada.
