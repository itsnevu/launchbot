import { Telegraf, Markup, session } from 'telegraf';
import config from './config.js';
import { getBalance, fundAccount, launchAccount } from './wallets.js';
import { runWithRetry, stopRetry, lastStatus } from './launcher.js';

export const bot = new Telegraf(config.TELEGRAM_BOT_TOKEN);

// Gunakan session middleware untuk state per-user
bot.use(session());

const authMiddleware = (ctx, next) => {
  if (config.ALLOWED_USER_IDS.includes(ctx.from.id)) {
    return next();
  }
  return ctx.reply('⛔ Unauthorized User.');
};

bot.use(authMiddleware);

// State mesin sederhana untuk form
bot.use((ctx, next) => {
  if (!ctx.session) ctx.session = { step: 'idle', tokenConfig: {} };
  return next();
});

const mainMenu = Markup.inlineKeyboard([
  [Markup.button.callback('🚀 Setup Launch', 'setup_launch'), Markup.button.callback('💰 Balance', 'balance')],
  [Markup.button.callback('⚙️ Settings', 'settings'), Markup.button.callback('🛑 Stop', 'stop')],
  [Markup.button.callback('📊 Status', 'status')]
]);

bot.command('start', (ctx) => {
  ctx.session.step = 'idle';
  ctx.reply('🤖 *Pons Token Launcher Bot*\nPilih menu di bawah ini:', { parse_mode: 'Markdown', ...mainMenu });
});

bot.action('setup_launch', (ctx) => {
  const typeMenu = Markup.inlineKeyboard([
    [Markup.button.callback('Pons Biasa', 'type_pons_biasa')],
    [Markup.button.callback('Argus (ARC)', 'type_argus_arc')],
    [Markup.button.callback('Launch Bundling', 'type_bundling')]
  ]);
  ctx.reply('Pilih Tipe Launch:', { ...typeMenu });
});

bot.action(/type_(.+)/, (ctx) => {
  const typeMap = {
    'pons_biasa': 'Pons Biasa',
    'argus_arc': 'Argus (ARC)',
    'bundling': 'Launch Bundling'
  };
  const typeKey = ctx.match[1];
  
  ctx.session.step = 'awaiting_name';
  ctx.session.tokenConfig = { launchType: typeKey };
  ctx.reply(`✅ Tipe dipilih: *${typeMap[typeKey]}*\n\n📝 Kirim nama token:`, { parse_mode: 'Markdown' });
});

