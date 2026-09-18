import dns from "node:dns";
import { ethers } from "ethers";
import { CFG } from "./config.js";

// --- DNS pin: bypass DNS hijack ISP (mis. rpc.mainnet.chain.robinhood.com dibelokkan TrustPositif) ---
const origLookup = dns.lookup;
dns.lookup = function (host, opts, cb) {
  if (typeof opts === "function") { cb = opts; opts = {}; }
  const ip = CFG.dnsPins[host];
  if (ip) {
    const fam = ip.includes(":") ? 6 : 4;
    return opts?.all ? cb(null, [{ address: ip, family: fam }]) : cb(null, ip, fam);
  }
  return origLookup.call(dns, host, opts, cb);
};

// Raw JSON-RPC dengan fallback antar endpoint + retry. Dipakai untuk eth_call state-override,
// batch, dll yang tidak dibungkus ethers.
export function rawRpc(urls) {
  return async function call(method, params, { tries = 3, timeoutMs = 30_000 } = {}) {
    let lastErr;
    for (let t = 0; t < tries; t++) {
      for (const url of urls) {
        try {
          const ac = new AbortController();
          const timer = setTimeout(() => ac.abort(), timeoutMs);
          const res = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
            signal: ac.signal,
          }).finally(() => clearTimeout(timer));
          const j = await res.json();
          if (j.error) {
            // error eksekusi (revert) bukan masalah endpoint → jangan retry
            if (j.error.code === 3 || /revert/i.test(j.error.message || "")) {
              const err = new Error(j.error.message); err.data = j.error.data; err.code = j.error.code; throw err;
            }
            throw Object.assign(new Error(j.error.message), { transient: true });
          }
          return j.result;
        } catch (e) {
          if (e.code === 3 || (!e.transient && /revert/i.test(e.message))) throw e;
          lastErr = e;
        }
      }
      await new Promise((r) => setTimeout(r, 500 * (t + 1)));
    }
    throw new Error("RPC gagal di semua endpoint: " + (lastErr?.message || lastErr));
  };
}

export function makeProvider(chain) {
  const net = ethers.Network.from(chain.chainId);
  const opts = { staticNetwork: net, batchMaxCount: 1 };
  if (chain.rpcUrls.length === 1) return new ethers.JsonRpcProvider(chain.rpcUrls[0], net, opts);
  return new ethers.FallbackProvider(
    chain.rpcUrls.map((url, i) => ({ provider: new ethers.JsonRpcProvider(url, net, opts), priority: i + 1, stallTimeout: 2000, weight: 1 })),
    net,
    { quorum: 1 }
  );
}

// Retry generik untuk hiccup RPC (bukan revert).
export async function withRetry(fn, { tries = 3, label = "rpc" } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (e) {
      const msg = String(e?.shortMessage || e?.message || e);
      if (e?.code === "CALL_EXCEPTION" || /revert|insufficient funds|nonce/i.test(msg)) throw e;
      last = e; await new Promise((r) => setTimeout(r, 700 * (i + 1)));
    }
  }
  throw new Error(`${label}: ${last?.shortMessage || last?.message || last}`);
}

// Tunggu receipt. Timeout ≠ gagal: tx mungkin masih pending/mining → lempar error dengan e.pending = true
// supaya bot menampilkan hash + link explorer, bukan "❌ Error". Revert (status 0) tetap error biasa.
export async function waitTx(tx, { timeoutMs = 180_000, label = "Transaksi" } = {}) {
  let receipt;
  try {
    receipt = await tx.wait(1, timeoutMs);
  } catch (e) {
    if (e?.code === "TIMEOUT") {
      const err = new Error(`${label} belum terkonfirmasi dalam ${Math.round(timeoutMs / 1000)} dtk. Cek explorer: ${tx.hash}`);
      err.pending = true; err.hash = tx.hash;
      throw err;
    }
    throw e;
  }
  if (!receipt || receipt.status !== 1) throw new Error(`${label} revert. Tx: ${tx.hash}`);
  return receipt;
}
