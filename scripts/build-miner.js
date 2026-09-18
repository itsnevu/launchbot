// Compile contracts/HookSaltMiner.sol → src/chains/hookSaltMiner.json ({ abi, runtime }).
// Butuh solc-js: npm i -D solc   (tidak dipasang default karena ~10 MB dan hanya perlu kalau .sol berubah)
// Jalankan: npm run build:miner        — tulis ulang json
//           npm run build:miner -- --check   — hanya bandingkan dengan json yang ada
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let solc;
try { solc = require("solc"); } catch { console.error("solc belum terpasang: npm i -D solc"); process.exit(2); }

const SRC = "contracts/HookSaltMiner.sol";
const OUT = "src/chains/hookSaltMiner.json";
const input = {
  language: "Solidity",
  sources: { [SRC]: { content: readFileSync(SRC, "utf8") } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true, // tanpa viaIR: "stack too deep"
    outputSelection: { "*": { Miner: ["abi", "evm.deployedBytecode.object"] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
if (errors.length) { for (const e of errors) console.error(e.formattedMessage); process.exit(1); }

const c = out.contracts[SRC].Miner;
const json = { abi: c.abi, runtime: "0x" + c.evm.deployedBytecode.object };
console.log(`solc ${solc.version()} → runtime ${(json.runtime.length - 2) / 2} byte`);

if (process.argv.includes("--check")) {
  const cur = JSON.parse(readFileSync(OUT, "utf8"));
  // bytecode bisa beda antar versi compiler (metadata hash di akhir) → bandingkan tanpa CBOR metadata trailer
  const strip = (h) => h.slice(0, -2 * (parseInt(h.slice(-4), 16) + 2));
  const same = strip(cur.runtime) === strip(json.runtime) && JSON.stringify(cur.abi) === JSON.stringify(json.abi);
  console.log(same ? "✅ hookSaltMiner.json sesuai dengan .sol" : "❌ hookSaltMiner.json BERBEDA dari hasil compile .sol (versi solc lain, atau .sol berubah)");
  process.exit(same ? 0 : 1);
}
writeFileSync(OUT, JSON.stringify(json));
console.log("ditulis:", OUT);
