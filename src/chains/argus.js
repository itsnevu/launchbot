// Argus — Arc (Circle L1). Launch via Portal#7.createLaunch (selector 0x11b8f0f1), dev buy dalam tx yang sama.
//
// ABI Portal tidak dipublikasikan (bundle arguspad.io di balik browser-check), jadi layout di bawah
// direkonstruksi & diverifikasi dari calldata 40+ tx launch nyata + dry-run eth_call (2026-09-17).
// Hook Uniswap v4 butuh alamat dengan flag 0x2044 → hookSalt harus di-mining. Portal menyediakan
// view 0x3ae04f1d(creator, tokenSalt, hookSalt, buyTax, sellTax, quote) → (hook, flags, valid).
import { ethers } from "ethers";
import { createRequire } from "node:module";
import { CFG } from "../config.js";
import { makeProvider, rawRpc, withRetry, waitTx } from "../rpc.js";

const require = createRequire(import.meta.url);
const MINER = require("./hookSaltMiner.json"); // { abi, runtime } — dari contracts/HookSaltMiner.sol
const MINER_ADDR = "0x00000000000000000000000000000000000a4b1e"; // alamat virtual (state override)

const C = CFG.argus;
const CREATE_SELECTOR = "0x11b8f0f1";
const PREDICT_SELECTOR = "0x3ae04f1d";
const TOPIC_TOKEN_CREATED = "0x1d8917231579f8ce39407f0d616f36f357b07329b0ce5164d0754ac15145ce0a";
const TOPIC_PARTS_DEPLOYED = "0xa54419a494ae20a1807712ab7a33ff0928b9a0e6e03e4562885aedb8e8fcd4da"; // (token indexed, locker, hook, splitter)
const TOPIC_DEV_BUY = "0x84d429ed8af1c9cfe8bb07b556e4120e976c9f4c9232a7f50a15d31d83e232a9"; // (token indexed, creator indexed, usdcIn, tokensOut)
// Cadangan gas untuk precheck. Riil ~2.9M @ 20 gwei ≈ 0.06 USDC; batas atas (maxFeePerGas × limit 1.2×) ≈ 0.14.
const GAS_RESERVE_USDC = ethers.parseUnits("0.2", 6);
const POOL_FEE_BPS = 25n; // fee pool Uniswap v4 Argus (0.25%), dicocokkan dengan tx nyata
// Registry config creator. Launch dengan dividends > 0 revert (0xf44fdf02) kalau creator belum punya config.
// Frontend Argus mendaftarkan creator sendiri via 0x47f8b269(1, 0) (permissionless, dari wallet creator).
const CREATOR_REGISTRY = "0x87fe2242b83680f3912829014a5915c9b0a51dd3";
const REGISTRY_ABI = [
  "function configFor(address) view returns (uint256 mode, uint256 extra)",
  "function setConfig(uint256 mode, uint256 extra)", // nama tebakan; selector asli 0x47f8b269
];
const SET_CONFIG_SELECTOR = "0x47f8b269";

const coder = ethers.AbiCoder.defaultAbiCoder();
// Nama field = tebakan (tidak memengaruhi encoding). Urutan & tipe = yang diverifikasi.
const CREATE_TYPES = [
  "tuple(string name,string symbol,uint256 totalSupply,uint256 startMcap,uint256 bondMcap,uint16 buyTaxBps,uint16 sellTaxBps,uint16 creatorFundsBps,uint16 buybackBurnBps,uint16 dividendsBps,uint16 liquidityBps,uint256 devBuyAmount,address quoteAsset,uint256 flag)",
  "tuple(string imageURI,string website,string twitter,string telegram,string description)",
  "bytes32", // tokenSalt → token = create2(portal, keccak(abi.encode(creator, tokenSalt)), clone(tokenImpl))
  "bytes32", // hookSalt  → hasil mining
];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

