import 'dotenv/config';

function validateEnv() {
  const token = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
  if (!token) throw new Error("Missing TELEGRAM_BOT_TOKEN / BOT_TOKEN");
}

export const config = {
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN,
  ALLOWED_USER_IDS: (process.env.ALLOWED_USER_IDS || '').split(',').map(id => parseInt(id.trim(), 10)).filter(id => !isNaN(id)),
  FUND_PK: process.env.FUND_PK || '0x0000000000000000000000000000000000000000000000000000000000000000',
  LAUNCH_PK: process.env.LAUNCH_PK || '0x0000000000000000000000000000000000000000000000000000000000000000',
  RPC_URL: process.env.RPC_URL || (process.env.PONS_RPC_URLS ? process.env.PONS_RPC_URLS.split(',')[0] : 'https://rpc.mainnet.chain.robinhood.com'),
  CHAIN_ID: process.env.CHAIN_ID ? parseInt(process.env.CHAIN_ID, 10) : 4663,
  PONS_FACTORY: process.env.PONS_FACTORY || '0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB',
  PONS_LAUNCH_FEE: process.env.PONS_LAUNCH_FEE ? parseFloat(process.env.PONS_LAUNCH_FEE) : 0.0005,
  ARGUS_FACTORY: process.env.ARGUS_FACTORY || '0x0000000000000000000000000000000000000000',
  ARGUS_LAUNCH_FEE: process.env.ARGUS_LAUNCH_FEE ? parseFloat(process.env.ARGUS_LAUNCH_FEE) : 0.0005,
  FUND_AMOUNT: process.env.FUND_AMOUNT ? parseFloat(process.env.FUND_AMOUNT) : 0.001,
  MAX_ATTEMPTS: process.env.MAX_ATTEMPTS ? parseInt(process.env.MAX_ATTEMPTS, 10) : 30,
  RETRY_DELAY_MS: process.env.RETRY_DELAY_MS ? parseInt(process.env.RETRY_DELAY_MS, 10) : 300,
  GAS_PRICE_GWEI: process.env.GAS_PRICE_GWEI ? parseFloat(process.env.GAS_PRICE_GWEI) : 2
};

import { createPublicClient, http } from 'viem';
export const robinhoodChain = {
  id: config.CHAIN_ID,
  name: 'Robinhood',
  network: 'robinhood',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [config.RPC_URL] }, public: { http: [config.RPC_URL] } }
};

export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(config.RPC_URL)
});

validateEnv();
