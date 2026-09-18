// pons v2 — Robinhood Chain. Launch + dev buy via router.launchAndBuy (1 tx, dev exempt snipe tax).
// Pair token: ETH (address 0) atau ERC-20 yang disetujui factory (approvedPairTokens: USDG, cbBTC, saham tokenized, …).
// Pasca-launch: curve.sell (sebelum graduate), fee creator via curve.sweepFees → escrow.claim.
import { ethers } from "ethers";
import { CFG } from "../config.js";
import { makeProvider, withRetry, waitTx } from "../rpc.js";

const C = CFG.pons;
const ZERO = ethers.ZeroAddress;

const PARAMS_T = "(string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt)";
const FACTORY_ABI = [
  "function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)",
  "function launchFee() view returns (uint256)",
  "function canLaunch(address) view returns (bool)",
  "function launchEnabled() view returns (bool)",
  "function maxCreatorTaxBps() view returns (uint256)",
  "function approvedPairTokens(address) view returns (bool)",
  `function launchToken(${PARAMS_T} params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)`,
];
const ROUTER_ABI = [
  `function launchAndBuy(${PARAMS_T} params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)`,
];
// ABI curve/escrow/token: selector diverifikasi dari bytecode + tx nyata (2026-09-19), nama argumen = tebakan.
const CURVE_ABI = [
  "function buy(uint256 quoteIn, uint256 minTokensOut, address recipient) payable returns (uint256)",
  "function sell(uint256 tokensIn, uint256 minQuoteOut, address recipient) returns (uint256)",
  "function sweepFees(uint256 minAmount)", // permissionless: kirim fee terkumpul ke escrow (creator + protokol)
  "function graduated() view returns (bool)",
  "function graduationThreshold() view returns (uint256)",
  "function realQuoteReserve() view returns (uint256)",
  "function pairToken() view returns (address)",
  "function token() view returns (address)",
  "function creatorTaxBps() view returns (uint256)",
  "function feeEscrow() view returns (address)",
];
const ESCROW_ABI = ["function balanceOf(address) view returns (uint256)", "function claim()"];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function curve() view returns (address)", // token pons → curve-nya
];
// Event router LaunchedAndBought(token indexed, curve indexed, sender indexed, recipient, quoteIn, tokensOut)
const TOPIC_ROUTER_LAUNCH = "0xdcacba5e347ae7abd91cb519eb877af8fa7774e347b85dd3ddcd24a2ba8cdf37";
// Event factory TokenLaunched(token indexed, curve indexed, creator indexed, pairToken, launchConfigId, quoteIn)
const TOPIC_FACTORY_LAUNCH = "0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607";

// Cadangan gas untuk precheck (sebelum ada calldata). Riil ~3.6M @ 0.05 gwei ≈ 0.0002 ETH; batas atas maxFeePerGas ≈ 3×.
const GAS_RESERVE = ethers.parseEther("0.001");
const coder = ethers.AbiCoder.defaultAbiCoder();
const fmtNum = (s, max = 4) => Number(s).toLocaleString("en-US", { maximumFractionDigits: max });

// Info pair token: ETH atau ERC-20 (symbol/decimals dibaca on-chain).
async function pairInfo(provider, addr) {
  if (!addr || addr === ZERO) return { address: ZERO, symbol: "ETH", decimals: 18, native: true };
  const t = new ethers.Contract(addr, ERC20_ABI, provider);
  const [symbol, decimals] = await withRetry(() => Promise.all([t.symbol(), t.decimals()]), { label: "pairInfo" });
  return { address: ethers.getAddress(addr), symbol, decimals: Number(decimals), native: false };
}

