import { Telegraf, Markup, session } from 'telegraf';
import { config } from './config.js';
import { getBalance, fundAccount, launchAccount } from './wallets.js';
import { runWithRetry, stopRetry, lastStatus } from './launcher.js';
import { privateKeyToAccount } from 'viem/accounts';
import { pons } from './chains/pons.js';
import { walletFromKey, forgetSecret, redact, errMsg } from './security.js';

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
  
  ctx.session.tokenConfig = { launchType: typeKey, typeLabel: typeMap[typeKey] };
  
  if (typeKey === 'bundling') {
    ctx.session.step = 'awaiting_fund_pk';
    ctx.reply(`Platform: *${typeMap[typeKey]}*\n\n🔑 Kirim PRIVATE KEY wallet FUND (Sumber Dana ETH):`, { parse_mode: 'Markdown' });
  } else {
    ctx.session.step = 'awaiting_launch_pk';
    ctx.reply(`Platform: *${typeMap[typeKey]}*\n\n🔑 Kirim PRIVATE KEY wallet launcher (pesan langsung dihapus).\nPakai wallet khusus dengan dana secukupnya!`, { parse_mode: 'Markdown' });
  }
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

  if (step === 'awaiting_fund_pk') {
    if (!/^0x[a-fA-F0-9]{64}$/.test(text)) return ctx.reply('❌ Format PK Fund salah (harus 0x + 64 hex). Ulangi:');
    ctx.session.tokenConfig.fundPk = text;
    // Hapus pesan PK untuk keamanan
    ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    ctx.session.step = 'awaiting_launch_pk';
    ctx.reply('✅ PK Fund diamankan!\n\n🔑 Sekarang kirim PRIVATE KEY wallet LAUNCH (Fake Creator):');
  } else if (step === 'awaiting_launch_pk') {
    if (!/^0x[a-fA-F0-9]{64}$/.test(text)) return ctx.reply('❌ Format PK Launch salah (harus 0x + 64 hex). Ulangi:');
    ctx.session.tokenConfig.launchPk = text;
    // Hapus pesan PK
    ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    ctx.session.step = 'awaiting_name';
    const addr = privateKeyToAccount(text).address;
    ctx.reply(`✅ PK Launch diamankan!\nWallet: \`${addr}\`\n\n📝 Nama token?`, { parse_mode: 'Markdown' });
  } else if (step === 'awaiting_name') {
    if (text.length < 2 || text.length > 32) return ctx.reply('❌ Nama 2-32 karakter. Ulangi:');
    ctx.session.tokenConfig.name = text;
    ctx.session.step = 'awaiting_symbol';
    ctx.reply('🔤 Symbol/ticker? (mis. MEME)');
  } else if (step === 'awaiting_symbol') {
    if (text.length < 1 || text.length > 8) return ctx.reply('❌ Symbol 1-8 karakter. Ulangi:');
    ctx.session.tokenConfig.symbol = text.toUpperCase();
    ctx.session.step = 'awaiting_image';
    ctx.reply("🖼️ URL Logo? Kirim link atau ketik '-' untuk kosong:");
  } else if (step === 'awaiting_image') {
    ctx.session.tokenConfig.imageUrl = text === '-' ? '' : text;
    ctx.session.step = 'awaiting_desc';
    ctx.reply("📝 Deskripsi? Kirim teks atau ketik '-' untuk kosong:");
  } else if (step === 'awaiting_desc') {
    ctx.session.tokenConfig.description = text === '-' ? '' : text;
    ctx.session.step = 'awaiting_website';
    ctx.reply("🌐 URL Website? Kirim link atau ketik '-' untuk kosong:");
  } else if (step === 'awaiting_website') {
    ctx.session.tokenConfig.website = text === '-' ? '' : text;
    ctx.session.step = 'awaiting_twitter';
    ctx.reply("🐦 URL Twitter/X? Kirim link atau ketik '-' untuk kosong:");
  } else if (step === 'awaiting_twitter') {
    ctx.session.tokenConfig.twitter = text === '-' ? '' : text;
    ctx.session.step = 'awaiting_telegram';
    ctx.reply("✈️ URL Telegram? Kirim link atau ketik '-' untuk kosong:");
  } else if (step === 'awaiting_telegram') {
    ctx.session.tokenConfig.telegram = text === '-' ? '' : text;
    if (ctx.session.tokenConfig.launchType === 'pons_biasa') {
      askCreatorTax(ctx);
    } else {
      askFeeWallet(ctx);
    }
  } else if (step === 'awaiting_creator_tax') {
    const n = parseInt(text, 10);
    if (String(n) !== text || n < 0 || n > 1000) return ctx.reply('❌ Masukkan angka 0–1000 (bps). 100 bps = 1%.');
    setCreatorTax(ctx, n);
  } else if (step === 'awaiting_feewallet') {
    let feeWallet = text;
    if (text === '-') {
      const pk = ctx.session.tokenConfig.launchPk;
      feeWallet = pk ? privateKeyToAccount(pk).address : launchAccount.address;
    }
    if (!/^0x[a-fA-F0-9]{40}$/.test(feeWallet)) {
      return ctx.reply('❌ Format address tidak valid. Ulangi:');
    }
    ctx.session.tokenConfig.feeWallet = feeWallet;
    ctx.session.step = 'awaiting_initial_buy';
    
    const buyMenu = Markup.inlineKeyboard([
      [Markup.button.callback('0.01 ETH', 'buy_0.01'), Markup.button.callback('0.02 ETH', 'buy_0.02')],
      [Markup.button.callback('0.03 ETH', 'buy_0.03'), Markup.button.callback('0 ETH', 'buy_0')]
    ]);
    ctx.reply("💰 Berapa ETH untuk Initial Buy?\nPilih atau ketik manual (misal: 0.05):", { ...buyMenu });
  } else if (step === 'awaiting_initial_buy') {
    let buyAmount = parseFloat(text);
    if (isNaN(buyAmount) || buyAmount < 0) return ctx.reply('❌ Jumlah ETH tidak valid. Ketik angka:');
    
    ctx.session.tokenConfig.initialBuy = buyAmount;
    ctx.session.step = 'idle';
    showLaunchConfirmation(ctx);
  }
});

