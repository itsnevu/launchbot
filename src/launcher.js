import { parseEther, parseGwei } from 'viem';
import config from './config.js';
import { publicClient, fundWallet, launchWallet, fundAccount, launchAccount, getNonce, getBalance } from './wallets.js';
import { buildLaunchTx, parseTokenLaunched } from './pons.js';

let isRetrying = false;
export let lastStatus = { attempt: 0, fundTx: null, launchTx: null, status: 'idle', error: null };

export function stopRetry() {
  isRetrying = false;
  lastStatus.status = 'stopped';
}

export async function attemptLaunch(tokenConfig) {
  try {
    const launchType = tokenConfig.launchType || 'pons_biasa';
    const isBundling = launchType === 'bundling';
    
    // Untuk bundling, default pakai fee PONS
    const feeConfig = launchType === 'argus_arc' ? config.ARGUS_LAUNCH_FEE : config.PONS_LAUNCH_FEE;
    
    const launchBalance = await getBalance(launchAccount.address);
    const gasBufferStr = "0.001"; // Safety buffer dinaikkan jadi 0.001 ETH untuk eksekusi yang lebih aman
    
    const requiredBalance = parseEther(feeConfig.toString()) + parseEther(gasBufferStr);
    const currentBalance = parseEther(launchBalance);
    
    let fundTxHash = null;
    let launchNonce = await getNonce(launchAccount.address);
    let promises = [];

    const gasPriceFund = parseGwei(config.GAS_PRICE_GWEI.toString());
    const gasPriceLaunch = parseGwei((config.GAS_PRICE_GWEI + 1).toString());

    if (isBundling && currentBalance < requiredBalance) {
      // Saldo kurang, butuh funding
      const fundNonce = await getNonce(fundAccount.address);
      
      const fundRequest = await fundWallet.prepareTransactionRequest({
        to: launchAccount.address,
        value: parseEther(config.FUND_AMOUNT.toString()),
        nonce: fundNonce,
        gasPrice: gasPriceFund,
        chain: fundWallet.chain
      });
      
      const signedFundTx = await fundWallet.signTransaction(fundRequest);
      
      promises.push((async () => {
        fundTxHash = await publicClient.sendRawTransaction({ serializedTransaction: signedFundTx });
        return fundTxHash;
      })());
      
      // Karena kita mendanai di blok ini, kita asumsi launch tx akan menggunakan nonce saat ini
      // launchNonce tetap sama karena tx funding belum dikonfirmasi, saldo akan cukup saat ditambang
    } else if (!isBundling && currentBalance < requiredBalance) {
      throw new Error(`Saldo Launch Wallet kurang. Butuh ${feeConfig} ETH + gas buffer.`);
    }

    const launchTxData = buildLaunchTx(
      launchType,
      tokenConfig.name, 
      tokenConfig.symbol, 
      tokenConfig.imageUrl, 
      tokenConfig.description, 
      tokenConfig.feeWallet
    );

    const launchRequest = await launchWallet.prepareTransactionRequest({
      to: launchTxData.to,
      data: launchTxData.data,
      value: launchTxData.value,
      nonce: launchNonce,
      gasPrice: gasPriceLaunch,
      chain: launchWallet.chain,
      gas: 800000n // Limit gas diset lebih tinggi (800K) untuk menghindari Revert out of gas
    });

    const signedLaunchTx = await launchWallet.signTransaction(launchRequest);

    promises.push((async () => {
      const hash = await publicClient.sendRawTransaction({ serializedTransaction: signedLaunchTx });
      return hash;
    })());

    // Kirim hampir bersamaan
    const results = await Promise.allSettled(promises);
    
    const fundResult = promises.length === 2 ? results[0] : null;
    const launchResult = promises.length === 2 ? results[1] : results[0];

    if (launchResult.status === 'rejected') {
      const errMsg = launchResult.reason.message || launchResult.reason;
      let note = '';
      if (errMsg.toLowerCase().includes('nonce') || errMsg.toLowerCase().includes('underpriced') || errMsg.toLowerCase().includes('replacement')) {
        note = ' (Kalah cepat di mempool / Gas ditimpa)';
      }
      throw new Error(`Broadcast Gagal${note}: ${errMsg}`);
    }

    const launchTxHash = launchResult.value;
    const fundHashFinal = fundResult && fundResult.status === 'fulfilled' ? fundResult.value : null;

    // Tunggu receipt
    const receipt = await publicClient.waitForTransactionReceipt({ hash: launchTxHash, timeout: 60000 });

    if (receipt.status === 'success') {
      const tokenAddress = parseTokenLaunched(receipt, launchType);
      return { success: true, txHash: launchTxHash, fundTxHash: fundHashFinal, tokenAddress, blockNumber: receipt.blockNumber.toString() };
    } else {
      const errorMsg = isBundling ? 'Gagal: Transaksi Revert (Kemungkinan disalip / kalah cepat di block)' : 'Gagal: Transaksi Revert';
      return { success: false, txHash: launchTxHash, fundTxHash: fundHashFinal, blockNumber: receipt.blockNumber.toString(), error: errorMsg };
    }

  } catch (error) {
    const errorMsg = error.message || error;
    if (errorMsg.includes('insufficient funds')) {
      return { success: false, error: 'Gagal: Kalah cepat (Saldo belum masuk / Gas kurang)' };
    }
    return { success: false, error: errorMsg };
  }
}

export async function runWithRetry(tokenConfig, onUpdate) {
  isRetrying = true;
  lastStatus = { attempt: 0, fundTx: null, launchTx: null, status: 'running', error: null };

  for (let i = 1; i <= config.MAX_ATTEMPTS; i++) {
    if (!isRetrying) break;

    lastStatus.attempt = i;
    lastStatus.status = 'pending...';
    if(onUpdate) onUpdate(lastStatus);

    const result = await attemptLaunch(tokenConfig);

    lastStatus.fundTx = result.fundTxHash || lastStatus.fundTx;
    lastStatus.launchTx = result.txHash || lastStatus.launchTx;
    lastStatus.blockNumber = result.blockNumber;

    if (result.success) {
      lastStatus.status = 'success';
      lastStatus.tokenAddress = result.tokenAddress;
      isRetrying = false;
      if(onUpdate) onUpdate(lastStatus);
      return result;
    } else {
      lastStatus.status = 'failed';
      lastStatus.error = result.error;
      if(onUpdate) onUpdate(lastStatus);

      if (i < config.MAX_ATTEMPTS && isRetrying) {
        await new Promise(res => setTimeout(res, config.RETRY_DELAY_MS));
      }
    }
  }

  isRetrying = false;
  return { success: false, error: 'Max attempts reached' };
}