export const pons = {
  id: "pons",
  label: "pons v2 (Robinhood Chain)",
  nativeSymbol: "ETH",
  explorer: C.explorer,
  provider: () => makeProvider(C),
  health: { ok: true, msg: "" },

  // Dipanggil saat startup: RPC hidup, chainId benar, factory & router punya kode.
  async selfCheck() {
    const provider = this.provider();
    const [net, fcode, rcode] = await Promise.all([provider.getNetwork(), provider.getCode(C.factory), provider.getCode(C.router)]);
    if (Number(net.chainId) !== C.chainId) throw new Error(`chainId ${net.chainId} != ${C.chainId}`);
    if (fcode === "0x" || rcode === "0x") throw new Error("factory/router tidak punya kode — alamat salah?");
    const f = new ethers.Contract(C.factory, FACTORY_ABI, provider);
    const [fee, enabled] = await Promise.all([f.launchFee(), f.launchEnabled()]);
    return `launchFee ${ethers.formatEther(fee)} ETH, launchEnabled ${enabled}`;
  },

  // Info wallet untuk ditampilkan setelah key diterima.
  async walletInfo(wallet) {
    const bal = await withRetry(() => wallet.provider.getBalance(wallet.address), { label: "getBalance" });
    return `${ethers.formatEther(bal)} ETH`;
  },

  // Validasi pair token yang diketik user (dipanggil dari flow, butuh RPC): harus approvedPairTokens.
  async checkPair(addr) {
    const provider = this.provider();
    const f = new ethers.Contract(C.factory, FACTORY_ABI, provider);
    const ok = await withRetry(() => f.approvedPairTokens(addr), { label: "approvedPairTokens" });
    if (!ok) throw new Error("Token ini tidak disetujui factory sebagai pair (approvedPairTokens = false).");
    return pairInfo(provider, addr);
  },

  // Saldo vs kebutuhan, ditampilkan di layar konfirmasi (tanpa simulasi penuh).
  async precheck(wallet, data) {
    const provider = wallet.provider;
    const factory = new ethers.Contract(C.factory, FACTORY_ABI, provider);
    const pair = await pairInfo(provider, data.pairToken);
    const [bal, fee] = await withRetry(() => Promise.all([provider.getBalance(wallet.address), factory.launchFee()]), { label: "precheck" });
    const devBuy = data.devBuy && Number(data.devBuy) > 0 ? ethers.parseUnits(String(data.devBuy), pair.decimals) : 0n;
    if (pair.native) {
      const need = fee + devBuy + GAS_RESERVE;
      return {
        ok: bal >= need,
        text: `Saldo: ${ethers.formatEther(bal)} ETH | Butuh ≈ ${ethers.formatEther(need)} ETH (fee ${ethers.formatEther(fee)} + dev buy ${ethers.formatEther(devBuy)} + gas)`,
      };
    }
    const pbal = await withRetry(() => new ethers.Contract(pair.address, ERC20_ABI, provider).balanceOf(wallet.address), { label: "pairBalance" });
    const needEth = fee + GAS_RESERVE;
    return {
      ok: bal >= needEth && pbal >= devBuy,
      text: `Saldo: ${ethers.formatEther(bal)} ETH, ${ethers.formatUnits(pbal, pair.decimals)} ${pair.symbol} | Butuh ≈ ${ethers.formatEther(needEth)} ETH (fee + gas) + ${ethers.formatUnits(devBuy, pair.decimals)} ${pair.symbol} dev buy`,
    };
  },

  // data: { name, symbol, description, logo, socials{twitter,telegram,discord,website,farcaster},
  //         creatorTaxBps, buybackEnabled, pairToken (address|""=ETH), devBuy (dalam pair token), exemptions: address[] }
  // opts.dryRun = true → berhenti setelah simulasi + estimasi gas, tidak kirim tx (juga tidak approve).
  async launch(wallet, data, onStatus = async () => {}, { dryRun = false } = {}) {
    const provider = wallet.provider;
    const factory = new ethers.Contract(C.factory, FACTORY_ABI, provider);
    const factoryW = new ethers.Contract(C.factory, FACTORY_ABI, wallet);
    const router = new ethers.Contract(C.router, ROUTER_ABI, wallet);
    const pair = await pairInfo(provider, data.pairToken);
    const pairToken = pair.address;

    // 1) gate + batas tax (dibaca dari chain, bukan hardcode)
    const [enabled, can, maxTax, pairOk] = await withRetry(
      () => Promise.all([
        factory.launchEnabled(), factory.canLaunch(wallet.address),
        factory.maxCreatorTaxBps().catch(() => BigInt(C.maxCreatorTaxBps)),
        pair.native ? true : factory.approvedPairTokens(pairToken),
      ]),
      { label: "gate" });
    if (!enabled || !can) throw new Error("Launch pons v2 sedang ditutup untuk wallet ini (gate/whitelist).");
    if (!pairOk) throw new Error(`Pair ${pair.symbol} tidak disetujui factory.`);

    // 2) fee + pin economics (dibaca tepat sebelum kirim; economics beda per pair)
    const [launchFee, expectedEconomics] = await withRetry(
      () => Promise.all([factory.launchFee(), factory.previewLaunchEconomics(C.launchConfigId, pairToken)]), { label: "fee" });

    const quoteIn = data.devBuy && Number(data.devBuy) > 0 ? ethers.parseUnits(String(data.devBuy), pair.decimals) : 0n;
    // ETH pair: fee + dev buy ikut di value. ERC-20 pair: value = fee saja, dev buy ditarik router via transferFrom.
    const value = pair.native ? launchFee + quoteIn : launchFee;
    const exemptions = (data.exemptions || []).map((a) => ethers.getAddress(a));

    const params = {
      name: data.name, symbol: data.symbol,
      logo: data.logo || "", description: data.description || "",
      socials: {
        twitter: data.socials?.twitter || "", telegram: data.socials?.telegram || "",
        discord: data.socials?.discord || "", website: data.socials?.website || "", farcaster: data.socials?.farcaster || "",
      },
      creatorFeeRecipient: wallet.address, // wajib untuk launchAndBuy
      creatorTaxBps: Number(data.creatorTaxBps || 0),
      buybackEnabled: !!data.buybackEnabled,
      expectedEconomics,
      salt: ethers.hexlify(ethers.randomBytes(32)),
    };
    if (BigInt(params.creatorTaxBps) > maxTax) throw new Error(`Creator tax maks ${maxTax} bps.`);

    // 3) saldo
    const bal = await provider.getBalance(wallet.address);
    if (bal < value) throw new Error(`Saldo kurang. Butuh ~${ethers.formatEther(value)} ETH + gas, ada ${ethers.formatEther(bal)} ETH.`);
    let pairC, simQuoteIn = quoteIn, simNote = "";
    if (!pair.native && quoteIn > 0n) {
      pairC = new ethers.Contract(pairToken, ERC20_ABI, wallet);
      const [pbal, allowance] = await withRetry(() => Promise.all([pairC.balanceOf(wallet.address), pairC.allowance(wallet.address, C.router)]), { label: "pair" });
      if (pbal < quoteIn) throw new Error(`Saldo ${pair.symbol} kurang. Dev buy ${ethers.formatUnits(quoteIn, pair.decimals)}, ada ${ethers.formatUnits(pbal, pair.decimals)}.`);
      if (allowance < quoteIn) {
        if (dryRun) { simQuoteIn = 0n; simNote = `Simulasi tanpa dev buy (${pair.symbol} belum di-approve ke router; approve terjadi saat launch nyata). `; }
        else {
          await onStatus(`🔏 Approve ${ethers.formatUnits(quoteIn, pair.decimals)} ${pair.symbol} ke router...`);
          const atx = await pairC.approve(C.router, quoteIn);
          await waitTx(atx, { timeoutMs: 120_000, label: `Approve ${pair.symbol}` });
        }
      }
    }

    await onStatus("🔎 Simulasi transaksi & quote dev buy...");

    // 4) dry-run: dapat token/curve/tokensOut → minTokensOut presisi (− slippage)
    const useRouter = simQuoteIn > 0n;
    let predicted, minTokensOut = 0n;
    if (useRouter) {
      predicted = await router.launchAndBuy.staticCall(params, C.launchConfigId, pairToken, simQuoteIn, 0n, wallet.address, exemptions, { value });
      minTokensOut = (predicted.tokensOut * (10_000n - CFG.slippageBps)) / 10_000n;
    } else {
      predicted = await factoryW.launchToken.staticCall(params, C.launchConfigId, pairToken, { value: launchFee });
    }

    // 5) gas
    const gas = useRouter
      ? await router.launchAndBuy.estimateGas(params, C.launchConfigId, pairToken, simQuoteIn, minTokensOut, wallet.address, exemptions, { value })
      : await factoryW.launchToken.estimateGas(params, C.launchConfigId, pairToken, { value: launchFee });
    const gasLimit = (gas * 125n) / 100n;
    const feeData = await provider.getFeeData();
    const gasCost = gasLimit * (feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n);
    let gasNote = "";
    if (bal < value + gasCost) {
      const msg = `Saldo kurang untuk gas. Butuh ~${ethers.formatEther(value + gasCost)} ETH, ada ${ethers.formatEther(bal)} ETH.`;
      if (!dryRun) throw new Error(msg);
      gasNote = "⚠️ " + msg + " ";
    }

    const tokensOut = predicted.tokensOut ? ethers.formatEther(predicted.tokensOut) : "0";
    const base = {
      token: predicted.token, curve: predicted.curve, tokensOut,
      fee: ethers.formatEther(launchFee), devBuy: ethers.formatUnits(quoteIn, pair.decimals), devBuySymbol: pair.symbol,
      gas: gas.toString(), gasCost: ethers.formatEther(gasCost), totalCost: ethers.formatEther(value + gasCost),
      links: { token: `${C.explorer}/token/${predicted.token}` },
    };
    if (dryRun) return { ...base, dryRun: true, note: simNote + gasNote + "Alamat token akan berbeda saat launch nyata (salt baru)." };

    await onStatus(`📤 Mengirim tx (gas ~${gas}, dev buy ${base.devBuy} ${pair.symbol}, minTokensOut ${ethers.formatEther(minTokensOut)})...`);

    // 6) kirim
    const tx = useRouter
      ? await router.launchAndBuy(params, C.launchConfigId, pairToken, quoteIn, minTokensOut, wallet.address, exemptions, { value, gasLimit })
      : await factoryW.launchToken(params, C.launchConfigId, pairToken, { value: launchFee, gasLimit });
    await onStatus(`⏳ Tx terkirim: ${tx.hash}\nMenunggu konfirmasi...`);
    const receipt = await waitTx(tx, { label: "Launch" });

    // 7) hasil dari event: factory TokenLaunched (token, curve) + router LaunchedAndBought (tokensOut riil)
    let token = predicted.token, curve = predicted.curve, realOut = null, seen = false;
    const fl = receipt.logs.find((l) => l.address.toLowerCase() === C.factory.toLowerCase() && l.topics[0] === TOPIC_FACTORY_LAUNCH);
    if (fl) { token = ethers.getAddress("0x" + fl.topics[1].slice(26)); curve = ethers.getAddress("0x" + fl.topics[2].slice(26)); seen = true; }
    const rl = receipt.logs.find((l) => l.address.toLowerCase() === C.router.toLowerCase() && l.topics[0] === TOPIC_ROUTER_LAUNCH);
    if (rl) realOut = coder.decode(["address", "uint256", "uint256"], rl.data)[2];
    return {
      ...base,
      txHash: receipt.hash, token, curve,
      tokensOut: realOut !== null ? ethers.formatEther(realOut) : tokensOut, // riil dari event; fallback staticCall
      gas: receipt.gasUsed.toString(),
      note: seen ? "" : "(event TokenLaunched tidak ditemukan; alamat dari simulasi)",
      links: { token: `${C.explorer}/token/${token}`, tx: `${C.explorer}/tx/${receipt.hash}` },
    };
  },

  // ---------------- pasca-launch ----------------
  // Status token: saldo, graduasi, progres curve, fee creator (pending di curve + claimable di escrow).
  async status(wallet, tokenAddr) {
    const provider = wallet.provider;
    const token = new ethers.Contract(tokenAddr, ERC20_ABI, provider);
    const [symbol, curveAddr, bal] = await withRetry(() => Promise.all([token.symbol(), token.curve(), token.balanceOf(wallet.address)]), { label: "token" });
    const curve = new ethers.Contract(curveAddr, CURVE_ABI, provider);
    const [graduated, threshold, real, pairAddr, taxBps, escrowAddr] = await withRetry(
      () => Promise.all([curve.graduated(), curve.graduationThreshold(), curve.realQuoteReserve(), curve.pairToken(), curve.creatorTaxBps(), curve.feeEscrow().catch(() => C.feeEscrow)]),
      { label: "curve" });
    const pair = await pairInfo(provider, pairAddr);
    const escrow = new ethers.Contract(escrowAddr, ESCROW_ABI, provider);
    const claimable = await withRetry(() => escrow.balanceOf(wallet.address), { label: "escrow" });
    const pct = threshold > 0n ? Number((real * 10_000n) / threshold) / 100 : 0;
    const f = (v) => ethers.formatUnits(v, pair.decimals);
    return {
      symbol, curve: curveAddr, pair, graduated, balance: ethers.formatEther(bal), balanceRaw: bal,
      claimable: f(claimable), claimableRaw: claimable,
      text:
        `Token: ${symbol}\nSaldo kamu: ${fmtNum(ethers.formatEther(bal), 2)} ${symbol}\n` +
        (graduated
          ? `Status: 🎓 sudah graduate ke Uniswap v4 — jual lewat pons UI/DEX (curve sudah tutup).\n`
          : `Status: bonding curve ${pct}% (${fmtNum(f(real), 6)} / ${fmtNum(f(threshold), 6)} ${pair.symbol})\n`) +
        `Creator tax: ${taxBps} bps\nFee creator di escrow: ${fmtNum(f(claimable), 6)} ${pair.symbol} (Klaim = sweep fee dari curve dulu, lalu klaim)`,
    };
  },

  // Jual pct% saldo ke curve. minQuoteOut = quote staticCall − slippage. Hanya sebelum graduate.
  async sell(wallet, tokenAddr, pct, onStatus = async () => {}) {
    const provider = wallet.provider;
    const token = new ethers.Contract(tokenAddr, ERC20_ABI, wallet);
    const [symbol, curveAddr, bal] = await withRetry(() => Promise.all([token.symbol(), token.curve(), token.balanceOf(wallet.address)]), { label: "token" });
    const curve = new ethers.Contract(curveAddr, CURVE_ABI, wallet);
    if (await curve.graduated()) throw new Error("Token sudah graduate — curve tutup. Jual lewat pons UI / Uniswap v4.");
    const pair = await pairInfo(provider, await curve.pairToken());
    const amount = (bal * BigInt(pct)) / 100n;
    if (amount <= 0n) throw new Error(`Saldo ${symbol} 0.`);
    const allowance = await token.allowance(wallet.address, curveAddr);
    if (allowance < amount) {
      await onStatus(`🔏 Approve ${symbol} ke curve...`);
      await waitTx(await token.approve(curveAddr, amount), { timeoutMs: 120_000, label: "Approve" });
    }
    await onStatus("🔎 Quote jual...");
    const quote = await curve.sell.staticCall(amount, 0n, wallet.address);
    const minOut = (quote * (10_000n - CFG.slippageBps)) / 10_000n;
    await onStatus(`📤 Jual ${fmtNum(ethers.formatEther(amount), 2)} ${symbol} → ≈ ${fmtNum(ethers.formatUnits(quote, pair.decimals), 6)} ${pair.symbol} (min ${fmtNum(ethers.formatUnits(minOut, pair.decimals), 6)})...`);
    const tx = await curve.sell(amount, minOut, wallet.address);
    await onStatus(`⏳ Tx terkirim: ${tx.hash}\nMenunggu konfirmasi...`);
    const receipt = await waitTx(tx, { label: "Jual" });
    return {
      txHash: receipt.hash, amountIn: ethers.formatEther(amount), symbol,
      out: ethers.formatUnits(quote, pair.decimals), outSymbol: pair.symbol, gas: receipt.gasUsed.toString(),
      links: { tx: `${C.explorer}/tx/${receipt.hash}` },
      text: `✅ Terjual ${fmtNum(ethers.formatEther(amount), 2)} ${symbol} → ≈ ${fmtNum(ethers.formatUnits(quote, pair.decimals), 6)} ${pair.symbol}`,
    };
  },

  // Klaim fee creator: sweepFees (kalau ada yang masih di curve) lalu escrow.claim().
  async claim(wallet, tokenAddr, onStatus = async () => {}) {
    const provider = wallet.provider;
    const st = await this.status(wallet, tokenAddr);
    const curve = new ethers.Contract(st.curve, CURVE_ABI, wallet);
    const escrowAddr = await curve.feeEscrow().catch(() => C.feeEscrow);
    const escrow = new ethers.Contract(escrowAddr, ESCROW_ABI, wallet);
    // sweepFees (permissionless, murah): pindahkan fee yang masih di curve ke escrow. Gagal → tetap coba klaim yang sudah ada.
    let swept = false;
    if (!st.graduated) {
      await onStatus("🧹 sweepFees: kirim fee dari curve ke escrow...");
      try { await waitTx(await curve.sweepFees(0n), { timeoutMs: 120_000, label: "sweepFees" }); swept = true; }
      catch (e) { await onStatus("sweepFees gagal (" + (e.shortMessage || e.message).slice(0, 80) + "), lanjut klaim yang sudah ada..."); }
    }
    const claimable = await escrow.balanceOf(wallet.address);
    if (claimable <= 0n) throw new Error("Belum ada fee creator yang bisa diklaim" + (swept ? " (sweep berhasil tapi bagian creator 0)." : "."));
    await onStatus(`📤 Klaim ${fmtNum(ethers.formatUnits(claimable, st.pair.decimals), 6)} ${st.pair.symbol}...`);
    const tx = await escrow.claim();
    await onStatus(`⏳ Tx terkirim: ${tx.hash}\nMenunggu konfirmasi...`);
    const receipt = await waitTx(tx, { label: "Klaim" });
    return {
      txHash: receipt.hash, amount: ethers.formatUnits(claimable, st.pair.decimals), symbol: st.pair.symbol,
      links: { tx: `${C.explorer}/tx/${receipt.hash}` },
      text: `✅ Fee creator diklaim: ${fmtNum(ethers.formatUnits(claimable, st.pair.decimals), 6)} ${st.pair.symbol}`,
    };
  },
};
