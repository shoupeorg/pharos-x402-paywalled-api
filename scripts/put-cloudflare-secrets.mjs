import { spawnSync } from "node:child_process";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const expected = {
  FACILITATOR_PRIVATE_KEY: "0x87D11811655926EC18C49b936D52B80c64c68dE1",
  BUYER_PRIVATE_KEY: "0x29946933492Ca11744941Bc12630852498dAd8D7",
  MERCHANT_PRIVATE_KEY: "0x0913E25b83ee4367dEE8f9011E95351e60BF02d7",
};
for (const [name, address] of Object.entries(expected)) {
  if (!process.env[name] || getAddress(privateKeyToAccount(process.env[name]).address) !== getAddress(address)) throw new Error(`${name} does not derive to configured address`);
}
if (!process.env.OWNER_TOKEN || process.env.OWNER_TOKEN.length < 32) throw new Error("OWNER_TOKEN missing or too short");
for (const name of [...Object.keys(expected), "OWNER_TOKEN"]) {
  const result = spawnSync("npx.cmd", ["wrangler", "secret", "put", name], { input: process.env[name], encoding: "utf8", stdio: ["pipe", "inherit", "inherit"], shell: true });
  if (result.status !== 0) throw new Error(`Cloudflare secret upload failed for ${name}`);
}
console.log(JSON.stringify({ uploaded: [...Object.keys(expected), "OWNER_TOKEN"], identitiesVerifiedBeforeUpload: true, secretsPrinted: false }, null, 2));
