import {
  createPublicClient,
  createWalletClient,
  decodeEventLog,
  defineChain,
  getAddress,
  http,
  publicActions,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CHAIN_ID, CHAIN_NAME, RPC_URL } from "./constants.js";

export const atlantic = defineChain({
  id: CHAIN_ID,
  name: CHAIN_NAME,
  nativeCurrency: { name: "PHRS", symbol: "PHRS", decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: "PharosScan", url: "https://atlantic.pharosscan.xyz" } },
  testnet: true,
});

export const tokenAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "version", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "totalSupply", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "account", type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "authorizationState", stateMutability: "view", inputs: [{ name: "authorizer", type: "address" }, { name: "nonce", type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "DOMAIN_SEPARATOR", stateMutability: "view", inputs: [], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "transferWithAuthorization", stateMutability: "nonpayable", inputs: [{ name: "from", type: "address" }, { name: "to", type: "address" }, { name: "value", type: "uint256" }, { name: "validAfter", type: "uint256" }, { name: "validBefore", type: "uint256" }, { name: "nonce", type: "bytes32" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }], outputs: [] },
  { type: "event", name: "Transfer", inputs: [{ indexed: true, name: "from", type: "address" }, { indexed: true, name: "to", type: "address" }, { indexed: false, name: "value", type: "uint256" }] },
  { type: "event", name: "AuthorizationUsed", inputs: [{ indexed: true, name: "authorizer", type: "address" }, { indexed: true, name: "nonce", type: "bytes32" }] },
];

export const publicClient = () => createPublicClient({ chain: atlantic, transport: http(undefined, { timeout: 25_000, retryCount: 1 }) });

export function walletClient(privateKey) {
  const account = privateKeyToAccount(privateKey);
  return createWalletClient({ account, chain: atlantic, transport: http(undefined, { timeout: 25_000, retryCount: 1 }) }).extend(publicActions);
}

export async function verifySettlementReceipt({ txHash, token, payer, merchant, amountAtomic }) {
  const client = publicClient();
  const receipt = await client.getTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error("Settlement receipt status is not success");
  if (getAddress(receipt.to) !== getAddress(token)) throw new Error("Settlement transaction target is not the payment token");
  let transfer = null;
  for (const log of receipt.logs) {
    if (getAddress(log.address) !== getAddress(token)) continue;
    try {
      const decoded = decodeEventLog({ abi: tokenAbi, data: log.data, topics: log.topics });
      if (decoded.eventName === "Transfer" && getAddress(decoded.args.from) === getAddress(payer) && getAddress(decoded.args.to) === getAddress(merchant) && decoded.args.value === BigInt(amountAtomic)) {
        transfer = { logIndex: Number(log.logIndex), from: decoded.args.from, to: decoded.args.to, value: decoded.args.value.toString() };
      }
    } catch { /* unrelated token log */ }
  }
  if (!transfer) throw new Error("Expected token Transfer event was not found in settlement receipt");
  return {
    status: "success",
    transactionHash: receipt.transactionHash,
    blockNumber: receipt.blockNumber.toString(),
    gasUsed: receipt.gasUsed.toString(),
    effectiveGasPrice: receipt.effectiveGasPrice.toString(),
    gasCostWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString(),
    token: getAddress(token),
    transfer,
  };
}

export async function readPaidResource(endpoint, snapshotBlock, env) {
  const client = publicClient();
  const blockNumber = BigInt(snapshotBlock);
  const block = await client.getBlock({ blockNumber, includeTransactions: false });
  if (endpoint === "/paid/network-snapshot") {
    if (block.baseFeePerGas == null) throw new Error("Pinned block does not expose a base fee");
    const [buyerNative, merchantNative, buyerToken, merchantToken] = await Promise.all([
      client.getBalance({ address: env.BUYER_ADDRESS, blockNumber }),
      client.getBalance({ address: env.MERCHANT_ADDRESS, blockNumber }),
      client.readContract({ address: env.PAYMENT_TOKEN, abi: tokenAbi, functionName: "balanceOf", args: [env.BUYER_ADDRESS], blockNumber }),
      client.readContract({ address: env.PAYMENT_TOKEN, abi: tokenAbi, functionName: "balanceOf", args: [env.MERCHANT_ADDRESS], blockNumber }),
    ]);
    return { kind: "LIVE_CHAIN_DATA", endpoint, chainId: CHAIN_ID, blockNumber: snapshotBlock, blockTimestamp: new Date(Number(block.timestamp) * 1000).toISOString(), baseFeePerGasWei: block.baseFeePerGas.toString(), buyerNativeWei: buyerNative.toString(), merchantNativeWei: merchantNative.toString(), buyerTokenAtomic: buyerToken.toString(), merchantTokenAtomic: merchantToken.toString(), fetchedAt: new Date().toISOString() };
  }
  const start = blockNumber > 2n ? blockNumber - 2n : 0n;
  const blocks = [];
  for (let current = start; current <= blockNumber; current += 1n) {
    const item = await client.getBlock({ blockNumber: current, includeTransactions: false });
    blocks.push({ blockNumber: current.toString(), transactionCount: item.transactions.length, gasUsed: item.gasUsed.toString(), timestamp: new Date(Number(item.timestamp) * 1000).toISOString() });
  }
  return { kind: "LIVE_CHAIN_DATA", endpoint, chainId: CHAIN_ID, snapshotBlock: snapshotBlock, windowStartBlock: start.toString(), blocks, totalTransactions: blocks.reduce((sum, item) => sum + item.transactionCount, 0), fetchedAt: new Date().toISOString() };
}
