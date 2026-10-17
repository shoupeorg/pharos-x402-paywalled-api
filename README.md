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

## Real settlement evidence and transport disclosure

Run `live-paid-20261018` completed on 2026-10-17 UTC at pinned block `31549799`:

| Route | Debit | Settlement | Receipt | Gas |
| --- | ---: | --- | --- | ---: |
| Network snapshot | `0.001 USDC` | [0x376eef…cec14](https://atlantic.pharosscan.xyz/tx/0x376eef61781d73522f2e335c7617239b39dc479eae39ca13d909ba5ebb5cec14) | success, block `31549804` | `102,796` gas / `0.000102796 PHRS` |
| Activity summary | `0.002 USDC` | [0x3ca298…4bcf3](https://atlantic.pharosscan.xyz/tx/0x3ca298502f1d13eaa085ed6a59fb71c23e25568ac747b5eed62187f83614bcf3) | success, block `31549827` | `85,740` gas / `0.000085740 PHRS` |

Total debit was exactly `0.003 USDC`; total facilitator gas was `0.000188536 PHRS`, below the user-approved `0.0139 PHRS` ceiling. Post-run balances at block `31549868` were buyer `1.997 USDC`, merchant `0.003 USDC`, and facilitator `0.099811464 PHRS`.

The two receipts, token transfers, paid response bodies, and D1 accounting are real. However, the original buyer obtained the unpaid challenge and submitted the signed paid request by invoking the Worker seller handler in-process. It did **not** fetch the public paid URL. Consequently, this historical run proves settlement and recovery correctness, but is not evidence of a complete external HTTP buyer flow. The activity route deliberately discarded its first in-process paid response after real settlement; retry reused the same authorization and recovered the stored response without a second debit.

The production buyer has since been corrected to use `fetch(PUBLIC_ORIGIN + paidRoute)` for both the unpaid challenge and signed request. Dependency injection remains available only for deterministic tests. Migration `0005_transport_evidence_correction.sql` relabels the original D1 rows as `IN_PROCESS_WORKER_CALL` without changing receipts, hashes, accounting, or timestamps.

`POST /api/replay-settled-http` provides an owner-authenticated, no-spend proof of the corrected transport. It sends the original stored authorization to the public paid URL. The seller authenticates the original payment/resource binding and returns the stored response with HTTP 200 and `PAYMENT-RESPONSE`; no settlement or debit is created. This is explicitly labeled `PUBLIC_WORKER_HTTP_RECOVERY`, not a fresh initial payment flow. Safe evidence stores only the decoded transaction hash/network/success flag and never publishes the reusable payment signature.

The deployed replay command writes [evidence/http-recovery-replay.json](evidence/http-recovery-replay.json) and persists the same safe records in `/api/http-evidence`.

Full historical evidence is in [evidence/live-paid-run.json](evidence/live-paid-run.json). The bounded runner records the separately authorized fresh public-HTTP Route A demonstration without altering those historical transport labels.

<!-- FRESH_HTTP_EVIDENCE_START -->
### Fresh public HTTP Route A proof

Run `fresh-public-http-route-a-20261018` recorded the complete deployed lifecycle: public unauthenticated HTTP 402, fresh SDK-signed request over public HTTP, facilitator verification, one settlement, successful receipt, and HTTP 200 with a decoded `PAYMENT-RESPONSE`. It debited exactly `0.001 USDC`. The pre-broadcast estimate was `134888400000000 wei`; actual gas was `85740000000000 wei` (`0.00008574 PHRS`), below the independently enforced `0.0003 PHRS` ceiling.

Settlement: [0x10cf99b6…a6bec](https://atlantic.pharosscan.xyz/tx/0x10cf99b6c4e561110ec0eeda6466ab102be1ad7e9cd363e85523fbe1144a6bec), receipt success at block `31553364`. Route B was stopped before authorization because the run budget was exactly `0.001 USDC`, so this run created one—and only one—new settlement. Sanitized evidence: [evidence/fresh-public-http-route-a.json](evidence/fresh-public-http-route-a.json). No reusable payment signature or secret is published.
<!-- FRESH_HTTP_EVIDENCE_END -->

## Facilitator, limits, and durability

The Worker exposes `GET /supported`, `POST /verify`, and owner-authenticated `POST /settle`. It strictly allowlists origin, routes, network, scheme, asset, merchant, and exact amount. The official SDK verifies and settles EIP-3009 authorization. `simulateInSettle`, a `160,000`-gas per-settlement ceiling, a durable total-gas guard, the explicit `0.0139 PHRS` total spend ceiling, and the independently authorized `0.0003 PHRS` per-new-settlement ceiling run before broadcast. Buyer USDC and facilitator PHRS balances, the gas estimate, gas price, facilitator verification result, and chain block/time are durably stored before settlement submission.

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

`npm test` covers exact HTTP challenges, free access, invalid/underpaid rejection, decimal arithmetic, budget boundaries, concurrent duplicates, global reservation races, one debit after lost response, durable facilitator claims and preflight persistence, stale-snapshot recovery, restart reconciliation, chain-time authorization retirement, production public-fetch transport, zero-debit HTTP recovery replay, and rejection before broadcast when the `0.0003 PHRS` estimate ceiling is exceeded. Deterministic tests are clearly separate from real chain evidence.

| Requirement | Status | Evidence |
| --- | --- | --- |
| Atlantic test USDC and exact prices | PASS | Official registry, live proxy reads, 6 decimals, real exact `0.001` and `0.002 USDC` debits |
| Free + two distinct paid resources | PASS | `/health`, `/paid/network-snapshot`, and `/paid/activity-summary` with distinct prices |
| Own operational facilitator | PASS | `/supported`, `/verify`, `/settle`, strict allowlist, and two successful real receipts |
| Complete deployed external HTTP payment lifecycle | PASS | Fresh Route A evidence records public HTTP 402, SDK-signed public HTTP payment, facilitator verification/settlement, successful receipt, and HTTP 200 with decoded `PAYMENT-RESPONSE`. Historical in-process evidence remains accurately labeled. |
| Durable accounting, replay protection, and rejection | PASS | D1 guards, restart/lost-response recovery, invalid and signed-underpayment HTTP 402 with zero debit |
| Secret isolation and spending limits | PASS | Boolean signer checks, no published signatures/keys, and enforced `0.0139 PHRS` ceiling |

No custom token, Permit2 proxy, replacement signer, or contract deployment was used. This is testnet software, not production payment infrastructure.
