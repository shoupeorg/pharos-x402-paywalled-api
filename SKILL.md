---
name: pharos-x402-paywalled-api
description: Inspect and demonstrate an operational Pharos Atlantic x402 paywalled API, exact HTTP 402 challenges, safe negative cases, persistent paid evidence, and recovery behavior without exposing secrets.
license: MIT
---

# Pharos x402 Paywalled API

Operate only on Pharos Atlantic Testnet (`eip155:688689`). Never substitute mainnet, PXUSD, a custom token, mock payment evidence, or another network.

## Install

```bash
git clone https://github.com/shoupeorg/pharos-x402-paywalled-api.git
cd pharos-x402-paywalled-api
npm ci
```

## Invoke

Use the shared CLI:

```bash
npm run skill -- status
npm run skill -- health
npm run skill -- challenge /paid/network-snapshot
npm run skill -- challenge /paid/activity-summary
npm run skill -- demo free
npm run skill -- demo missing
npm run skill -- demo invalid
npm run skill -- demo underpayment
npm run skill -- history
```

Set `PHAROS_PAYWALL_URL` only to review another deployment of this project.

## Required behavior

1. Start with `status`. Report `paymentOperational` and `blocker` exactly as returned.
2. Confirm `/health` is HTTP 200 with no payment header.
3. Inspect both challenges. Require x402 version 2, `exact`, `eip155:688689`, the configured token/merchant, exact resource URL, and amounts `1000` and `2000` atomic units.
4. Negative demos are fresh public HTTP actions and must persist zero debit and no settlement hash.
5. History is recorded evidence; never describe a deterministic test or negative request as a successful payment.

The official Atlantic test USDC is `0xcfC8330f4BCAB529c625D12781b1C19466A9Fc8B`, 6 decimals, EIP-712 name `USDC`, version `2`. It exposes `transferWithAuthorization`, `authorizationState`, and `DOMAIN_SEPARATOR`, matching the EIP-3009 flow in `@x402/evm` 2.28.0. Permit2 is not used.

Spending actions remain owner-authenticated. Do not expose keys, reusable signatures, or the owner token. Never initiate a new paid run merely to review the submission; use `history` and run `live-paid-20261018` unless the owner explicitly authorizes additional test-token spending.

## Evidence interpretation

- `FREE_HEALTH`: real HTTP 200, no payment.
- `MISSING_PAYMENT`: real HTTP 402 challenge.
- `INVALID_PAYMENT`: malformed header rejected, zero spend.
- `UNDERPAYMENT`: SDK-signed lower amount rejected before settlement, zero spend.
- `PAID_ROUTE_A` / `PAID_ROUTE_B`: real successful receipts and exact token transfers; their original buyer-to-seller transport was an in-process Worker call, not public HTTP.
- `HTTP_RECOVERY_ROUTE_A` / `HTTP_RECOVERY_ROUTE_B`: real public HTTP 200 recovery of those already-settled authorizations, with decoded `PAYMENT-RESPONSE`, zero new debit, and no new settlement.
- `live-paid-20261018`: the authoritative two-route settlement demonstration totaling `0.003 USDC`; do not describe it as proof of a fresh external HTTP settlement flow.

The production buyer now fetches both challenge and paid seller routes through `PUBLIC_ORIGIN`. A public HTTP recovery replay proves the corrected deployed transport without spending, but it is not a fresh initial payment. State this limitation whenever reporting task completion.

Accept paid data only after a successful receipt and exact token `Transfer`. On ambiguity, retain durable pending state and reconcile the same authorization; never create a replacement payment blindly.
