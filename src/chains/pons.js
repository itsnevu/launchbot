// pons v2 — Robinhood Chain. Launch + dev buy via router.launchAndBuy (1 tx, dev exempt snipe tax).
import { ethers } from "ethers";
import { CFG } from "../config.js";
import { makeProvider, withRetry, waitTx } from "../rpc.js";

const C = CFG.pons;

const PARAMS_T = "(string name,string symbol,string logo,string description,(string twitter,string telegram,string discord,string website,string farcaster) socials,address creatorFeeRecipient,uint16 creatorTaxBps,bool buybackEnabled,bytes32 expectedEconomics,bytes32 salt)";
const FACTORY_ABI = [
  "function previewLaunchEconomics(uint256 launchConfigId, address pairToken) view returns (bytes32)",
  "function launchFee() view returns (uint256)",
  "function canLaunch(address) view returns (bool)",
  "function launchEnabled() view returns (bool)",
  "function maxCreatorTaxBps() view returns (uint256)",
  `function launchToken(${PARAMS_T} params, uint256 launchConfigId, address pairToken) payable returns (address token, address curve)`,
];
const ROUTER_ABI = [
  `function launchAndBuy(${PARAMS_T} params, uint256 launchConfigId, address pairToken, uint256 quoteIn, uint256 minTokensOut, address recipient, address[] snipeTaxExemptions) payable returns (address token, address curve, uint256 tokensOut)`,
];

// Cadangan gas untuk precheck (sebelum ada calldata). Riil ~3.6M @ 0.05 gwei ≈ 0.0002 ETH; batas atas maxFeePerGas ≈ 3×.
const GAS_RESERVE = ethers.parseEther("0.001");

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

  // Saldo vs kebutuhan, ditampilkan di layar konfirmasi (tanpa simulasi penuh).
  async precheck(wallet, data) {
    const factory = new ethers.Contract(C.factory, FACTORY_ABI, wallet.provider);
    const [bal, fee] = await withRetry(() => Promise.all([wallet.provider.getBalance(wallet.address), factory.launchFee()]), { label: "precheck" });
    const devBuy = data.devBuy && Number(data.devBuy) > 0 ? ethers.parseEther(String(data.devBuy)) : 0n;
    const need = fee + devBuy + GAS_RESERVE;
    return {
      ok: bal >= need,
      text: `Saldo: ${ethers.formatEther(bal)} ETH | Butuh ≈ ${ethers.formatEther(need)} ETH (fee ${ethers.formatEther(fee)} + dev buy ${ethers.formatEther(devBuy)} + gas)`,
    };
  },

  // data: { name, symbol, description, logo, socials{twitter,telegram,discord,website,farcaster},
  //         creatorTaxBps, buybackEnabled, devBuy (ETH), exemptions: address[] (bebas snipe tax) }
  // opts.dryRun = true → berhenti setelah simulasi + estimasi gas, tidak kirim tx.
  async launch(wallet, data, onStatus = async () => {}, { dryRun = false } = {}) {
    const provider = wallet.provider;
    const factory = new ethers.Contract(C.factory, FACTORY_ABI, provider);
    const factoryW = new ethers.Contract(C.factory, FACTORY_ABI, wallet);
    const router = new ethers.Contract(C.router, ROUTER_ABI, wallet);

    // 1) gate + batas tax (dibaca dari chain, bukan hardcode)
    const [enabled, can, maxTax] = await withRetry(
      () => Promise.all([factory.launchEnabled(), factory.canLaunch(wallet.address), factory.maxCreatorTaxBps().catch(() => BigInt(C.maxCreatorTaxBps))]),
      { label: "gate" });
    if (!enabled || !can) throw new Error("Launch pons v2 sedang ditutup untuk wallet ini (gate/whitelist).");

    // 2) fee + pin economics (dibaca tepat sebelum kirim)
    const [launchFee, expectedEconomics] = await withRetry(
      () => Promise.all([factory.launchFee(), factory.previewLaunchEconomics(C.launchConfigId, C.pairToken)]), { label: "fee" });

    const quoteIn = data.devBuy && Number(data.devBuy) > 0 ? ethers.parseEther(String(data.devBuy)) : 0n;
    const value = launchFee + quoteIn;
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

    await onStatus("🔎 Simulasi transaksi & quote dev buy...");

    // 4) dry-run: dapat token/curve/tokensOut → minTokensOut presisi (− slippage)
    let predicted, minTokensOut = 0n;
    if (quoteIn > 0n) {
      predicted = await router.launchAndBuy.staticCall(params, C.launchConfigId, C.pairToken, quoteIn, 0n, wallet.address, exemptions, { value });
      minTokensOut = (predicted.tokensOut * (10_000n - CFG.slippageBps)) / 10_000n;
    } else {
      predicted = await factoryW.launchToken.staticCall(params, C.launchConfigId, C.pairToken, { value: launchFee });
    }

    // 5) gas
    const gas = quoteIn > 0n
      ? await router.launchAndBuy.estimateGas(params, C.launchConfigId, C.pairToken, quoteIn, minTokensOut, wallet.address, exemptions, { value })
      : await factoryW.launchToken.estimateGas(params, C.launchConfigId, C.pairToken, { value: launchFee });
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
      fee: ethers.formatEther(launchFee), devBuy: ethers.formatEther(quoteIn),
      gas: gas.toString(), gasCost: ethers.formatEther(gasCost), totalCost: ethers.formatEther(value + gasCost),
      links: { token: `${C.explorer}/token/${predicted.token}` },
    };
    if (dryRun) return { ...base, dryRun: true, note: gasNote + "Alamat token akan berbeda saat launch nyata (salt baru)." };

    await onStatus(`📤 Mengirim tx (gas ~${gas}, dev buy ${ethers.formatEther(quoteIn)} ETH, minTokensOut ${ethers.formatEther(minTokensOut)})...`);

    // 6) kirim
    const tx = quoteIn > 0n
      ? await router.launchAndBuy(params, C.launchConfigId, C.pairToken, quoteIn, minTokensOut, wallet.address, exemptions, { value, gasLimit })
      : await factoryW.launchToken(params, C.launchConfigId, C.pairToken, { value: launchFee, gasLimit });
    await onStatus(`⏳ Tx terkirim: ${tx.hash}\nMenunggu konfirmasi...`);
    const receipt = await waitTx(tx, { label: "Launch" });

    // 7) hasil — alamat dari staticCall (salt sama → CREATE2 sama); cross-check dengan log
    const token = predicted.token;
    const seen = receipt.logs.some((l) => l.topics.some((t) => t.toLowerCase().endsWith(token.slice(2).toLowerCase())) || l.address.toLowerCase() === token.toLowerCase());
    return {
      ...base,
      txHash: receipt.hash,
      gas: receipt.gasUsed.toString(),
      note: seen ? "" : "(alamat token dari simulasi; cek explorer untuk memastikan)",
      links: { ...base.links, tx: `${C.explorer}/tx/${receipt.hash}` },
    };
  },
};
