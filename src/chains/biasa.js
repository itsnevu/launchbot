import { ethers } from "ethers";
import { CFG } from "../config.js";
import { makeProvider, withRetry, waitTx } from "../rpc.js";

const C = CFG.biasa;

const ABI = [
    "function launchFee() view returns (uint256)",
    "function launchToken(string name, string symbol, uint256 supply, address recipient) payable returns (address)",
    "event TokenLaunched(address indexed creator, address indexed token, string name, string symbol, uint256 supply, address actualCaller)"
];

export const biasa = {
  id: "biasa",
  label: "Launch Biasa (Fake Creator)",
  nativeSymbol: C.nativeSymbol,
  explorer: C.explorer,
  provider: () => makeProvider(C),
  health: { ok: true, msg: "" },

  async selfCheck() {
    const provider = this.provider();
    if (C.factory === "0x0000000000000000000000000000000000000000") return "Factory kosong, launch mungkin gagal (butuh config FACTORY_ADDRESS)";
    const fcode = await provider.getCode(C.factory);
    if (fcode === "0x") throw new Error("factory tidak punya kode — alamat salah?");
    const f = new ethers.Contract(C.factory, ABI, provider);
    const fee = await f.launchFee();
    return `launchFee ${ethers.formatEther(fee)} ETH`;
  },

  async walletInfo(wallet) {
    const bal = await withRetry(() => wallet.provider.getBalance(wallet.address), { label: "getBalance" });
    return `${ethers.formatEther(bal)} ETH`;
  },

  async precheck(wallet, data) {
    if (C.factory === "0x0000000000000000000000000000000000000000") return { ok: false, text: "Factory belum di-set di config" };
    const provider = wallet.provider;
    const factory = new ethers.Contract(C.factory, ABI, provider);
    const [bal, fee] = await withRetry(() => Promise.all([provider.getBalance(wallet.address), factory.launchFee()]), { label: "precheck" });
    const need = fee + ethers.parseEther("0.001"); // gas reserve
    return {
      ok: bal >= need,
      text: `Saldo: ${ethers.formatEther(bal)} ETH | Butuh ≈ ${ethers.formatEther(need)} ETH (fee ${ethers.formatEther(fee)} + gas)`,
    };
  },

  async launch(wallet, data, onStatus = async () => {}, { dryRun = false } = {}) {
    if (C.factory === "0x0000000000000000000000000000000000000000") throw new Error("Factory belum di-set");
    const provider = wallet.provider;
    const factoryW = new ethers.Contract(C.factory, ABI, wallet);
    
    const launchFee = await factoryW.launchFee();
    const bal = await provider.getBalance(wallet.address);
    if (bal < launchFee) throw new Error(`Saldo kurang. Butuh ${ethers.formatEther(launchFee)} ETH.`);

    const recipient = data.recipient ? ethers.getAddress(data.recipient) : wallet.address;

    await onStatus("🔎 Estimasi gas...");
    const gas = await factoryW.launchToken.estimateGas(data.name, data.symbol, data.supply, recipient, { value: launchFee });
    
    const gasCost = gas * (await provider.getFeeData()).maxFeePerGas;
    const totalCost = launchFee + gasCost;

    if (bal < totalCost) {
      if (!dryRun) throw new Error(`Saldo kurang untuk gas. Butuh ~${ethers.formatEther(totalCost)} ETH`);
    }

    const base = {
      token: "?", curve: "-", tokensOut: "0",
      fee: ethers.formatEther(launchFee), devBuy: "0", devBuySymbol: "",
      gas: gas.toString(), gasCost: ethers.formatEther(gasCost), totalCost: ethers.formatEther(totalCost),
      links: {},
    };

    if (dryRun) return { ...base, dryRun: true, note: "Simulasi berhasil." };

    await onStatus(`📤 Mengirim tx (gas ~${gas})...`);
    
    const tx = await factoryW.launchToken(data.name, data.symbol, data.supply, recipient, { value: launchFee, gasLimit: gas * 120n / 100n });
    await onStatus(`⏳ Tx terkirim: ${tx.hash}\nMenunggu konfirmasi...`);
    const receipt = await waitTx(tx, { label: "Launch" });

    let tokenAddress, creator, actualCaller;
    for (const log of receipt.logs) {
      try {
        const parsedLog = factoryW.interface.parseLog({ topics: log.topics, data: log.data });
        if (parsedLog && parsedLog.name === 'TokenLaunched') {
          creator = parsedLog.args[0];
          tokenAddress = parsedLog.args[1];
          actualCaller = parsedLog.args[5];
          break;
        }
      } catch (e) { }
    }

    return {
      ...base,
      txHash: receipt.hash, token: tokenAddress || "?",
      gas: receipt.gasUsed.toString(),
      note: tokenAddress ? `Token diluncurkan! Creator tercatat: ${creator}` : "Event TokenLaunched tidak ditemukan.",
      links: { tx: `${C.explorer}/tx/${receipt.hash}` },
    };
  },

  async status(wallet, tokenAddr) {
    return { text: "Token biasa tidak memiliki fitur kelola bonding curve/tax." };
  },

  async sell(wallet, tokenAddr, pct, onStatus) {
    throw new Error("Tidak didukung untuk tipe Launch Biasa.");
  },

  async claim(wallet, tokenAddr, onStatus) {
    throw new Error("Tidak didukung untuk tipe Launch Biasa.");
  }
};
