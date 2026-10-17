# Pharos x402 Paywalled API

A separate Atlantic Testnet x402 v2 seller, self-hosted facilitator, HTTP client, CLI, installable Skill, D1 evidence store, and retro review UI.

> **Foundation status: BLOCKED.** The test-USDC address documented by Pharos is deployed and readable, but it does not expose the EIP-3009 functions required by `@x402/evm` 2.28.0's `exact` scheme. This repository does not substitute PXUSD, another token, another network, or a mock payment. New settlement is disabled with `PAYMENT_OPERATIONAL=false`; no successful paid flow is claimed.

## Verified foundation

Official sources:

- [Pharos x402 developer guide](https://docs.pharos.xyz/developer-guide/x402)
- [Pharos Atlantic x402 guide](https://docs.pharos.xyz/developer-guide/x402/x402-atlantic-testnet)
- [Atlantic network settings](https://docs.pharos.xyz/getting-started/network/atlantic-testnet)
- [Official Pharos x402 Skill](https://github.com/PharosNetwork/examples/tree/main/skills/x402-pharos)
- [Coinbase x402](https://github.com/coinbase/x402)

Read-only verification at block `31541369` on 2026-10-17:

| Item | Verified value |
| --- | --- |
| Network | `eip155:688689` — Pharos Atlantic Testnet |
| RPC | `https://atlantic.dplabs-internal.com` |
| Documented test-USDC | `0xE0BE08c77f415F577A1B3A9aD7a1Df1479564ec8` |
| Contract | `USD Coin` / `USDC`, 6 decimals, 6,005 byte runtime code |
| SDK | locked `@x402/core`, `@x402/evm`, `@x402/fetch`, `@x402/hono` 2.28.0 |
| SDK transfer mechanism | EIP-3009 `transferWithAuthorization` |
| Contract compatibility | `transferWithAuthorization`: absent; `authorizationState`: absent; `DOMAIN_SEPARATOR`: absent |

The Pharos page itself labels this test-USDC address as not official. The raw reproducible output is [evidence/foundation-verification.json](evidence/foundation-verification.json); run `npm run probe:foundation` to repeat it. Selector absence is corroborated by failed authoritative contract calls in the Worker config probe. Because no EIP-712 domain exists, the project does not invent a domain name/version and present a signature as settleable.

The dedicated buyer and facilitator are currently unfunded (`0 USDC`, `0 PHRS` at the recorded block). Funding them would not fix the contract incompatibility, so no funding is requested yet.

## Routes and exact prices

| Route | Price | State |
| --- | ---: | --- |
| `GET /health` | free | operational, no payment header |
| `GET /paid/network-snapshot?block=N` | 1,000 atomic = `0.001 USDC` | returns x402 v2 HTTP 402; settlement blocked by foundation |
| `GET /paid/activity-summary?block=N` | 2,000 atomic = `0.002 USDC` | returns x402 v2 HTTP 402; settlement blocked by foundation |

Money is stored and compared as decimal strings/`BigInt`; JavaScript floating point is never used for payment accounting.

The intended paid response reads Atlantic at the pinned block. Route A reports network/base-fee and buyer/merchant balances; Route B summarizes the pinned block and two preceding blocks. Data is released only after a successful receipt and exact token `Transfer`, or recovery of the exact already-settled authorization.

## Facilitator and HTTP flow

This Worker exposes:

- `GET /supported` — x402 SDK-supported capabilities plus the current compatibility blocker and route/asset allowlist.
- `POST /verify` — SDK verification after strict route, origin, network, scheme, asset, merchant, and amount allowlisting; read-only.
- `POST /settle` — owner-authenticated, allowlisted SDK settlement. It returns `503` while `PAYMENT_OPERATIONAL=false` so the incompatible contract cannot consume gas.

The seller calls its public `PUBLIC_ORIGIN/verify` and `/settle` endpoints over HTTP through `src/facilitator-http.js`; it does not bypass them with an internal facilitator call. For a compatible token, the SDK validates the EIP-3009 signature/authorization, expiry, and settlement. `simulateInSettle`, per-transaction gas ceiling `160000`, total gas ceiling `2000000`, exact route allowlisting, D1 idempotency, and owner authentication constrain settlement.

The deployed negative demos make real HTTP requests to the public paid URL:

1. no `PAYMENT-SIGNATURE` → HTTP 402 and an actual `PAYMENT-REQUIRED` header;
2. malformed header → HTTP 402;
3. an SDK-generated, correctly signed authorization for one atomic unit below the route price → HTTP 402 before the seller/facilitator;
4. `/health` → HTTP 200 without payment.

These records are persisted in D1 with status, safe headers, decoded requirements, zero debit, and no settlement hash. Full reusable signatures and private keys are never stored in evidence.

## Durability and recovery

`BuyerCoordinator` and `SellerCoordinator` use explicit serial executors. D1 adds conditional reservations, unique authorization identities, settlement claims, and durable states across process restarts. Concurrent reservations cannot exceed the global budget. Concurrent duplicates share one authorization and one settlement claim.

Retries use delays `0/250/750 ms` and the same persisted authorization. An ambiguous response retains the reservation. Recovery consults `authorizationState` and `AuthorizationUsed` in 1,000-block log windows; it never creates a replacement payment for stale data. Chain block time—not Worker wall time—controls authorization expiry. A settled response and its original pinned resource can be recovered after the normal 1,000-block quote window. If reconciliation is inconclusive, state remains `PENDING_RECONCILIATION`.

## Install and CLI

Requirements: Node.js 20+.

```bash
git clone https://github.com/shoupeorg/pharos-x402-paywalled-api.git
cd pharos-x402-paywalled-api
npm ci
npm test
npm run build
```

Safe CLI commands:

```bash
npm run cli -- status
npm run cli -- health
npm run cli -- challenge /paid/network-snapshot
npm run cli -- demo free
npm run cli -- demo missing
npm run cli -- demo invalid
npm run cli -- demo underpayment
npm run cli -- history
```

Override the target with `PHAROS_PAYWALL_URL`. No CLI command broadcasts while `paymentOperational` is false.

## Skill

The root [SKILL.md](SKILL.md) is the official-format entry point. An agent can clone the repository, inspect `SKILL.md`, then invoke the shared CLI with `npm run skill -- <command>`. It explicitly requires the agent to report the blocker and forbids token/network substitution.

## Local development and deployment

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run build
npm.cmd run db:migrate:local
npm.cmd run dev
```

Secrets are kept outside the repository and uploaded with Wrangler secrets. `.env.example` contains placeholders only. The resumable deployment command is:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\deploy-cloudflare.ps1
```

The script reuses or creates only the exact-name `pharos-x402-paywalled-api` D1 database, validates one UUID, applies migrations, deploys, verifies locally persisted public identities, uploads encrypted secrets, and redeploys. It does not broadcast blockchain transactions.

Do not set `PAYMENT_OPERATIONAL=true` until a documented compatible Atlantic token and its authoritative EIP-712 domain are verified and the two dedicated public addresses are deliberately funded within a declared ceiling.

## Tests

`npm test` currently runs 27 deterministic tests. Behavioral coverage includes:

- free route HTTP 200 bypass;
- both distinct atomic route prices and unpaid 402 headers;
- malformed and valid-signature underpayment rejection before seller access;
- wrong chain/token/recipient/amount allowlist rejection;
- persistent zero-debit HTTP evidence;
- exact decimal arithmetic and boundary comparisons;
- concurrent duplicate runs and global budget races;
- one debit/spend after lost response;
- one facilitator submission across concurrent coordinators;
- settled and pending-on-chain recovery after 1,000 blocks;
- restart reconciliation without replacement authorization;
- chain-time plus authoritative-state retirement.

The recovery/success cases use a faithful SQLite D1 adapter and deterministic mocked chain/facilitator behavior. They prove engine semantics, not a real payment. The requested real deployed client/server/facilitator/receipt test remains blocked by the token incompatibility.

## Acceptance status

| Requirement | Status | Evidence |
| --- | --- | --- |
| Atlantic-only test USDC | PARTIAL | Correct chain/address/decimals/code verified; documented token is not compatible with SDK exact settlement. |
| Two paid prices + one free route | PASS (HTTP surface) | Source/tests; paid routes produce exact 402 challenges, free route produces 200. |
| Own operational facilitator | BLOCKED | Endpoints and HTTP routing implemented, allowlisted and tested; settlement deliberately disabled because its configured token cannot execute EIP-3009. |
| Real 402 → signed payment → 200 + receipt | BLOCKED | No transaction was broadcast and no success is claimed. |
| Invalid/underpaid returns 402 | PASS (deterministic; deploy evidence pending) | Valid lower-amount SDK signature is rejected before seller; zero debit/settlement. |
| Secret isolation | PASS | Ignored external secret file, Worker secrets, placeholders only, browser/evidence sanitization. |

Recorded spend: **0 test USDC** and **0 PHRS gas**. See [evidence/acceptance-status.json](evidence/acceptance-status.json).

### Minimum action to unblock

Pharos must identify or deploy a documented Atlantic test-USDC contract that supports EIP-3009 `transferWithAuthorization` and `authorizationState`, document its authoritative EIP-712 name/version/domain, and make test tokens available. After that, the project owner can update the configured address/domain, re-run the foundation probe and tests, fund only the dedicated buyer/facilitator with a capped amount, enable settlement, and record exactly two minimum successful payments. Merely funding the current addresses is not sufficient.

## Security notes

- No private key, owner token, full live signature, or reusable authorization is committed or returned by public APIs.
- `/settle` is owner-authenticated and disabled by default; `/verify` is read-only.
- Client-supplied requirements are never authority: route, origin, network, scheme, asset, recipient, and amount must match server configuration.
- Missing/invalid/underpaid tests never send intentionally reverting transactions.
- This is testnet software, not production payment infrastructure.
