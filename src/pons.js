import { encodeFunctionData, parseEther, parseAbiItem, decodeEventLog } from 'viem';
import { config } from './config.js';
import { publicClient, launchAccount } from './wallets.js';

// ABI untuk fungsi launch Argus (ARC). Sesuaikan jika berbeda dengan Pons
const ARGUS_FACTORY_ABI = [
  {
    "inputs": [
      { "internalType": "string", "name": "name", "type": "string" },
      { "internalType": "string", "name": "symbol", "type": "string" },
      { "internalType": "string", "name": "imageUrl", "type": "string" },
      { "internalType": "string", "name": "description", "type": "string" },
      { "internalType": "address", "name": "feeWallet", "type": "address" }
    ],
    "name": "launchToken",
    "outputs": [],
    "stateMutability": "payable",
    "type": "function"
  }
];

// ABI fungsi launch (Mohon verifikasi nama fungsi dan parameternya di blockscout)
const PONS_FACTORY_ABI = [
  {
    "inputs": [
      { "internalType": "string", "name": "name", "type": "string" },
      { "internalType": "string", "name": "symbol", "type": "string" },
      { "internalType": "string", "name": "imageUrl", "type": "string" },
      { "internalType": "string", "name": "description", "type": "string" },
      { "internalType": "address", "name": "feeWallet", "type": "address" }
    ],
    "name": "launchToken", // USER: Sesuaikan dengan nama fungsi aslinya
    "outputs": [],
    "stateMutability": "payable",
    "type": "function"
  }
];

const TOKEN_LAUNCHED_EVENT_ABI = parseAbiItem(
  "event TokenLaunched(address indexed token, address indexed deployer, address indexed dexFactory, address pairToken, address pool, uint256 dexId, uint256 launchConfigId, uint256 positionId, uint256 restrictionsEndBlock, uint256 initialBuyAmount)"
);

export function getFactoryData(launchType) {
  if (launchType === 'argus_arc') {
    return { address: config.ARGUS_FACTORY, abi: ARGUS_FACTORY_ABI, fee: config.ARGUS_LAUNCH_FEE };
  }
  return { address: config.PONS_FACTORY, abi: PONS_FACTORY_ABI, fee: config.PONS_LAUNCH_FEE };
}

export function buildLaunchTx(launchType, name, symbol, imageUrl, description, feeWallet, initialBuyEth = 0) {
  const factory = getFactoryData(launchType);
  
  const data = encodeFunctionData({
    abi: factory.abi,
    functionName: 'launchToken',
    args: [name, symbol, imageUrl, description, feeWallet]
  });

  const totalValue = parseEther(factory.fee.toString()) + parseEther(initialBuyEth.toString());
  return {
    to: factory.address,
    data,
    value: totalValue
  };
}

export async function simulateLaunch(name, symbol, imageUrl, description, feeWallet) {
  try {
    const tx = buildLaunchTx(name, symbol, imageUrl, description, feeWallet);
    const { request } = await publicClient.simulateContract({
      address: tx.to,
      abi: PONS_FACTORY_ABI,
      functionName: 'launchToken', // USER: Sesuaikan
      args: [name, symbol, imageUrl, description, feeWallet],
      account: launchAccount,
      value: tx.value
    });
    return { success: true, request };
  } catch (error) {
    return { success: false, error: error.message || error };
  }
}

export function parseTokenLaunched(receipt, launchType) {
  const factory = getFactoryData(launchType);

  try {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() === factory.address.toLowerCase()) {
        try {
          const decoded = decodeEventLog({ 
            abi: [TOKEN_LAUNCHED_EVENT_ABI], 
            data: log.data, 
            topics: log.topics 
          });
          
          if (decoded.eventName === 'TokenLaunched') {
            return decoded.args.token;
          }
        } catch (err) {
          // Abaikan jika bukan event TokenLaunched
        }
      }
    }
    return null;
  } catch (e) {
    console.error("Error parsing TokenLaunched:", e);
    return null;
  }
}
