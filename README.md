# Pharos x402 Paywalled API

An operational x402 v2 seller, self-hosted facilitator, buyer, CLI, installable Skill, D1 evidence store, and retro reviewer UI on Pharos Atlantic Testnet.

- Demo: https://pharos-x402-paywalled-api.shoupeorg.workers.dev/
- Network: `eip155:688689`
- Official Atlantic test USDC: `0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B`
- SDK: `@x402/core`, `@x402/evm`, `@x402/fetch`, and `@x402/hono` `2.28.0`
- Settlement: official `exact` EVM EIP-3009 flow; Permit2 is not used or needed

## Verified payment foundation

The [official Pharos Token Registry](https://docs.pharos.xyz/getting-started/token-registry) lists the Atlantic USDC address above with six decimals. Its verified `FiatTokenProxy` delegates to implementation `0x02c3fe2d1700814ec27da9e447f7957329c96126`. Read-only chain verification returned:

| Property | Value |
| --- | --- |
| `name()` / `symbol()` | `USDC` / `USDC` |
| `decimals()` | `6` |
| `version()` | `2` |
| `DOMAIN_SEPARATOR()` | `0x29a275a05374772bbc16618b5855b2e9317f36399c0d925e4deea5646c572afd` |
| EIP-3009 | `transferWithAuthorization`, `authorizationState`, and authorization type hashes exposed |

The supplied funding receipt [0x5de280…b65d](https://atlantic.pharosscan.xyz/tx/0x5de280fb94401bee7086f24eaac4f2a3c95fc35367ee506cfd183e9cd3f6b65d) succeeded at block `31545051`; its `Transfer` log identifies this exact token and a `1 USDC` transfer to the buyer. A separate earlier `1 USDC` transfer made the pre-demo balance `2 USDC`. See [evidence/official-usdc-funding.json](evidence/official-usdc-funding.json) and run `npm run probe:foundation` for a current read-only probe.

## Routes and prices

| Route | Price | Result |
| --- | ---: | --- |
| `GET /health` | free | HTTP 200, no payment header |
| `GET /paid/network-snapshot?block=N` | `0.001 USDC` | x402 402 challenge; paid HTTP 200 after confirmed settlement |
| `GET /paid/activity-summary?block=N` | `0.002 USDC` | x402 402 challenge; paid HTTP 200 after confirmed settlement |

The two paid responses use the same pinned Atlantic block. Route A returns the block base fee plus buyer/merchant balances; route B summarizes that block and the preceding two blocks. Data is released only after a successful receipt containing the exact expected token `Transfer`, or authenticated recovery of the same already-settled authorization.

## Real paid HTTP evidence

Run `live-paid-20261018` completed on 2026-10-17 UTC at pinned block `31549799`:

| Route | Debit | Settlement | Receipt | Gas |
| --- | ---: | --- | --- | ---: |
| Network snapshot | `0.001 USDC` | [0x376eef…cec14](https://atlantic.pharosscan.xyz/tx/0x376eef61781d73522f2e335c7617239b39dc479eae39ca13d909ba5ebb5cec14) | success, block `31549804` | `102,796` gas / `0.000102796 PHRS` |
| Activity summary | `0.002 USDC` | [0x3ca298…4bcf3](https://atlantic.pharosscan.xyz/tx/0x3ca298502f1d13eaa085ed6a59fb71c23e25568ac747b5eed62187f83614bcf3) | success, block `31549827` | `85,740` gas / `0.000085740 PHRS` |

Total debit was exactly `0.003 USDC`; total facilitator gas was `0.000188536 PHRS`, below the user-approved `0.0139 PHRS` ceiling. Post-run balances at block `31549868` were buyer `1.997 USDC`, merchant `0.003 USDC`, and facilitator `0.099811464 PHRS`.

Each live route followed: unpaid HTTP 402 with `PAYMENT-REQUIRED` → SDK-signed EIP-3009 authorization → own `/verify` and `/settle` facilitator HTTP calls → successful chain receipt and exact `Transfer` → paid HTTP 200 with `PAYMENT-RESPONSE`. The activity route deliberately discarded its first paid response after real settlement; retry used the same authorization and recovered the stored response on attempt two without a second debit. Full evidence is in [evidence/live-paid-run.json](evidence/live-paid-run.json) and deployed `/api/tasks/live-paid-20261018` plus `/api/http-evidence`.

## Facilitator, limits, and durability

The Worker exposes `GET /supported`, `POST /verify`, and owner-authenticated `POST /settle`. It strictly allowlists origin, routes, network, scheme, asset, merchant, and exact amount. The official SDK verifies and settles EIP-3009 authorization. `simulateInSettle`, a `160,000`-gas per-settlement ceiling, a durable total-gas guard, and an explicit `0.0139 PHRS` total spend ceiling run before broadcast.

`BuyerCoordinator` and `SellerCoordinator` serialize async operations. D1 adds conditional budget reservations, unique authorization identities, durable settlement claims, and idempotent accounting across restarts. Concurrent duplicates share one authorization and one facilitator submission. Retries use delays `0/250/750 ms`; an ambiguous result keeps its reservation and reconciles `authorizationState` plus `AuthorizationUsed` logs without creating a replacement authorization. Expiry uses chain block time and authoritative authorization state.

Invalid and correctly signed underpayment demonstrations return HTTP 402 with zero debit and no settlement. Fresh deployed evidence IDs include:

- `INVALID_PAYMENT-079de970-6c2c-442e-98f9-e519abc59732`
- `UNDERPAYMENT-3d99fd9e-46b7-4ffb-8ed3-4501b2d2d159`
- `MISSING_PAYMENT-635e8d3e-bd13-4eb8-87fd-cc8a3b31afc9`

## Install, CLI, and Skill

Node.js 20+ is required.

```bash
git clone https://github.com/shoupeorg/pharos-x402-paywalled-api.git
cd pharos-x402-paywalled-api
npm ci
npm test
npm run build
```

Read-only/reviewer CLI commands:

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

The root [SKILL.md](SKILL.md) is the installable Skill entry point. Invoke shared behavior with `npm run skill -- <command>`. Spending routes require the owner token; secrets remain server-side.

## Development and deployment

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run build
npm.cmd run db:migrate:local
npm.cmd run dev
```

Secrets live in an ACL-protected file outside the repository and in Cloudflare encrypted secrets. `.env.example` contains placeholders only. The deployed `/api/identity-status` reports only Boolean address-derivation checks; it never returns a key or owner token. Use the resumable deployment script:

```powershell
powershell.exe -ExecutionPolicy Bypass -File .\scripts\deploy-cloudflare.ps1
```

## Tests and acceptance

`npm test` passes 28 tests covering exact HTTP challenges, free access, invalid/underpaid rejection, decimal arithmetic, budget boundaries, concurrent duplicates, global reservation races, one debit after lost response, durable facilitator claims, stale-snapshot recovery, restart reconciliation, and chain-time authorization retirement. Deterministic tests are clearly separate from the two real receipts above.

| Requirement | Status | Evidence |
| --- | --- | --- |
| Atlantic test USDC and exact prices | PASS | Official registry, live proxy reads, 6 decimals, exact `0.001` and `0.002 USDC` debits |
| Free + two paid HTTP routes | PASS | `/health`; two deployed 402 → signed payment → 200 flows |
| Own operational facilitator | PASS | `/supported`, `/verify`, `/settle`, strict allowlist, receipt verification |
| Durable accounting and recovery | PASS | D1 run/event log; lost-response recovery with one debit and one spend entry |
| Invalid and underpaid rejection | PASS | Fresh official-token deployed evidence above; HTTP 402, zero debit |
| Secret isolation and spending limits | PASS | Boolean signer checks, no published signatures/keys, `0.0139 PHRS` enforced ceiling |

No custom token, Permit2 proxy, replacement signer, or contract deployment was used. This is testnet software, not production payment infrastructure.
