# Pons Launcher Bot (Atomic Bundling)

Bot Telegram berbasis Node.js untuk melaunch token di Pons (Robinhood Chain) dengan teknik **Atomic Transaction Bundling**.

## Fitur
- Melakukan Funding Wallet dan Launch Token dalam satu blok yang sama menggunakan teknik Gas Pricing priority.
- Retry otomatis dengan batas yang ditentukan.
- UI Telegram Bot interaktif berbasis Inline Keyboard.

## Mengapa Atomic Bundling?
Teknik ini memastikan wallet LAUNCH selalu mempunyai saldo tepat sebelum melakukan eksekusi launch. Kita menggabungkan 2 transaksi di saat bersamaan ke RPC:
1. `tx1` (Funding): Mentransfer saldo dengan Gas Price standar.
2. `tx2` (Launch): Memanggil kontrak factory dengan nonce terkini dan gas price sedikit lebih tinggi/disesuaikan, dikirim tepat setelah `tx1`.
Ini meminimalisir kemungkinan ada transaksi lain yang menyalip, dan menghindari kegagalan eksekusi (Revert karena dana kurang) di tengah proses.

## Persyaratan
- Node.js versi 18 ke atas
- Token Bot Telegram dari [@BotFather](https://t.me/BotFather)

## Instalasi
1. Clone repositori ini atau copy seluruh filenya.
2. Jalankan instalasi dependency:
   ```bash
   npm install
   ```

## Setup Konfigurasi
Copy `.env.example` menjadi `.env`:
```bash
cp .env.example .env
```
Isi konfigurasi di file `.env`:
- `TELEGRAM_BOT_TOKEN`: Token dari BotFather.
- `ALLOWED_USER_IDS`: ID telegram kamu (pisahkan dengan koma jika lebih dari satu).
- `FUND_PK`: Private key dari wallet sumber dana (TANPA 0x jika sudah ada, script membutuhkan `0x` di depannya, pastikan length sesuai).
- `LAUNCH_PK`: Private key dari wallet yang berinteraksi dengan factory.

> ⚠️ **PERINGATAN KEAMANAN**: JANGAN PERNAH commit file `.env` kamu. Jangan hardcode private key ke dalam source code. Selalu test menggunakan wallet khusus bot/testnet dengan dana terbatas, bukan wallet utama!

## Catatan Penting Mengenai ABI
File `src/pons.js` memiliki **Placeholder ABI** untuk interaksi kontrak. Kamu **WAJIB** memperbarui file tersebut:
1. Buka Blockscout / Explorer Robinhood Chain.
2. Cari address Pons Factory: `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`.
3. Copy ABI `launchToken` (atau fungsi setara) dan paste ke dalam variabel `PONS_FACTORY_ABI` di file `src/pons.js`.
4. Sesuaikan argumen fungsi jika nama dan parameter berbeda dengan di boilerplate.

## Cara Penggunaan
1. Jalankan Bot:
   ```bash
   npm start
   ```
2. Buka Telegram dan chat bot kamu.
3. Ketik `/start` untuk membuka menu.
4. Klik **Setup Launch** dan ikuti panduan input (Name, Symbol, Image URL, Description, Fee Wallet).
5. Klik **LAUNCH SEKARANG** atau jalankan command `/launch`.

Bot akan menampilkan update log per Attempt dan link explorer dari eksekusi bundel tx tersebut.
