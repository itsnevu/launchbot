import { config } from './src/config.js';
import { fundAccount, launchAccount, getBalance } from './src/wallets.js';
import { bot } from './src/bot.js';

async function main() {
  console.log('====================================');
  console.log('🚀 PONS LAUNCHER BOT STARTING...');
  console.log('====================================');
  console.log(`Chain ID       : ${config.CHAIN_ID}`);
  console.log(`Pons Factory   : ${config.PONS_FACTORY}`);
  console.log(`Fund Wallet    : ${fundAccount.address}`);
  console.log(`Launch Wallet  : ${launchAccount.address}`);

  try {
    const fundBal = await getBalance(fundAccount.address);
    const launchBal = await getBalance(launchAccount.address);
    console.log(`Fund Balance   : ${fundBal} ETH`);
    console.log(`Launch Balance : ${launchBal} ETH`);
  } catch (error) {
    console.error('⚠️ Gagal mengambil saldo:', error.message);
  }
  console.log('====================================');

  bot.launch().then(() => {
    console.log('🤖 Telegram Bot berhasil berjalan!');
  }).catch((err) => {
    console.error('❌ Telegram Bot gagal berjalan:', err);
  });

  // Enable graceful stop
  process.once('SIGINT', () => bot.stop('SIGINT'));
  process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

main();