bot.action('balance', async (ctx) => {
  const fundBal = await getBalance(fundAccount.address);
  const launchBal = await getBalance(launchAccount.address);
  ctx.reply(
    `💰 *Wallets Balance*\n\n` +
    `*FUND*: \`${fundAccount.address}\`\nSaldo: ${fundBal} ETH\n\n` +
    `*LAUNCH*: \`${launchAccount.address}\`\nSaldo: ${launchBal} ETH`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('settings', (ctx) => {
  ctx.reply(
    `⚙️ *Current Settings*\n\n` +
    `FUND_AMOUNT: ${config.FUND_AMOUNT}\n` +
    `MAX_ATTEMPTS: ${config.MAX_ATTEMPTS}\n` +
    `RETRY_DELAY_MS: ${config.RETRY_DELAY_MS}\n` +
    `GAS_PRICE_GWEI: ${config.GAS_PRICE_GWEI}\n` +
    `PONS_LAUNCH_FEE: ${config.PONS_LAUNCH_FEE}`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('stop', (ctx) => {
  stopRetry();
  ctx.reply('🛑 Retry dihentikan.');
});

bot.action('status', (ctx) => {
  ctx.reply(
    `📊 *Retry Status*\n\n` +
    `Attempt: ${lastStatus.attempt}/${config.MAX_ATTEMPTS}\n` +
    `Status: ${lastStatus.status}\n` +
    `Fund TX: ${lastStatus.fundTx || 'N/A'}\n` +
    `Launch TX: ${lastStatus.launchTx || 'N/A'}\n` +
    `Error: ${lastStatus.error || 'None'}`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('launch', (ctx) => {
  if (!ctx.session.tokenConfig || !ctx.session.tokenConfig.feeWallet) {
    return ctx.reply('⚠️ Harap Setup Launch terlebih dahulu.');
  }
  startLaunchProcess(ctx);
});
bot.command('balance', (ctx) => bot.handleUpdate({ callback_query: { data: 'balance', from: ctx.from }, ...ctx }));
bot.command('stop', (ctx) => bot.handleUpdate({ callback_query: { data: 'stop', from: ctx.from }, ...ctx }));
bot.command('status', (ctx) => bot.handleUpdate({ callback_query: { data: 'status', from: ctx.from }, ...ctx }));

bot.on('text', (ctx) => {
  const step = ctx.session.step;
  const text = ctx.message.text.trim();

  if (step === 'awaiting_name') {
    if (text.length > 32) return ctx.reply('Nama max 32 char. Ulangi:');
    ctx.session.tokenConfig.name = text;
    ctx.session.step = 'awaiting_symbol';
    ctx.reply('📝 Kirim ticker token:');
  } else if (step === 'awaiting_symbol') {
    if (text.length > 8) return ctx.reply('Symbol max 8 char. Ulangi:');
    ctx.session.tokenConfig.symbol = text;
    ctx.session.step = 'awaiting_image';
    ctx.reply("📝 Kirim URL gambar (atau ketik 'skip'):");
  } else if (step === 'awaiting_image') {
    ctx.session.tokenConfig.imageUrl = text.toLowerCase() === 'skip' ? '' : text;
    ctx.session.step = 'awaiting_desc';
    ctx.reply("📝 Kirim deskripsi (atau ketik 'skip'):");
  } else if (step === 'awaiting_desc') {
    ctx.session.tokenConfig.description = text.toLowerCase() === 'skip' ? '' : text;
    ctx.session.step = 'awaiting_feewallet';
    ctx.reply("📝 Kirim fee wallet address (atau ketik 'default'):");
  } else if (step === 'awaiting_feewallet') {
    let feeWallet = text;
    if (text.toLowerCase() === 'default') {
      feeWallet = launchAccount.address; 
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(feeWallet)) {
      return ctx.reply('Format address tidak valid. Ulangi:');
    }
    ctx.session.tokenConfig.feeWallet = feeWallet;
    ctx.session.step = 'idle';
    
    ctx.reply(
      `✅ *Setup Selesai*\n\n` +
      `Tipe: ${ctx.session.tokenConfig.launchType}\n` +
      `Name: ${ctx.session.tokenConfig.name}\n` +
      `Symbol: ${ctx.session.tokenConfig.symbol}\n\n` +
      `Gunakan /launch atau tombol di bawah untuk memulai.`,
      { parse_mode: 'Markdown', ...Markup.inlineKeyboard([[Markup.button.callback('🚀 LAUNCH SEKARANG', 'do_launch')]]) }
    );
  }
});

bot.action('do_launch', (ctx) => {
  if (!ctx.session.tokenConfig || !ctx.session.tokenConfig.feeWallet) {
    return ctx.reply('⚠️ Harap Setup Launch terlebih dahulu.');
  }
  startLaunchProcess(ctx);
});

let launchMessageId = null;
async function startLaunchProcess(ctx) {
  const msg = await ctx.reply('Memulai launch...');
  launchMessageId = msg.message_id;

  runWithRetry(ctx.session.tokenConfig, async (status) => {
    const explorer = 'https://robinhoodchain.blockscout.com/tx/';
    let text = `🔄 *Attempt ${status.attempt}/${config.MAX_ATTEMPTS}*\n` +
               `Status: ${status.status}\n`;
    if (status.fundTx) text += `Fund tx: [${status.fundTx.slice(0,10)}...](${explorer}${status.fundTx})\n`;
    if (status.launchTx) text += `Launch tx: [${status.launchTx.slice(0,10)}...](${explorer}${status.launchTx})\n`;
    if (status.blockNumber) text += `Block: ${status.blockNumber}\n`;
    if (status.tokenAddress) text += `\n🎉 *Sukses!* Token Address: \`${status.tokenAddress}\`\n`;
    if (status.error) text += `\n❌ Error: ${status.error}\n`;

    try {
      await ctx.telegram.editMessageText(ctx.chat.id, launchMessageId, null, text, { parse_mode: 'Markdown', disable_web_page_preview: true });
    } catch (e) {
      // Abaikan error edit jika pesan sama persis
    }
  });
}
