import type { Method, Receipt } from 'mppx'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChainId = number | 'solana' | 'xrpl' | 'bitcoin'

/** ERC-20 / SPL / XRPL trust-line / native balance check */
export type TokenBalanceCondition = {
  type: 'token_balance'
  /** Token contract address. For XRPL native XRP or Bitcoin, use "native". */
  contractAddress: string
  chainId: ChainId
  /** Minimum balance. Defaults to 1. */
  threshold?: number
  /** Token decimals. Auto-detected on most EVM chains if omitted. */
  decimals?: number
  /** XRPL currency code (e.g. "USD", "RLUSD") for trust-line tokens. */
  currency?: string
  /** Human-readable label (max 100 chars). */
  label?: string
}

/** ERC-721 / ERC-1155 / Solana cNFT / XRPL NFT ownership check */
export type NftOwnershipCondition = {
  type: 'nft_ownership'
  contractAddress: string
  chainId: ChainId
  /** XRPL NFToken taxon filter. XRPL only. */
  taxon?: number
  label?: string
}

/** EAS attestation check (Ethereum Attestation Service) */
export type EasAttestationCondition = {
  type: 'eas_attestation'
  /** EVM chain ID (typically Base 8453). */
  chainId: number
  /**
   * Pre-configured compliance template. Mutually exclusive with schemaId.
   * When provided, fills in schemaId / attester / indexer automatically.
   * See GET /v1/compliance/templates for the live list.
   */
  template?:
    | 'coinbase_verified_account'
    | 'coinbase_verified_country'
    | 'coinbase_one'
    | 'gitcoin_passport_score'
    | 'gitcoin_passport_active'
  /** EAS schema ID (bytes32 hex). Required if template is not provided. */
  schemaId?: string
  /** Expected attester address (case-insensitive). Optional. */
  attester?: string
  /**
   * EAS indexer contract address. Required for raw (non-template) conditions.
   * The verifier resolves the attestation UID via getAttestationUid(recipient, schema).
   */
  indexer?: string
  label?: string
}

/** Farcaster ID registration check (always on Optimism, chain 10) */
export type FarcasterIdCondition = {
  type: 'farcaster_id'
  label?: string
}

/** Any condition accepted by /v1/attest */
export type Condition =
  | TokenBalanceCondition
  | NftOwnershipCondition
  | EasAttestationCondition
  | FarcasterIdCondition

export type ConditionGateOptions = {
  /** InsumerAPI key. Falls back to INSUMER_API_KEY env var. */
  apiKey?: string
  /** One or more conditions to evaluate. Mix any of the four types. */
  conditions: Condition[]
  /** Whether the wallet must satisfy "any" (default) or "all" conditions. */
  matchMode?: 'any' | 'all'
  /** In-memory cache TTL in seconds. Defaults to 300 (5 minutes). */
  cacheTtlSeconds?: number
  /**
   * InsumerAPI base URL. Defaults to "https://api.insumermodel.com".
   * Override for self-hosted deployments or testing.
   */
  apiBaseUrl?: string
  /** Request JWT format alongside the raw attestation. Defaults to false. */
  jwt?: boolean
}

