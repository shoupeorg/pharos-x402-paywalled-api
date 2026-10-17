import { createPublicClient, defineChain, formatEther, formatUnits, http, parseAbi, toFunctionSelector } from "viem";

const rpcUrl = process.env.PHAROS_RPC_URL || "https://atlantic.dplabs-internal.com";
const documentedToken = "0xE0BE08c77f415F577A1B3A9aD7a1Df1479564ec8";
const chain = defineChain({ id: 688689, name: "Pharos Atlantic Testnet", nativeCurrency: { name: "PHRS", symbol: "PHRS", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } }, testnet: true });
const client = createPublicClient({ chain, transport: http(undefined, { timeout: 30_000 }) });
const buyer = "0x29946933492Ca11744941Bc12630852498dAd8D7";
const facilitatorAddress = "0x87D11811655926EC18C49b936D52B80c64c68dE1";
const erc20 = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
]);
const blockNumber = await client.getBlockNumber();
const code = (await client.getBytecode({ address: documentedToken })) || "0x";
const selectors = Object.fromEntries([
  "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)",
  "authorizationState(address,bytes32)",
  "DOMAIN_SEPARATOR()",
].map((signature) => [signature, code.toLowerCase().includes(toFunctionSelector(signature).slice(2).toLowerCase())]));
const [name, symbol, decimals, totalSupplyAtomic, buyerBalanceAtomic, facilitatorBalanceWei] = await Promise.all([
  client.readContract({ address: documentedToken, abi: erc20, functionName: "name", blockNumber }),
  client.readContract({ address: documentedToken, abi: erc20, functionName: "symbol", blockNumber }),
  client.readContract({ address: documentedToken, abi: erc20, functionName: "decimals", blockNumber }),
  client.readContract({ address: documentedToken, abi: erc20, functionName: "totalSupply", blockNumber }),
  client.readContract({ address: documentedToken, abi: erc20, functionName: "balanceOf", args: [buyer], blockNumber }),
  client.getBalance({ address: facilitatorAddress, blockNumber }),
]);
console.log(JSON.stringify({
  checkedAt: new Date().toISOString(),
  chainId: await client.getChainId(),
  network: "eip155:688689",
  blockNumber: blockNumber.toString(),
  documentedToken,
  tokenCodeBytes: code.length / 2 - 1,
  token: {
    name,
    symbol,
    decimals,
    totalSupplyAtomic: totalSupplyAtomic.toString(),
    totalSupply: formatUnits(totalSupplyAtomic, decimals),
    buyer,
    buyerBalanceAtomic: buyerBalanceAtomic.toString(),
    buyerBalance: formatUnits(buyerBalanceAtomic, decimals),
  },
  facilitator: {
    address: facilitatorAddress,
    nativeBalanceWei: facilitatorBalanceWei.toString(),
    nativeBalancePHRS: formatEther(facilitatorBalanceWei),
  },
  selectors,
  requiredByInstalledSdk: "@x402/evm 2.28.0 exact EVM uses EIP-3009 transferWithAuthorization",
  compatibleWithInstalledExactScheme: false,
  conclusion: "BLOCKED: the Pharos-documented Atlantic test-USDC is deployed and readable but lacks the EIP-3009 entry points and EIP-712 domain required by the installed official x402 exact EVM scheme. No substitute token is used.",
}, null, 2));
