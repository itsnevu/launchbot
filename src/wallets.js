import { createPublicClient, createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { formatEther } from 'viem';
import config from './config.js';

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

export async function getBalance(address) {
  const balance = await publicClient.getBalance({ address });
  return formatEther(balance);
}

export async function getNonce(address) {
  return await publicClient.getTransactionCount({ address });
}