// Mining hookSalt: 1 eth_call (state override) = ~900 iterasi (cap 30M gas), paralel di semua RPC.
// Rata-rata butuh ~16k percobaan (1/16384) → biasanya < 2 detik.
async function mineHookSalt(rpc, creator, tokenSalt, buyTax, sellTax, onStatus) {
  const iface = new ethers.Interface(MINER.abi);
  const PER_CALL = 900;
  const PAR = Math.max(3, C.rpcUrls.length * 2);
  const MAX_ROUNDS = 40;
  let tried = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const jobs = Array.from({ length: PAR }, () => {
      const data = iface.encodeFunctionData("mine", [
        C.portal, creator, tokenSalt, ethers.hexlify(ethers.randomBytes(32)), buyTax, sellTax, C.usdc, PER_CALL,
      ]);
      return rpc(
        "eth_call",
        [{ to: MINER_ADDR, data, gas: "0x1c9c380" }, "latest", { [MINER_ADDR]: { code: MINER.runtime } }],
        { tries: 1 }
      )
        .then((r) => iface.decodeFunctionResult("mine", r))
        .catch(() => null);
    });
    const results = await Promise.all(jobs);
    for (const r of results) {
      if (!r) continue;
      tried += Number(r.tried);
      if (r.found) return { hookSalt: r.salt, hook: r.hook, tried };
    }
    if (results.every((r) => r === null)) {
      // state override tidak didukung / semua gagal → fallback batch eth_call biasa
      return mineHookSaltBatch(rpc, creator, tokenSalt, buyTax, sellTax, onStatus);
    }
    if (round % 3 === 2) await onStatus(`⛏️ Mining hook salt... ${tried} percobaan`);
  }
  throw new Error("Mining hook salt gagal (RPC tidak stabil). Coba lagi.");
}

async function mineHookSaltBatch(rpc, creator, tokenSalt, buyTax, sellTax, onStatus) {
  const N = 150;
  for (let round = 0; round < 400; round++) {
    const salts = Array.from({ length: N }, () => ethers.hexlify(ethers.randomBytes(32)));
    const batch = salts.map((s, i) => ({
      jsonrpc: "2.0", id: i, method: "eth_call",
      params: [{
        to: C.portal,
        data: PREDICT_SELECTOR + coder.encode(
          ["address", "bytes32", "bytes32", "uint16", "uint16", "address"],
          [creator, tokenSalt, s, buyTax, sellTax, C.usdc]
        ).slice(2),
      }, "latest"],
    }));
    for (const url of C.rpcUrls) {
      try {
        const res = await (await fetch(url, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batch),
        })).json();
        if (!Array.isArray(res)) continue;
        for (const r of res) {
          if (!r.result) continue;
          const [hook, , ok] = coder.decode(["address", "uint256", "bool"], r.result);
          if (ok) return { hookSalt: salts[r.id], hook, tried: round * N };
        }
        break;
      } catch {
        // coba RPC berikutnya
      }
    }
    if (round % 20 === 19) await onStatus(`⛏️ Mining hook salt (mode batch)... ${round * N} percobaan`);
  }
  throw new Error("Mining hook salt gagal.");
}

// Estimasi tokensOut dev buy. Dev buy = trade PERTAMA di pool (atomik dalam tx launch), pool mulai di
// startMcap dengan seluruh supply → constant product: reserve virtual quote = startMcap.
// Dicek vs 3 tx nyata (4 / 450 / 0.002 USDC): selisih < 0.1%.
export function estimateDevBuy(devBuyUsdc6, buyTaxBps) {
  if (devBuyUsdc6 <= 0n) return 0n;
  const xIn = (devBuyUsdc6 * (10_000n - POOL_FEE_BPS)) / 10_000n;
  const gross = (C.totalSupply * xIn) / (C.startMcap + xIn);
  return (gross * (10_000n - BigInt(buyTaxBps))) / 10_000n;
}

function decodeRevert(e) {
  const d = e?.data;
  if (typeof d === "string" && d.startsWith("0x08c379a0")) {
    try { return coder.decode(["string"], "0x" + d.slice(10))[0]; } catch { /* bukan Error(string) */ }
  }
  return (e?.message || String(e)) + (d ? ` data=${String(d).slice(0, 10)}` : "");
}

