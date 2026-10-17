import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const expected = {
  facilitator: [process.env.FACILITATOR_PRIVATE_KEY, "0x87D11811655926EC18C49b936D52B80c64c68dE1"],
  buyer: [process.env.BUYER_PRIVATE_KEY, "0x29946933492Ca11744941Bc12630852498dAd8D7"],
  merchant: [process.env.MERCHANT_PRIVATE_KEY, "0x0913E25b83ee4367dEE8f9011E95351e60BF02d7"],
};
const checks = Object.fromEntries(Object.entries(expected).map(([name, [secret, address]]) => [name, Boolean(secret && getAddress(privateKeyToAccount(secret).address) === getAddress(address))]));
console.log(JSON.stringify({ checks, ownerTokenPresent: Boolean(process.env.OWNER_TOKEN), secretsPrinted: false }, null, 2));
if (!Object.values(checks).every(Boolean) || !process.env.OWNER_TOKEN) process.exitCode = 1;
