// Dry-run kedua platform tanpa dana: verifikasi RPC, gate, encoding, mining hook salt, simulasi launch.
// Jalankan: npm run check
import { ethers } from "ethers";
import { CFG } from "../src/config.js";
import { rawRpc } from "../src/rpc.js";

const coder = ethers.AbiCoder.defaultAbiCoder();
const w = ethers.Wallet.createRandom();
let fail = 0;
const ok = (m) => console.log("  ✅", m);
const bad = (m) => { fail++; console.log("  ❌", m); };

console.log("Wallet uji:", w.address);

// ---------- pons v2 ----------
console.log("\n[pons v2 / Robinhood Chain]");
try {
  const rpc = rawRpc(CFG.pons.rpcUrls);
  const chainId = parseInt(await rpc("eth_chainId", []));
  chainId === CFG.pons.chainId ? ok(`chainId ${chainId}`) : bad(`chainId ${chainId} != ${CFG.pons.chainId}`);
  const { pons } = await import("../src/chains/pons.js");
  const provider = pons.provider();
  const f = new ethers.Contract(CFG.pons.factory, [
    "function launchFee() view returns (uint256)", "function launchEnabled() view returns (bool)",
    "function canLaunch(address) view returns (bool)", "function previewLaunchEconomics(uint256,address) view returns (bytes32)",
  ], provider);
  const [fee, en, can, econ] = await Promise.all([f.launchFee(), f.launchEnabled(), f.canLaunch(w.address), f.previewLaunchEconomics(0, ethers.ZeroAddress)]);
  ok(`launchFee ${ethers.formatEther(fee)} ETH, launchEnabled ${en}, canLaunch ${can}, economics ${econ.slice(0, 10)}…`);
  const ri = new ethers.Interface(["function launchAndBuy((string,string,string,string,(string,string,string,string,string),address,uint16,bool,bytes32,bytes32),uint256,address,uint256,uint256,address,address[]) payable returns (address,address,uint256)"]);
  const params = ["Dry", "DRY", "", "", ["", "", "", "", ""], w.address, 100, false, econ, ethers.hexlify(ethers.randomBytes(32))];
  const quoteIn = ethers.parseEther("0.01");
  const data = ri.encodeFunctionData("launchAndBuy", [params, 0, ethers.ZeroAddress, quoteIn, 0, w.address, []]);
  const over = { [w.address]: { balance: "0x56bc75e2d63100000" } };
  const r = await rpc("eth_call", [{ from: w.address, to: CFG.pons.router, data, value: ethers.toBeHex(fee + quoteIn) }, "latest", over]);
  const [token, curve, out] = ri.decodeFunctionResult("launchAndBuy", r);
  ok(`dry-run launchAndBuy: token ${token} curve ${curve} tokensOut ${ethers.formatEther(out)} untuk 0.01 ETH`);
  const gas = parseInt(await rpc("eth_estimateGas", [{ from: w.address, to: CFG.pons.router, data, value: ethers.toBeHex(fee + quoteIn) }, "latest", over]));
  const gp = BigInt(await rpc("eth_gasPrice", []));
  ok(`gas ~${gas} @ ${ethers.formatUnits(gp, "gwei")} gwei ≈ ${ethers.formatEther(BigInt(gas) * gp)} ETH`);
} catch (e) { bad("pons: " + (e.shortMessage || e.message)); }

// ---------- Argus ----------
console.log("\n[Argus / Arc]");
try {
  const rpc = rawRpc(CFG.argus.rpcUrls);
  const chainId = parseInt(await rpc("eth_chainId", []));
  chainId === CFG.argus.chainId ? ok(`chainId ${chainId}`) : bad(`chainId ${chainId} != ${CFG.argus.chainId}`);
  const code = await rpc("eth_getCode", [CFG.argus.portal, "latest"]);
  code.includes("11b8f0f1") && code.includes("3ae04f1d") ? ok("Portal #7 punya selector createLaunch (0x11b8f0f1) & predict (0x3ae04f1d)") : bad("selector Portal tidak ditemukan — Portal berubah?");
  const p = new ethers.Contract(CFG.argus.portal, ["function tokenCount() view returns (uint256)", "function MAX_TAX_BPS() view returns (uint256)", "function defaultQuoteAsset() view returns (address)"], (await import("../src/chains/argus.js")).argus.provider());
  ok(`tokenCount ${await p.tokenCount()}, MAX_TAX_BPS ${await p.MAX_TAX_BPS()}, defaultQuote ${await p.defaultQuoteAsset()}`);

  // mining via modul asli (fungsi internal tidak diekspor → panggil predict langsung sebagai smoke test + miner state-override)
  const { createRequire } = await import("node:module");
  const MINER = createRequire(import.meta.url)("../src/chains/hookSaltMiner.json");
  const iface = new ethers.Interface(MINER.abi);
  const MINER_ADDR = "0x00000000000000000000000000000000000a4b1e";
  const tokenSalt = ethers.hexlify(ethers.randomBytes(32));
  const t0 = Date.now(); let found = null, tried = 0;
  while (!found && Date.now() - t0 < 60_000) {
    const jobs = Array.from({ length: 6 }, () => rpc("eth_call", [{ to: MINER_ADDR, data: iface.encodeFunctionData("mine", [CFG.argus.portal, w.address, tokenSalt, ethers.hexlify(ethers.randomBytes(32)), 300, 300, CFG.argus.usdc, 900]), gas: "0x1c9c380" }, "latest", { [MINER_ADDR]: { code: MINER.runtime } }], { tries: 1 }).then((r) => iface.decodeFunctionResult("mine", r)).catch(() => null));
    for (const r of await Promise.all(jobs)) if (r) { tried += Number(r.tried); if (r.found && !found) found = r; }
  }
  found ? ok(`mining hook salt: ${tried} percobaan, ${Date.now() - t0} ms → hook ${found.hook}`) : bad("mining hook salt gagal (state override tidak didukung?)");

  if (found) {
    const types = [
      "tuple(string,string,uint256,uint256,uint256,uint16,uint16,uint16,uint16,uint16,uint16,uint256,address,uint256)",
      "tuple(string,string,string,string,string)", "bytes32", "bytes32",
    ];
    const A = CFG.argus;
    const data = "0x11b8f0f1" + coder.encode(types, [
      ["Dry", "DRY", A.totalSupply, A.startMcap, A.bondMcap, 300, 300, 10000, 0, 0, 0, 0n, A.usdc, A.launchFlag],
      ["ipfs://x", "", "", "", "dry run"], tokenSalt, found.salt,
    ]).slice(2);
    const r = await rpc("eth_call", [{ from: w.address, to: A.portal, data }, "latest"]);
    ok(`dry-run createLaunch (devBuy 0): token ${coder.decode(["address"], r)[0]}`);
    const gas = parseInt(await rpc("eth_estimateGas", [{ from: w.address, to: A.portal, data }]));
    const gp = BigInt(await rpc("eth_gasPrice", []));
    ok(`gas ~${gas} @ ${ethers.formatUnits(gp, "gwei")} gwei ≈ ${ethers.formatUnits(BigInt(gas) * gp, 18)} USDC`);
  }
} catch (e) { bad("argus: " + (e.shortMessage || e.message)); }

console.log(fail ? `\n${fail} check gagal.` : "\nSemua check OK.");
process.exit(fail ? 1 : 0);
