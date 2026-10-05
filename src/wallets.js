import { createPublicClient, createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { formatEther } from 'viem';
import { config } from './config.js';

export const robinhoodChain = defineChain({
  id: config.CHAIN_ID,
  name: 'Robinhood Chain',
  network: 'robinhood',
  nativeCurrency: { decimals: 18, name: 'ETH', symbol: 'ETH' },
  rpcUrls: { default: { http: [config.RPC_URL] }, public: { http: [config.RPC_URL] } },
});

export const publicClient = createPublicClient({
  chain: robinhoodChain,
  transport: http(config.RPC_URL),
});

export const fundAccount = privateKeyToAccount(config.FUND_PK);
export const launchAccount = privateKeyToAccount(config.LAUNCH_PK);

export const fundWallet = createWalletClient({
  account: fundAccount,
  chain: robinhoodChain,
  transport: http(config.RPC_URL),
});

export const launchWallet = createWalletClient({
  account: launchAccount,
  chain: robinhoodChain,
  transport: http(config.RPC_URL),
});

// Wallet dari PK yang dikirim user lewat chat (sesi). Fallback ke PK .env kalau kosong.
export function makeWallets(fundPk, launchPk) {
  const fAcc = fundPk ? privateKeyToAccount(fundPk) : fundAccount;
  const lAcc = launchPk ? privateKeyToAccount(launchPk) : launchAccount;
  const transport = http(config.RPC_URL);
  return {
    fundAccount: fAcc,
    launchAccount: lAcc,
    fundWallet: createWalletClient({ account: fAcc, chain: robinhoodChain, transport }),
    launchWallet: createWalletClient({ account: lAcc, chain: robinhoodChain, transport }),
  };
}

export async function getBalance(address) {
  const balance = await publicClient.getBalance({ address });
  return formatEther(balance);
}

export async function getNonce(address) {
  return await publicClient.getTransactionCount({ address });
}
