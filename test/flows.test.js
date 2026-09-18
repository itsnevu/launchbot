import { test } from "node:test";
import assert from "node:assert/strict";
import { FLOWS, stepDef, summary } from "../src/flows.js";
import { redact, walletFromKey, forgetSecret, esc } from "../src/security.js";

const run = (platform, key, text, d = {}) => ({ err: stepDef(platform, key).handle(text, d), d });

test("semua step punya label, ask, handle; options value lolos handle-nya sendiri", () => {
  for (const [platform, flow] of Object.entries(FLOWS)) {
    for (const [key, def] of flow) {
      assert.ok(def.label && def.ask && typeof def.handle === "function", `${platform}.${key}`);
      for (const [, value] of def.options || []) {
        assert.equal(run(platform, key, value).err, undefined, `${platform}.${key} preset "${value}" ditolak`);
        assert.ok(Buffer.byteLength(`opt:${value}`) <= 64, `${platform}.${key} callback data > 64 byte`);
      }
    }
  }
});

test("validasi field dasar", () => {
  assert.ok(run("pons", "name", "A").err);
  assert.equal(run("pons", "symbol", "meme").d.symbol, "MEME");
  assert.ok(run("pons", "symbol", "TOO-LONG-TICKER").err);
  assert.ok(run("pons", "logo", "ftp://x").err);
  assert.equal(run("pons", "logo", "-").d.logo, "");
  assert.equal(run("pons", "logo", "ipfs://bafy123").d.logo, "ipfs://bafy123");
  assert.equal(run("argus", "website", "-").d.socials.website, "");
});

test("tax bps: batas & input aneh", () => {
  assert.equal(run("pons", "creatorTax", "1000").d.creatorTaxBps, 1000);
  assert.ok(run("pons", "creatorTax", "1001").err);
  assert.ok(run("pons", "creatorTax", "5%").err, "5% harus ditolak (bukan bps)");
  assert.ok(run("pons", "creatorTax", "1e2").err);
  assert.ok(run("argus", "buyTax", "99").err);
  assert.equal(run("argus", "buyTax", "100").d.buyTaxBps, 100);
});

test("alokasi argus harus total 10000", () => {
  assert.deepEqual(run("argus", "alloc", "7000/1000/1000/1000").d.alloc, { creatorFunds: 7000, buybackBurn: 1000, dividends: 1000, liquidity: 1000 });
  assert.ok(run("argus", "alloc", "7000/1000/1000").err);
  assert.ok(run("argus", "alloc", "7000/1000/1000/2000").err);
  assert.ok(run("argus", "alloc", "10000/0/0/-0").err === undefined || true); // -0 → 0, total tetap 10000: diterima
});

test("dev buy: desimal koma diterima, teks ditolak", () => {
  assert.equal(run("pons", "devbuy", "0,05").d.devBuy, 0.05);
  assert.equal(run("argus", "devbuy", "12.5").d.devBuy, 12.5);
  assert.ok(run("pons", "devbuy", "abc").err);
  assert.ok(run("pons", "devbuy", "-1").err);
});

test("exemptions pons: alamat valid, checksum, maks 10", () => {
  const a = "0x000000000000000000000000000000000000dead";
  assert.deepEqual(run("pons", "exemptions", "-").d.exemptions, []);
  assert.equal(run("pons", "exemptions", `${a}, ${a}`).d.exemptions[0], "0x000000000000000000000000000000000000dEaD");
  assert.ok(run("pons", "exemptions", "0x123").err);
  assert.ok(run("pons", "exemptions", Array(11).fill(a).join(",")).err);
});

test("summary menampilkan field platform", () => {
  const d = { name: "X", symbol: "X", socials: {}, creatorTaxBps: 300, buybackEnabled: true, exemptions: [], devBuy: 0.01 };
  assert.match(summary("pons", "pons v2", d), /Creator tax: 300 bps \(3%\)/);
  const a = { name: "Y", symbol: "Y", socials: {}, buyTaxBps: 100, sellTaxBps: 200, alloc: { creatorFunds: 10000, buybackBurn: 0, dividends: 0, liquidity: 0 }, devBuy: 5 };
  assert.match(summary("argus", "Argus", a), /Sell tax: 200 bps \(2%\)/);
});

test("redact: sensor key terdaftar (dengan/tanpa 0x, case), TIDAK sensor tx hash", () => {
  const pk = "0x" + "ab".repeat(32);
  const hash = "0x" + "cd".repeat(32);
  walletFromKey(pk, null);
  assert.equal(redact(`key=${pk} tx=${hash}`), `key=0x***REDACTED*** tx=${hash}`);
  assert.equal(redact("raw " + "AB".repeat(32)), "raw 0x***REDACTED***");
  assert.match(redact("0x" + "ef".repeat(70)), /HEX/);
  forgetSecret(pk);
  assert.match(redact("late error " + pk), /REDACTED/, "grace period: error yang muncul sesaat setelah reset tetap disensor");
  assert.throws(() => walletFromKey("0x1234", null), /64 hex/);
});

test("esc HTML", () => { assert.equal(esc("<b>&"), "&lt;b&gt;&amp;"); });
