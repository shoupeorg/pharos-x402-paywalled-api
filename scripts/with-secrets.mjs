import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const secretPath = path.resolve(root, "..", "local-secrets", "pharos-x402-paywalled-api.secrets.json");
if (!fs.existsSync(secretPath)) throw new Error("ACL-protected local secret bundle is missing");
const secrets = JSON.parse(fs.readFileSync(secretPath, "utf8"));
const [command, ...args] = process.argv.slice(2);
if (!command) throw new Error("Usage: node scripts/with-secrets.mjs <script> [args...]");
const child = spawnSync(process.execPath, [command, ...args], { cwd: root, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, ...secrets } });
process.exitCode = child.status ?? 1;