export const argus = {
  id: "argus",
  label: "Argus (Arc)",
  nativeSymbol: "USDC",
  explorer: C.explorer,
  provider: () => makeProvider(C),
  health: { ok: true, msg: "" },

  // Dipanggil saat startup: RPC hidup, chainId benar, Portal masih punya selector yang kita pakai.
  // ABI Portal hasil reverse-engineering → kalau Portal di-upgrade, bot harus berhenti launch, bukan kirim tx ngawur.
  async selfCheck() {
    const rpc = rawRpc(C.rpcUrls);
    const [chainId, code] = await Promise.all([rpc("eth_chainId", []), rpc("eth_getCode", [C.portal, "latest"])]);
    if (parseInt(chainId) !== C.chainId) throw new Error(`chainId ${parseInt(chainId)} != ${C.chainId}`);
    if (!code.includes(CREATE_SELECTOR.slice(2)) || !code.includes(PREDICT_SELECTOR.slice(2))) {
      throw new Error("Portal tidak punya selector createLaunch/predict — Portal berubah, ABI perlu diverifikasi ulang.");
    }
    return `Portal OK (selector ${CREATE_SELECTOR}, ${PREDICT_SELECTOR})`;
  },

  async walletInfo(wallet) {
    const bal = await withRetry(() => wallet.provider.getBalance(wallet.address), { label: "getBalance" });
    return `${ethers.formatUnits(bal, 18)} USDC (gas + dev buy dari saldo yang sama)`;
  },

  // Saldo vs kebutuhan + estimasi tokensOut, ditampilkan di layar konfirmasi.
  async precheck(wallet, data) {
    const bal = await withRetry(() => wallet.provider.getBalance(wallet.address), { label: "precheck" });
    const devBuy = data.devBuy && Number(data.devBuy) > 0 ? ethers.parseUnits(String(data.devBuy), 6) : 0n;
    const need = (devBuy + GAS_RESERVE_USDC) * 10n ** 12n;
    const est = estimateDevBuy(devBuy, Number(data.buyTaxBps || 0));
    return {
      ok: bal >= need,
      text: `Saldo: ${ethers.formatUnits(bal, 18)} USDC | Butuh ≈ ${ethers.formatUnits(need, 18)} USDC (dev buy + gas)` +
        (devBuy > 0n ? `\nEstimasi dev buy: ≈ ${Number(ethers.formatEther(est)).toLocaleString("en-US", { maximumFractionDigits: 0 })} ${data.symbol} (${(Number(est) / Number(C.totalSupply) * 100).toFixed(2)}% supply)` : ""),
    };
  },

  // data: { name, symbol, description, logo, socials{website,twitter,telegram}, buyTaxBps, sellTaxBps,
  //         alloc{creatorFunds,buybackBurn,dividends,liquidity} (bps), devBuy (USDC string/number) }
  // opts.dryRun = true → mining salt + simulasi + estimasi gas saja, tidak kirim tx (juga tidak approve/registrasi).
  async launch(wallet, data, onStatus = async () => {}, { dryRun = false } = {}) {
    const provider = wallet.provider;
    const rpc = rawRpc(C.rpcUrls);
    const buyTax = Number(data.buyTaxBps);
    const sellTax = Number(data.sellTaxBps);
    if (!(buyTax >= 100 && buyTax <= C.maxTaxBps) || !(sellTax >= 100 && sellTax <= C.maxTaxBps)) {
      throw new Error("Buy/sell tax harus 100–1000 bps (1–10%).");
    }
    const alloc = { creatorFunds: 10000, buybackBurn: 0, dividends: 0, liquidity: 0, ...(data.alloc || {}) };
    if (alloc.creatorFunds + alloc.buybackBurn + alloc.dividends + alloc.liquidity !== 10000) {
      throw new Error("Alokasi harus total 10000 bps (100%).");
    }

    const devBuy = data.devBuy && Number(data.devBuy) > 0 ? ethers.parseUnits(String(data.devBuy), 6) : 0n;
    const usdc = new ethers.Contract(C.usdc, ERC20_ABI, wallet);

    // saldo: native (18 des) == ERC-20 (6 des), satu dana untuk gas + dev buy
    const bal = await withRetry(() => provider.getBalance(wallet.address), { label: "getBalance" });
    const devBuy18 = devBuy * 10n ** 12n;
    if (bal < devBuy18) {
      throw new Error(`Saldo USDC kurang. Dev buy ${ethers.formatUnits(devBuy, 6)} USDC, ada ${ethers.formatUnits(bal, 18)} USDC.`);
    }

    // salts
    const tokenSalt = ethers.hexlify(ethers.randomBytes(32));
    await onStatus("⛏️ Mining hook salt (alamat hook Uniswap v4 wajib punya flag 0x2044)...");
    const mined = await mineHookSalt(rpc, wallet.address, tokenSalt, buyTax, sellTax, onStatus);
    await onStatus(`✅ Hook salt ketemu (${mined.tried} percobaan). Hook: ${mined.hook}`);

    // dividends > 0 → creator wajib terdaftar di registry (mode 1)
    if (alloc.dividends > 0 && !dryRun) {
      const reg = new ethers.Contract(CREATOR_REGISTRY, REGISTRY_ABI, provider);
      const cfg = await withRetry(() => reg.configFor(wallet.address), { label: "configFor" });
      if (cfg.mode === 0n) {
        await onStatus("📇 Daftarkan wallet ke registry dividends Argus (1 tx kecil)...");
        const rtx = await wallet.sendTransaction({ to: CREATOR_REGISTRY, data: SET_CONFIG_SELECTOR + coder.encode(["uint256", "uint256"], [1n, 0n]).slice(2) });
        await waitTx(rtx, { timeoutMs: 120_000, label: "Registrasi creator" });
      }
    }

    // approve USDC → Portal untuk dev buy (Portal tarik via transferFrom)
    if (devBuy > 0n && !dryRun) {
      const allowance = await withRetry(() => usdc.allowance(wallet.address, C.portal), { label: "allowance" });
      if (allowance < devBuy) {
        await onStatus(`🔏 Approve ${ethers.formatUnits(devBuy, 6)} USDC ke Portal...`);
        const atx = await usdc.approve(C.portal, devBuy);
        await waitTx(atx, { timeoutMs: 120_000, label: "Approve USDC" });
      }
    }

    const p1 = {
      name: data.name, symbol: data.symbol,
      totalSupply: C.totalSupply, startMcap: C.startMcap, bondMcap: C.bondMcap,
      buyTaxBps: buyTax, sellTaxBps: sellTax,
      creatorFundsBps: alloc.creatorFunds, buybackBurnBps: alloc.buybackBurn,
      dividendsBps: alloc.dividends, liquidityBps: alloc.liquidity,
      devBuyAmount: devBuy, quoteAsset: C.usdc, flag: C.launchFlag,
    };
    const p2 = {
      imageURI: data.logo || "",
      website: data.socials?.website || "",
      twitter: data.socials?.twitter || "",
      telegram: data.socials?.telegram || "",
      description: data.description || "",
    };
    const calldata = CREATE_SELECTOR + coder.encode(CREATE_TYPES, [p1, p2, tokenSalt, mined.hookSalt]).slice(2);

    // dryRun tanpa allowance cukup → simulasikan dengan devBuy 0 supaya tidak revert di transferFrom
    let simCalldata = calldata, simNote = "";
    if (dryRun && devBuy > 0n) {
      const allowance = await withRetry(() => usdc.allowance(wallet.address, C.portal), { label: "allowance" });
      if (allowance < devBuy) {
        simCalldata = CREATE_SELECTOR + coder.encode(CREATE_TYPES, [{ ...p1, devBuyAmount: 0n }, p2, tokenSalt, mined.hookSalt]).slice(2);
        simNote = "Simulasi tanpa dev buy (USDC belum di-approve; approve terjadi saat launch nyata). ";
      }
    }
    await onStatus("🔎 Simulasi createLaunch...");
    let predictedToken;
    try {
      const ret = await rpc("eth_call", [{ from: wallet.address, to: C.portal, data: simCalldata }, "latest"]);
      predictedToken = coder.decode(["address"], ret)[0];
    } catch (e) {
      throw new Error("Simulasi gagal: " + decodeRevert(e));
    }
    const gas = BigInt(await rpc("eth_estimateGas", [{ from: wallet.address, to: C.portal, data: simCalldata }]));
    const gasLimit = (gas * 120n) / 100n;
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.maxFeePerGas ?? feeData.gasPrice ?? 0n;
    const gasCost = gasLimit * gasPrice;
    if (bal < devBuy18 + gasCost) {
      const msg = `Saldo kurang untuk gas. Butuh ~${ethers.formatUnits(devBuy18 + gasCost, 18)} USDC, ada ${ethers.formatUnits(bal, 18)} USDC.`;
      if (!dryRun) throw new Error(msg);
      simNote += "⚠️ " + msg + " ";
    }

    const base = {
      token: predictedToken, hook: mined.hook, locker: "", splitter: "", poolId: "",
      tokensOut: ethers.formatEther(estimateDevBuy(devBuy, buyTax)),
      devBuy: ethers.formatUnits(devBuy, 6), fee: "0",
      gas: gas.toString(), gasCost: ethers.formatUnits(gasCost, 18), totalCost: ethers.formatUnits(devBuy18 + gasCost, 18),
      links: { token: `https://argus.world/token/${predictedToken}`, explorerToken: `${C.explorer}/token/${predictedToken}` },
    };
    if (dryRun) return { ...base, dryRun: true, note: simNote + "tokensOut = estimasi. Alamat token akan berbeda saat launch nyata (salt baru)." };

    await onStatus(`📤 Mengirim tx (gas ~${gas}, biaya gas ~${ethers.formatUnits(gasCost, 18)} USDC, dev buy ${ethers.formatUnits(devBuy, 6)} USDC)...`);
    const feeOpts = feeData.maxFeePerGas
      ? { maxFeePerGas: feeData.maxFeePerGas, maxPriorityFeePerGas: feeData.maxPriorityFeePerGas ?? 0n }
      : { gasPrice };
    const tx = await wallet.sendTransaction({ to: C.portal, data: calldata, gasLimit, ...feeOpts });
    await onStatus(`⏳ Tx terkirim: ${tx.hash}\nMenunggu konfirmasi...`);
    const receipt = await waitTx(tx, { label: "Launch" });

    // parse event Portal
    const portalLogs = receipt.logs.filter((l) => l.address.toLowerCase() === C.portal.toLowerCase());
    const created = portalLogs.find((l) => l.topics[0] === TOPIC_TOKEN_CREATED);
    const token = created ? ethers.getAddress("0x" + created.topics[1].slice(26)) : predictedToken;
    let poolId = "", hook = mined.hook, locker = "", splitter = "", tokensOut = 0n;
    if (created) {
      poolId = coder.decode(["string", "string", "bytes32", "string", "string", "string", "string"], created.data)[2];
    }
    const parts = portalLogs.find((l) => l.topics[0] === TOPIC_PARTS_DEPLOYED);
    if (parts) [locker, hook, splitter] = coder.decode(["address", "address", "address"], parts.data);
    const dev = portalLogs.find((l) => l.topics[0] === TOPIC_DEV_BUY);
    if (dev) tokensOut = coder.decode(["uint256", "uint256"], dev.data)[1];

    return {
      ...base,
      txHash: receipt.hash, token, hook, locker, splitter, poolId,
      tokensOut: ethers.formatEther(tokensOut), // riil dari event, bukan estimasi
      gas: receipt.gasUsed.toString(),
      note: created ? "" : "(event TokenCreated tidak ditemukan; alamat dari simulasi)",
      links: {
        tx: `${C.explorer}/tx/${receipt.hash}`,
        token: `https://argus.world/token/${token}`,
        explorerToken: `${C.explorer}/token/${token}`,
      },
    };
  },
};
