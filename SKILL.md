---
name: pharos-x402-paywalled-api
description: Inspect and demonstrate a Pharos Atlantic x402 paywalled API, its exact HTTP 402 challenges, safe negative cases, persistent evidence, and foundation compatibility status. Use when an agent must review the Pharos x402 Paywalled API submission without exposing secrets or broadcasting unsupported payments.
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

The currently documented Atlantic test-USDC address is `0xE0BE08c77f415F577A1B3A9aD7a1Df1479564ec8`, 6 decimals. The recorded foundation probe shows that it lacks `transferWithAuthorization`, `authorizationState`, and `DOMAIN_SEPARATOR`, while `@x402/evm` 2.28.0 exact requires EIP-3009. Therefore real settlement is **BLOCKED** and `PAYMENT_OPERATIONAL=false` is intentional.

Do not request funding until a documented EIP-3009-compatible Atlantic test-USDC and its authoritative EIP-712 domain are available. Do not enable settlement, invent domain metadata, expose keys, or broadcast a transaction to test this incompatible token.

## Evidence interpretation

- `FREE_HEALTH`: real HTTP 200, no payment.
- `MISSING_PAYMENT`: real HTTP 402 challenge.
- `INVALID_PAYMENT`: malformed header rejected, zero spend.
- `UNDERPAYMENT`: SDK-signed lower amount rejected before settlement, zero spend.
- `BLOCKED_FOUNDATION`: no successful paid route, receipt, or `PAYMENT-RESPONSE` is claimed.

If a future compatible configuration is explicitly verified and enabled, accept paid data only after a successful receipt and exact token `Transfer`. On ambiguity, retain durable pending state and reconcile the same authorization; never create a replacement payment blindly.
