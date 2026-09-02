# @insumermodel/mppx-condition-gate

Condition-based access for [mppx](https://github.com/wevm/mppx) routes. One signed call between request and charge gives free access to wallets that meet your conditions; everyone else falls through to the normal paid path. Six condition types: token balance, NFT ownership, EAS attestation, Farcaster ID, plus ratio_to_amount (hold >= N x a spend amount) and ratio_to_supply (hold >= a fraction of token supply). No RPC management.

> **Migrating from `@insumermodel/mppx-token-gate`?** This is the v2 successor. See [Migration](#migrating-from-mppx-token-gate) below.

## How it works

Free access requires a payer your payment method has **proven** controls the request. You supply that payer through `provenPayer`; the gate never infers one.

1. Request arrives with a payment credential
2. The gate calls the method's non-mutating `validate` hook
3. Your `provenPayer` resolver receives mppx's method-specific validation `details` and returns the proven payer, or `null`
4. [InsumerAPI](https://insumermodel.com/developers/api-reference/) evaluates the conditions for that payer and returns an ECDSA P-256 signed attestation
5. **Pass** → free receipt returned (`reference: "condition-gate:free:{attestationId}"`)
6. **Fail, or no proven payer** → the normal paid path runs

The signed attestation is verifiable offline via [JWKS](https://insumermodel.com/.well-known/jwks.json). The adapter does not re-sign or wrap the result; the signature on the attestation is the one InsumerAPI produced. Since 2026-09-01 every attest response also carries an ML-DSA-65 post-quantum companion (`pqSig`, `pqKid`) beside `sig` and `kid`, added without changing them; the `InsumerAttestation` type declares `pqSig` and `pqKid` beside `sig` and `kid`, and `insumer-verify` 1.8.1+ reports the companion as a fifth verdict.

### Why you must supply the payer

mppx credentials carry an optional `source` DID, but mppx documents it as *"an asserted identity, not independent proof of control"* — it is a claim by the caller, not a proof. Versions before 3.0.0 granted free access on it, which let anyone name a qualifying wallet and skip payment ([GHSA-jg6q-3qfh-r9f8](https://github.com/douglasborthwick-crypto/mppx-condition-gate/security/advisories/GHSA-jg6q-3qfh-r9f8)). The gate now refuses to guess.

`provenPayer` receives **only** the validation `details` — never the credential and never `source` — so the unproven identity is not reachable from it. Return a payer only if the payment method has actually established control of it. **Every path that cannot justify free access falls through to payment:** no resolver, no `validate` hook on the method, a resolver returning `null` or throwing, a credential that fails validation, conditions not met, or an attestation error.

## Install

```bash
npm install @insumermodel/mppx-condition-gate
```

## Usage

```ts
import { Mppx, tempo } from 'mppx/server'
import { conditionGate } from '@insumermodel/mppx-condition-gate'

const tempoCharge = tempo({
  currency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  recipient: '0xYourAddress',
})

const gatedCharge = conditionGate(tempoCharge, {
  apiKey: process.env.INSUMER_API_KEY,
  // Return only a payer this method has PROVEN for this request, else null.
  // The argument is mppx's method-specific validation `details`.
  provenPayer: (details) => (details as { payer?: string }).payer ?? null,
  conditions: [{
    type: 'nft_ownership',
    contractAddress: '0xYourNFT',
    chainId: 8453,        // Base
  }],
})

const mppx = Mppx.create({ methods: [gatedCharge] })
```

Works with any framework (Hono, Express, Elysia, Next.js) and any payment method (tempo, stripe). The adapter wraps `Method.Server`, so no middleware changes needed.

## Condition types

Mix any of the six in a single call. `matchMode: 'any'` (default) passes when any one is met; `matchMode: 'all'` requires all of them.

### Token balance

```ts
{
  type: 'token_balance',
  contractAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
  chainId: 1,
  threshold: '1000', // decimal string in token units; numbers are converted before sending
  decimals: 6,
  label: 'USDC >= 1000',
}
```

### NFT ownership

```ts
{
  type: 'nft_ownership',
  contractAddress: '0xYourNFT',
  chainId: 8453,
  label: 'Holds the access NFT',
}
```

### EAS attestation (compliance template)

```ts
{
  type: 'eas_attestation',
  template: 'coinbase_verified_account',
  chainId: 8453,
  label: 'Coinbase KYC verified',
}
```

Available templates: `coinbase_verified_account`, `coinbase_verified_country`, `coinbase_one`, `gitcoin_passport_score`, `gitcoin_passport_active`. See [GET /v1/compliance/templates](https://insumermodel.com/developers/compliance/).

### EAS attestation (raw schema)

```ts
{
  type: 'eas_attestation',
  schemaId: '0xf8b05c79f090979bf4a80270aba232dff11a10d9ca55c4f88de95317970f0de9',
  attester: '0x357458739F90461b99789350868CD7CF330Dd7EE',
  indexer: '0x2c7eE1E5f416dfF40054c27A62f7B357C4E8619C',
  chainId: 8453,
  label: 'Custom EAS attestation',
}
```

### Farcaster ID

```ts
{
  type: 'farcaster_id',
  label: 'Has a Farcaster account',
}
```

Always evaluated on Optimism (chain 10). Passes if the wallet has any FID registered.

### Ratio to amount

Self-scaling spend rule: passes when the wallet holds at least `multiple` times a per-request `amount`. RPC EVM chains only.

```ts
{
  type: 'ratio_to_amount',
  contractAddress: 'native', // or an ERC-20 address
  chainId: 8453,
  multiple: 10,
  amount: 250,
  label: 'Holds >= 10x the 250-unit spend',
}
```

### Ratio to supply

Share-of-supply rule: passes when the wallet holds at least `minFraction` of the token's on-chain total supply. For project/governance tokens, not stablecoins. RPC EVM chains, ERC-20 contracts only.

```ts
{
  type: 'ratio_to_supply',
  contractAddress: '0x1f9840a85d5aF5bf1D1762F925BdADdC4201F984', // UNI
  chainId: 1,
  minFraction: 0.005, // 0.5% of supply
  label: 'Holds >= 0.5% of UNI supply',
}
```

## API key and credits

Each call to `/v1/attest` consumes one or more attestation credits. New keys ship with **10 free credits**, enough to wire up the integration end-to-end before paying anything.

Two ways to provision a key.

**Email signup** (human-managed):

```bash
curl -X POST https://api.insumermodel.com/v1/keys/create \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","appName":"my-app","tier":"free"}'
```

**On-chain** (autonomous agent bootstrap): send USDC, USDT, or BTC to the platform wallet, then call `POST /v1/keys/buy` with the transaction hash. The transaction sender wallet is the identity, the payment is the auth — no email, no human in the loop.

Either way, set `INSUMER_API_KEY` as an environment variable in your runtime.

**Top up** an existing key on-chain via `POST /v1/credits/buy`. Accepted: USDC or USDT on any major EVM chain, USDC on Solana, or BTC on Bitcoin. See the [credits endpoint](https://insumermodel.com/developers/api-reference/) for transaction format.

**Pricing model**: the wallet holder pays nothing at the gated route. The operator running the gate pays per attestation call out of the key's credit balance. Cost per attestation depends on tier and condition mix.

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | `env.INSUMER_API_KEY` | InsumerAPI key |
| `conditions` | `Condition[]` | required | One or more conditions to evaluate |
| `matchMode` | `'any' \| 'all'` | `'any'` | Wallet must satisfy any or all conditions |
| `cacheTtlSeconds` | `number` | `300` | In-memory cache TTL |
| `apiBaseUrl` | `string` | `https://api.insumermodel.com` | API base URL override |

## Supported chains

32 EVM chains (Ethereum, Base, Polygon, Arbitrum, Optimism, BNB, Avalanche, Robinhood Chain, and 24 more) + Solana + XRPL + Bitcoin — the 35 chains this adapter's wallet handling reaches. The engine itself covers 38 (adding Tron, Stellar, and Sui via InsumerAPI directly). EAS conditions evaluate on EVM chains only. Farcaster always on Optimism.

[Full chain list](https://insumermodel.com/developers/api-reference/)

## Distinguishing free vs paid access

```ts
const receipt = Receipt.fromResponse(response)
if (receipt.reference.startsWith('condition-gate:free:')) {
  const attestationId = receipt.reference.replace('condition-gate:free:', '')
  // Free access. attestationId is the `id` of the signed attestation InsumerAPI
  // returned for this payer (from POST /v1/attest). The gate keeps only `id` and
  // `pass` in its in-memory cache and the API has no lookup by id, so record the
  // reference here if you need to correlate it with your own logs.
} else {
  // Paid access
}
```

## Fail-open behavior

If the attestation API is unreachable, the adapter falls through to the original payment method. Wallets that would have qualified for free access pay normally; everyone else is unaffected.

## Migrating from mppx-token-gate

`@insumermodel/mppx-token-gate` (v1) is deprecated. Migration to v2:

```diff
- npm install @insumermodel/mppx-token-gate
+ npm install @insumermodel/mppx-condition-gate
```

```diff
- import { tokenGate } from '@insumermodel/mppx-token-gate'
+ import { conditionGate } from '@insumermodel/mppx-condition-gate'

- const gated = tokenGate(server, { ... })
+ const gated = conditionGate(server, { ... })
```

```diff
- if (receipt.reference.startsWith('token-gate:free:'))
+ if (receipt.reference.startsWith('condition-gate:free:'))
```

The condition shapes for `token_balance` and `nft_ownership` are unchanged. `eas_attestation` and `farcaster_id` are new in v2.

The `parsXrplDid` typo from v1 is fixed: use `parseXrplDid`. The cache helper renamed: `clearTokenGateCache` is now `clearConditionGateCache`.

## Migrating from 2.x (security release)

3.0.0 fixes an authentication bypass ([GHSA-jg6q-3qfh-r9f8](https://github.com/douglasborthwick-crypto/mppx-condition-gate/security/advisories/GHSA-jg6q-3qfh-r9f8)). All 2.x versions, and all versions of the predecessor `@insumermodel/mppx-token-gate`, are affected.

Add a `provenPayer` resolver:

```diff
  const gated = conditionGate(server, {
    apiKey: process.env.INSUMER_API_KEY,
+   provenPayer: (details) => (details as { payer?: string }).payer ?? null,
    conditions: [ ... ],
  })
```

Without it the gate compiles and runs, but never grants free access — every request takes the paid path. That is deliberate: the insecure default is gone, and the safe default is to charge.

Your method must expose mppx's `validate` hook. Legacy `verify`-only methods have no non-mutating pre-check, so they are never gated.

## License

MIT
