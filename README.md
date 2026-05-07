# @insumermodel/mppx-condition-gate

Condition-based access for [mppx](https://github.com/wevm/mppx) routes. One signed call between request and charge gives free access to wallets that meet your conditions; everyone else falls through to the normal paid path. Four condition types: token balance, NFT ownership, EAS attestation, Farcaster ID. 33 chains. No RPC management.

> **Migrating from `@insumermodel/mppx-token-gate`?** This is the v2 successor. See [Migration](#migrating-from-mppx-token-gate) below.

## How it works

mppx embeds the payer's identity in every payment credential as a DID string (`credential.source: "did:pkh:eip155:8453:0xABC..."`). `conditionGate` reads that address, calls [InsumerAPI](https://insumermodel.com) to evaluate the configured conditions, and short-circuits the payment flow for wallets that pass.

1. Request arrives with a payment credential
2. `conditionGate` extracts the payer address from `credential.source`
3. [InsumerAPI](https://insumermodel.com/developers/api-reference/) evaluates the conditions and returns an ECDSA P-256 signed attestation
4. **Pass** → free receipt returned (`reference: "condition-gate:free:{attestationId}"`)
5. **Fail** → delegates to the original `verify` (normal payment proceeds)

The signed attestation is verifiable offline via [JWKS](https://insumermodel.com/.well-known/jwks.json). The adapter does not re-sign or wrap the result; the signature on the attestation is the one InsumerAPI produced.

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

Mix any of the four in a single call. `matchMode: 'any'` (default) passes when any one is met; `matchMode: 'all'` requires all of them.

### Token balance

```ts
{
  type: 'token_balance',
  contractAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
  chainId: 1,
  threshold: 1000,
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
| `jwt` | `boolean` | `false` | Request ES256 JWT alongside raw attestation |
| `apiBaseUrl` | `string` | `https://api.insumermodel.com` | API base URL override |

## Supported chains

30 EVM chains (Ethereum, Base, Polygon, Arbitrum, Optimism, BNB, Avalanche, and 23 more) + Solana + XRPL + Bitcoin. EAS conditions evaluate on EVM chains only. Farcaster always on Optimism.

[Full chain list](https://insumermodel.com/developers/api-reference/)

## Distinguishing free vs paid access

```ts
const receipt = Receipt.fromResponse(response)
if (receipt.reference.startsWith('condition-gate:free:')) {
  const attestationId = receipt.reference.replace('condition-gate:free:', '')
  // Free access. Attestation ID is retrievable via /v1/attestations/{id}
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

## License

MIT
