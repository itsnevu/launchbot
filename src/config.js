import "dotenv/config";

const list = (s) => (s || "").split(",").map((x) => x.trim()).filter(Boolean);

export const CFG = {
  botToken: process.env.BOT_TOKEN,
  allowedUserIds: list(process.env.ALLOWED_USER_IDS),
  slippageBps: BigInt(process.env.SLIPPAGE_BPS || "300"),
  dnsPins: Object.fromEntries(list(process.env.DNS_PINS).map((kv) => kv.split("=").map((x) => x.trim()))),
  // Sesi idle (private key di memori) dihapus otomatis setelah N menit. 0 = tidak pernah (tidak disarankan).
  sessionTtlMs: Number(process.env.SESSION_TTL_MIN || "10") * 60_000,
  historyFile: process.env.HISTORY_FILE || "launches.jsonl",
  pinataJwt: process.env.PINATA_JWT || "", // opsional: upload logo dari foto Telegram ke IPFS

  pons: {
    chainId: 4663,
    rpcUrls: list(process.env.PONS_RPC_URLS || "https://rpc.mainnet.chain.robinhood.com"),
    factory: process.env.PONS_FACTORY || "0x7eD598BcEf8bd9Edd8C97A195C6d13f40801EC7e",
    router: process.env.PONS_ROUTER || "0xe33E9E479dF8802cb0866d5d05258bEc4cF62948",
    launchConfigId: 0n,
    pairToken: "0x0000000000000000000000000000000000000000", // native ETH (default)
    // Pair ERC-20 yang disetujui factory (approvedPairTokens) — preset tombol; alamat lain bisa diketik & dicek on-chain.
    pairPresets: [["USDG", "0x5fc5360d0400a0fd4f2af552add042d716f1d168"], ["cbBTC", "0xcec185eb182c47d1ba1efc84e6959e18cd620be4"], ["NVDA", "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec"]],
    explorer: "https://robinhoodchain.blockscout.com",
    maxCreatorTaxBps: 1000,
    // Escrow fee creator (curve.feeEscrow()): curve.sweepFees() → escrow.credit(creator) → escrow.claim() oleh creator.
    feeEscrow: "0xd3afeb2a57f70ef218aa82451c51b2fb0416ac9e",
  },

  argus: {
    chainId: 5042,
    rpcUrls: list(
      process.env.ARC_RPC_URLS ||
        "https://rpc.mainnet.arc.io,https://rpc.drpc.mainnet.arc.io,https://rpc.blockdaemon.mainnet.arc.io"
    ),
    portal: process.env.ARGUS_PORTAL || "0xB021Be536808f551b31789422Fd28a6c9c6e97Da",
    usdc: "0x3600000000000000000000000000000000000000", // 6 desimal; saldo native == saldo ERC-20
    explorer: "https://arc-scan.io",
    // Diverifikasi on-chain 2026-09-17 dari 40+ tx launch Portal #7:
    totalSupply: 1_000_000_000n * 10n ** 18n,
    startMcap: 2_500_000_000n,   // 2.500 USDC (6 desimal)
    bondMcap: 45_000_000_000n,   // 45.000 USDC
    maxTaxBps: 1000,
    // Flag terakhir di struct launch. Selalu 1 di semua tx yang diamati.
    launchFlag: 1n,
    // Quote alternatif: ARGUS (18 des). startMcap/bondMcap dalam ARGUS = 2500 / 45000 USDC dibagi harga ARGUS
    // (frontend memakai harga live; Portal tidak memvalidasi). Harga dibaca dari pool Uniswap v4 USDC/ARGUS via StateView.
    argusToken: "0xece5ca8bf9220718e5727754026757512212cb3c",
    poolManager: "0x8366a39CC670B4001A1121B8F6A443A643e40951",
    stateView: "0xF3334192D15450CdD385c8B70e03f9A6bD9E673b",
    // PoolKey USDC/ARGUS dengan likuiditas terbesar (2026-09-19). Override: ARGUS_PRICE_POOL=fee,tickSpacing,hook
    pricePool: (process.env.ARGUS_PRICE_POOL || "9850,99,0x0000000000000000000000000000000000000000").split(",").map((x) => x.trim()),
    // Router swap yang dipakai frontend argus.world (selector 0x4d819a2a, layout direkonstruksi dari tx nyata).
    swapRouter: "0x53dea4f7783c1de84cecc5c989bc37a557154827",
  },
};
