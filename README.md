# mppx-token-gate

Token-gate [mppx](https://github.com/wevm/mppx) routes using signed wallet attestations. One API call checks token/NFT ownership across 30 EVM chains + Solana + XRPL — no RPC management, no viem transports, no in-house balance checks.

## How it works

mppx embeds the payer's identity in every payment credential as a DID string (`credential.source: "did:pkh:eip155:8453:0xABC..."`). `tokenGate` reads that address, calls [InsumerAPI](https://insumermodel.com) to check on-chain ownership, and short-circuits the payment flow for holders.

1. Request arrives with a payment credential
2. `tokenGate` extracts the payer address from `credential.source`
3. [InsumerAPI](https://insumermodel.com/developers/api-reference/) checks ownership and returns an ECDSA P-256 signed result
4. **Token holder** → free receipt returned (`reference: "token-gate:free:{attestationId}"`)
5. **Non-holder** → delegates to the original `verify` (normal payment proceeds)

The attestation signature is verifiable offline via [JWKS](https://insumermodel.com/.well-known/jwks.json) — downstream services can independently verify the gate decision.

## Install

```bash
npm install mppx-token-gate
```

## Usage

```ts
import { Mppx, tempo } from 'mppx/server'
import { tokenGate } from 'mppx-token-gate'

const tempoCharge = tempo({
  currency: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  recipient: '0xYourAddress',
})

const gatedCharge = tokenGate(tempoCharge, {
  apiKey: process.env.INSUMER_API_KEY,
  conditions: [{
    type: 'nft_ownership',
    contractAddress: '0xYourNFT',
    chainId: 8453,        // Base
  }],
})

const mppx = Mppx.create({ methods: [gatedCharge] })
```

Works with any framework (Hono, Express, Elysia, Next.js) and any payment method (tempo, stripe) — it wraps `Method.Server`, so no middleware changes needed.

## API key

Get a free key (instant, no signup):

```bash
curl -X POST https://api.insumermodel.com/v1/keys/create \
  -H "Content-Type: application/json" \
  -d '{"email":"you@example.com","appName":"my-app","tier":"free"}'
```

Or set `INSUMER_API_KEY` as an environment variable.

## Options

| Option | Type | Default | Description |
|---|---|---|---|
| `apiKey` | `string` | `env.INSUMER_API_KEY` | InsumerAPI key |
| `conditions` | `TokenCondition[]` | — | Token/NFT conditions to check |
| `matchMode` | `'any' \| 'all'` | `'any'` | Whether holder must satisfy any or all conditions |
| `cacheTtlSeconds` | `number` | `300` | In-memory ownership cache TTL |
| `jwt` | `boolean` | `false` | Request ES256 JWT alongside raw attestation |
| `apiBaseUrl` | `string` | `https://api.insumermodel.com` | API base URL override |

### TokenCondition

| Field | Type | Description |
|---|---|---|
| `contractAddress` | `string` | Token/NFT contract address |
| `chainId` | `number \| 'solana' \| 'xrpl'` | Chain identifier |
| `type` | `'token_balance' \| 'nft_ownership'` | Condition type |
| `threshold` | `number` | Min balance (token_balance only, default 1) |
| `decimals` | `number` | Token decimals (auto-detected on most EVM chains) |
| `label` | `string` | Human-readable label |
| `currency` | `string` | XRPL currency code |
| `taxon` | `number` | XRPL NFT taxon filter |

## Supported chains

30 EVM chains (Ethereum, Base, Polygon, Arbitrum, Optimism, BNB, Avalanche, and 23 more) + Solana + XRPL.

[Full chain list](https://insumermodel.com/developers/api-reference/)

## Distinguishing free vs paid access

```ts
const receipt = Receipt.fromResponse(response)
if (receipt.reference.startsWith('token-gate:free:')) {
  // Free access — attestation ID is in the reference
  const attestationId = receipt.reference.replace('token-gate:free:', '')
} else {
  // Paid access
}
```

## Fail-open behavior

If the attestation API is unreachable, the wrapper falls through to the original payment method. Token holders pay normally; non-holders are unaffected.

## License

MIT