function askCreatorTax(ctx) {
  ctx.session.step = 'awaiting_creator_tax';
  ctx.reply('💸 Creator tax (dev fee dari tiap trade) dalam bps, 0–1000 (100 bps = 1%).\nPilih atau ketik angka:', Markup.inlineKeyboard([
    [Markup.button.callback('0%', 'tax_0'), Markup.button.callback('1%', 'tax_100'), Markup.button.callback('3%', 'tax_300')],
    [Markup.button.callback('5%', 'tax_500'), Markup.button.callback('10%', 'tax_1000')]
  ]));
}

function setCreatorTax(ctx, bps) {
  ctx.session.tokenConfig.creatorTaxBps = bps;
  ctx.reply(`✅ Creator tax: ${bps / 100}%`);
  askFeeWallet(ctx);
}

function askFeeWallet(ctx) {
  ctx.session.step = 'awaiting_feewallet';
  ctx.reply("👛 Wallet Recipient (Penerima Dev Fee)? Kirim alamat 0x... atau ketik '-' untuk pakai wallet launcher.");
}

bot.action(/tax_(\d+)/, (ctx) => {
  ctx.answerCbQuery().catch(() => {});
  if (ctx.session.step !== 'awaiting_creator_tax') return;
  setCreatorTax(ctx, parseInt(ctx.match[1], 10));
});

bot.action(/buy_(.+)/, (ctx) => {
  const buyAmount = parseFloat(ctx.match[1]);
  ctx.session.tokenConfig.initialBuy = buyAmount;
  ctx.session.step = 'idle';
  showLaunchConfirmation(ctx);
});

function showLaunchConfirmation(ctx) {
  const cfg = ctx.session.tokenConfig;
  ctx.reply(
    `*Konfirmasi launch:*\n\n` +
    `Platform: ${cfg.typeLabel || cfg.launchType}\n` +
    `Nama: ${cfg.name}\n` +
    `Symbol: ${cfg.symbol}\n` +
    `Deskripsi: ${cfg.description || '-'}\n` +
    `Logo: ${cfg.imageUrl || '-'}\n` +
    `Website: ${cfg.website || '-'} | X: ${cfg.twitter || '-'} | TG: ${cfg.telegram || '-'}\n` +
    `Initial Buy: ${cfg.initialBuy} ETH\n` +
    (cfg.launchType === 'pons_biasa' ? `Creator Tax (Dev Fee): ${(cfg.creatorTaxBps || 0) / 100}%\n` : '') +
    `Recipient (Dev Fee): \`${cfg.feeWallet}\`\n\n` +
    `⚠️ Pastikan saldo FUND dan LAUNCH mencukupi.\n` +
    `Tax/alokasi TIDAK bisa diubah setelah launch.\n`,
    { parse_mode: 'Markdown', ...Markup.inlineKeyboard([
      [Markup.button.callback('🚀 LAUNCH', 'do_launch'), Markup.button.callback('✖️ Batal', 'cancel_setup')]
    ])}
  );
}

