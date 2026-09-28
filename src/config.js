import 'dotenv/config';

function validateEnv() {
  const requiredVars = [
    'TELEGRAM_BOT_TOKEN',
    'ALLOWED_USER_IDS',
    'FUND_PK',
    'LAUNCH_PK',
    'RPC_URL',
    'CHAIN_ID',
    'PONS_FACTORY',
    'PONS_LAUNCH_FEE',
    'ARGUS_FACTORY',
    'ARGUS_LAUNCH_FEE',
    'FUND_AMOUNT',
    'MAX_ATTEMPTS',
    'RETRY_DELAY_MS',
    'GAS_PRICE_GWEI'
  ];

  for (const req of requiredVars) {
    if (!process.env[req]) {
      throw new Error(`Missing required environment variable: ${req}`);
    }
  }

  const isHex64 = (str) => /^0x[0-9a-fA-F]{64}$/.test(str);
  if (!isHex64(process.env.FUND_PK)) throw new Error('FUND_PK must be a valid 0x + 64 hex string');
  if (!isHex64(process.env.LAUNCH_PK)) throw new Error('LAUNCH_PK must be a valid 0x + 64 hex string');

  return {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    ALLOWED_USER_IDS: process.env.ALLOWED_USER_IDS.split(',').map(id => parseInt(id.trim(), 10)),
    FUND_PK: process.env.FUND_PK,
    LAUNCH_PK: process.env.LAUNCH_PK,
    RPC_URL: process.env.RPC_URL,
    CHAIN_ID: parseInt(process.env.CHAIN_ID, 10),
    PONS_FACTORY: process.env.PONS_FACTORY,
    PONS_LAUNCH_FEE: parseFloat(process.env.PONS_LAUNCH_FEE),
    ARGUS_FACTORY: process.env.ARGUS_FACTORY,
    ARGUS_LAUNCH_FEE: parseFloat(process.env.ARGUS_LAUNCH_FEE),
    FUND_AMOUNT: parseFloat(process.env.FUND_AMOUNT),
    MAX_ATTEMPTS: parseInt(process.env.MAX_ATTEMPTS, 10),
    RETRY_DELAY_MS: parseInt(process.env.RETRY_DELAY_MS, 10),
    GAS_PRICE_GWEI: parseFloat(process.env.GAS_PRICE_GWEI),
  };
}

const config = validateEnv();
export default config;
