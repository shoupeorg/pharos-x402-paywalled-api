export const CHAIN_ID = 688689;
export const NETWORK = "eip155:688689";
export const CHAIN_NAME = "Pharos Atlantic Testnet";
export const RPC_URL = "https://atlantic.dplabs-internal.com";
export const EXPLORER_URL = "https://atlantic.pharosscan.xyz";
export const PROTOCOL_VERSION = 2;
export const PAYMENT_SCHEME = "exact";
export const TOKEN_DECIMALS = 6;
// This must match the deployed token's EIP-712 domain exactly.
export const TOKEN_NAME = "USDC";
export const TOKEN_SYMBOL = "USDC";
export const ENDPOINTS = Object.freeze([
  { path: "/paid/network-snapshot", priceAtomic: "1000", label: "Paid Network Snapshot" },
  { path: "/paid/activity-summary", priceAtomic: "2000", label: "Paid Activity Summary" },
]);
export const RETRY_DELAYS_MS = Object.freeze([0, 250, 750]);
export const MAX_GAS_PER_SETTLEMENT = 160000n;
// Per-transaction ceiling authorized for the fresh public-HTTP Route A proof.
export const MAX_ADDITIONAL_GAS_SPEND_WEI = 300000000000000n;
export const MAX_GAS_TOTAL = 2000000n;
export const MAX_GAS_SPEND_WEI = 13900000000000000n;