bot.action('cancel_setup', (ctx) => {
  ctx.session.step = 'idle';
  clearKeys(ctx);
  ctx.reply('❌ Setup dibatalkan.');
});

bot.action('do_launch', (ctx) => {
  if (!ctx.session.tokenConfig || !ctx.session.tokenConfig.feeWallet) {
    return ctx.reply('⚠️ Harap Setup Launch terlebih dahulu.');
  }
  startLaunchProcess(ctx);
});

function clearKeys(ctx) {
  const cfg = ctx.session.tokenConfig || {};
  for (const k of ['launchPk', 'fundPk']) {
    if (cfg[k]) { forgetSecret(cfg[k]); delete cfg[k]; }
  }
}

// Pons Biasa: launch lewat pons v2 (src/chains/pons.js) — creator tax, penerima fee, dev buy ETH.
let ponsBusy = false;
async function startPonsLaunch(ctx) {
  const cfg = ctx.session.tokenConfig;
  if (!cfg.launchPk) return ctx.reply('⚠️ Private key sudah dihapus dari memori. Setup Launch ulang.');
  if (ponsBusy) return ctx.reply('⏳ Launch sebelumnya masih diproses...');
  ponsBusy = true;
  const msg = await ctx.reply('⏳ Mulai launch pons v2...');
  const onStatus = async (text) => {
    try { await ctx.telegram.editMessageText(ctx.chat.id, msg.message_id, null, redact(text)); } catch (e) { /* same text / rate limit */ }
  };
  const data = {
    name: cfg.name, symbol: cfg.symbol, description: cfg.description, logo: cfg.imageUrl,
    socials: { website: cfg.website, twitter: cfg.twitter, telegram: cfg.telegram },
    creatorTaxBps: cfg.creatorTaxBps || 0,
    creatorFeeRecipient: cfg.feeWallet,
    buybackEnabled: false,
    pairToken: '',
    devBuy: cfg.initialBuy || 0,
    exemptions: [],
  };
  try {
    const wallet = walletFromKey(cfg.launchPk, pons.provider());
    const res = await pons.launch(wallet, data, onStatus);
    clearKeys(ctx); // sukses → key dihapus dari memori
    const text =
      `🎉 LAUNCHED di pons v2\n\n` +
      `Token: ${res.token}\nCurve: ${res.curve}\n` +
      `Dev buy: ${res.devBuy} ETH → ~${Number(res.tokensOut).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${cfg.symbol}\n` +
      `Creator tax: ${data.creatorTaxBps / 100}% → ${data.creatorFeeRecipient}\n` +
      `Tx: ${res.links.tx}\nToken: ${res.links.token}` + (res.note ? `\nℹ️ ${res.note}` : '');
    await ctx.reply(text, { disable_web_page_preview: true });
  } catch (e) {
    console.error('pons launch error:', redact(e?.stack || String(e)));
    const pending = e.pending ? `\nTx: https://robinhoodchain.blockscout.com/tx/${e.hash} — cek dulu sebelum launch ulang.` : '';
    await ctx.reply('❌ Launch gagal: ' + errMsg(e) + pending, Markup.inlineKeyboard([[Markup.button.callback('🚀 LAUNCH ULANG DATA SAMA', 'do_launch')]]));
  } finally {
    ponsBusy = false;
  }
}

let launchMessageId = null;
async function startLaunchProcess(ctx) {
  if (ctx.session.tokenConfig.launchType === 'pons_biasa') return startPonsLaunch(ctx);
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

    const isDone = status.status === 'SUCCESS' || status.status === 'FAILED';
    const extraMenu = isDone ? Markup.inlineKeyboard([[Markup.button.callback('🚀 LAUNCH ULANG DATA SAMA', 'do_launch')]]) : Markup.inlineKeyboard([]);

    try {
      await ctx.telegram.editMessageText(ctx.chat.id, launchMessageId, null, text, { parse_mode: 'Markdown', disable_web_page_preview: true, ...extraMenu });
    } catch (e) {
      // Abaikan error edit jika pesan sama persis
    }
  });
}