export type InsumerAttestation = {
  ok: boolean
  data: {
    attestation: {
      id: string
      pass: boolean
      results: Array<{
        condition: number
        label?: string
        type: string
        chainId: number | string
        met: boolean
        evaluatedCondition: Record<string, unknown>
        conditionHash: string
        blockNumber?: string
        blockTimestamp?: string
        ledgerIndex?: number
        ledgerHash?: string
      }>
      passCount: number
      failCount: number
      attestedAt: string
      expiresAt: string
    }
    sig: string
    kid: string
    jwt?: string
  }
  meta: {
    version: string
    timestamp: string
    creditsRemaining: number
    creditsCharged: number
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

type CacheEntry = {
  pass: boolean
  attestationId: string
  expiresAt: number
}

const cache = new Map<string, CacheEntry>()

function conditionSortKey(c: Condition): string {
  if (c.type === 'farcaster_id') return 'farcaster_id'
  if (c.type === 'eas_attestation') {
    return `eas:${c.chainId}:${(c.schemaId || c.template || '').toLowerCase()}`
  }
  return `${c.type}:${c.chainId}:${c.contractAddress.toLowerCase()}`
}

function cacheKey(address: string, conditions: Condition[]): string {
  const sorted = [...conditions].sort((a, b) => {
    const ka = conditionSortKey(a)
    const kb = conditionSortKey(b)
    return ka < kb ? -1 : ka > kb ? 1 : 0
  })
  return `${address.toLowerCase()}:${JSON.stringify(sorted)}`
}

/** Clear the in-memory ownership cache. Useful in tests. */
export function clearConditionGateCache(): void {
  cache.clear()
}

// ---------------------------------------------------------------------------
// DID parsing
// ---------------------------------------------------------------------------

/**
 * Extracts an EVM address from a `did:pkh:eip155:{chainId}:{address}` string.
 * Returns null for non-EVM or unparseable DIDs.
 */
export function parseDid(source: string): `0x${string}` | null {
  const parts = source.split(':')
  if (parts.length !== 5) return null
  if (parts[0] !== 'did' || parts[1] !== 'pkh' || parts[2] !== 'eip155') return null
  const address = parts[4]
  if (!address || !address.startsWith('0x')) return null
  return address as `0x${string}`
}

/** Extracts a Solana address from a `did:pkh:solana:{chainId}:{address}` string. */
export function parseSolanaDid(source: string): string | null {
  const parts = source.split(':')
  if (parts.length !== 5) return null
  if (parts[0] !== 'did' || parts[1] !== 'pkh' || parts[2] !== 'solana') return null
  return parts[4] || null
}

/** Extracts an XRPL address from a `did:pkh:xrpl:{chainId}:{address}` string. */
export function parseXrplDid(source: string): string | null {
  const parts = source.split(':')
  if (parts.length !== 5) return null
  if (parts[0] !== 'did' || parts[1] !== 'pkh' || parts[2] !== 'xrpl') return null
  const address = parts[4]
  if (!address || !address.startsWith('r')) return null
  return address
}

/** Extracts a Bitcoin address from a `did:pkh:bip122:{chainId}:{address}` string. */
export function parseBitcoinDid(source: string): string | null {
  const parts = source.split(':')
  if (parts.length !== 5) return null
  if (parts[0] !== 'did' || parts[1] !== 'pkh' || parts[2] !== 'bip122') return null
  return parts[4] || null
}

// ---------------------------------------------------------------------------
// InsumerAPI call
// ---------------------------------------------------------------------------

function buildBodyConditions(conditions: Condition[]): Array<Record<string, unknown>> {
  return conditions.map((c) => {
    if (c.type === 'farcaster_id') {
      const cond: Record<string, unknown> = { type: c.type }
      if (c.label) cond.label = c.label
      return cond
    }
    if (c.type === 'eas_attestation') {
      const cond: Record<string, unknown> = {
        type: c.type,
        chainId: c.chainId,
      }
      if (c.template) cond.template = c.template
      if (c.schemaId) cond.schemaId = c.schemaId
      if (c.attester) cond.attester = c.attester
      if (c.indexer) cond.indexer = c.indexer
      if (c.label) cond.label = c.label
      return cond
    }
    // token_balance or nft_ownership
    const cond: Record<string, unknown> = {
      type: c.type,
      contractAddress: c.contractAddress,
      chainId: c.chainId,
    }
    if (c.type === 'token_balance') {
      cond.threshold = c.threshold ?? 1
      if (c.decimals !== undefined) cond.decimals = c.decimals
      if (c.currency) cond.currency = c.currency
    }
    if (c.type === 'nft_ownership' && c.taxon !== undefined) {
      cond.taxon = c.taxon
    }
    if (c.label) cond.label = c.label
    return cond
  })
}

async function callAttest(
  wallet: string,
  walletType: 'evm' | 'solana' | 'xrpl' | 'bitcoin',
  conditions: Condition[],
  options: Pick<ConditionGateOptions, 'apiKey' | 'apiBaseUrl' | 'jwt'>,
): Promise<InsumerAttestation> {
  const apiKey = options.apiKey || process.env.INSUMER_API_KEY
  if (!apiKey) {
    throw new Error(
      'mppx-condition-gate: Missing API key. Pass apiKey in options or set INSUMER_API_KEY env var. ' +
      'Get a free key: POST https://api.insumermodel.com/v1/keys/create',
    )
  }

  const baseUrl = options.apiBaseUrl || 'https://api.insumermodel.com'

  const body: Record<string, unknown> = {
    conditions: buildBodyConditions(conditions),
  }

  if (walletType === 'solana') body.solanaWallet = wallet
  else if (walletType === 'xrpl') body.xrplWallet = wallet
  else if (walletType === 'bitcoin') body.bitcoinWallet = wallet
  else body.wallet = wallet

  if (options.jwt) body.format = 'jwt'

  const response = await fetch(`${baseUrl}/v1/attest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
  })

  const data = await response.json() as InsumerAttestation
  if (!response.ok || !data.ok) {
    const msg = (data as any)?.error?.message || `HTTP ${response.status}`
    throw new Error(`mppx-condition-gate: Attestation failed: ${msg}`)
  }
  return data
}

// ---------------------------------------------------------------------------
// conditionGate adapter
// ---------------------------------------------------------------------------

/**
 * Wraps an mppx Method.Server with condition-based access using signed attestations.
 *
 * Extracts the payer address from credential.source (DID), calls /v1/attest to
 * evaluate conditions across 33 chains, and returns a free-access receipt for
 * wallets that meet the conditions. Wallets that do not meet them fall through
 * to the original payment method.
 *
 * Supports four condition types: token_balance, nft_ownership, eas_attestation,
 * and farcaster_id. Conditions can be mixed in a single call.
 *
 * The attestation is ECDSA P-256 signed and verifiable offline via the public
 * JWKS at https://insumermodel.com/.well-known/jwks.json.
 *
 * @example
 * ```ts
 * import { conditionGate } from '@insumermodel/mppx-condition-gate'
 *
 * const gated = conditionGate(tempoCharge, {
 *   conditions: [
 *     { type: 'eas_attestation', template: 'coinbase_verified_account', chainId: 8453 },
 *     { type: 'farcaster_id' },
 *   ],
 *   matchMode: 'any',
 * })
 *
 * const mppx = Mppx.create({ methods: [gated] })
 * ```
 */
export function conditionGate(
  server: Method.AnyServer,
  options: ConditionGateOptions,
): Method.AnyServer {
  const { conditions, matchMode = 'any', cacheTtlSeconds = 300 } = options

  const originalVerify = server.verify

  const gatedVerify: typeof originalVerify = async (params: any) => {
    const credential = params.credential as { source?: string }
    const source = credential.source

    // No DID → fall through to payment
    if (!source) return originalVerify(params)

    // Determine wallet type and address
    let wallet: string | null = null
    let walletType: 'evm' | 'solana' | 'xrpl' | 'bitcoin' = 'evm'

    wallet = parseDid(source)
    if (!wallet) {
      wallet = parseSolanaDid(source)
      if (wallet) walletType = 'solana'
    }
    if (!wallet) {
      wallet = parseXrplDid(source)
      if (wallet) walletType = 'xrpl'
    }
    if (!wallet) {
      wallet = parseBitcoinDid(source)
      if (wallet) walletType = 'bitcoin'
    }

    // Unparseable DID → fall through to payment
    if (!wallet) return originalVerify(params)

    // Check cache
    const key = cacheKey(wallet, conditions)
    const cached = cache.get(key)
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.pass) {
        return {
          method: server.name,
          reference: `condition-gate:free:${cached.attestationId}`,
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      }
      // Cached non-holder → fall through
      return originalVerify(params)
    }

    // Call InsumerAPI
    try {
      const result = await callAttest(wallet, walletType, conditions, options)
      const attestation = result.data.attestation

      // Determine pass based on matchMode
      let pass: boolean
      if (matchMode === 'all') {
        pass = attestation.pass // all conditions must be met
      } else {
        // "any" — at least one condition met
        pass = attestation.results.some((r) => r.met)
      }

      // Cache the result
      cache.set(key, {
        pass,
        attestationId: attestation.id,
        expiresAt: Date.now() + cacheTtlSeconds * 1000,
      })

      if (pass) {
        return {
          method: server.name,
          reference: `condition-gate:free:${attestation.id}`,
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      }
    } catch {
      // Attestation API error → fall through to payment (fail open)
    }

    return originalVerify(params)
  }

  return {
    ...server,
    verify: gatedVerify,
  }
}
