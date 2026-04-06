import type { Method, Receipt } from 'mppx'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type TokenCondition = {
  /** Token or NFT contract address. For XRPL native XRP, use "native". */
  contractAddress: string
  /**
   * Chain identifier.
   * EVM chain ID (number), "solana", "xrpl", or "bitcoin".
   */
  chainId: number | 'solana' | 'xrpl' | 'bitcoin'
  /** "token_balance" or "nft_ownership". */
  type: 'token_balance' | 'nft_ownership'
  /** Minimum balance for token_balance conditions. Defaults to 1. */
  threshold?: number
  /** Token decimals (auto-detected on most EVM chains if omitted). */
  decimals?: number
  /** Human-readable label (max 100 chars). */
  label?: string
  /** XRPL currency code (e.g. "USD", "RLUSD"). Only for XRPL trust-line tokens. */
  currency?: string
  /** XRPL NFT taxon filter. Only for XRPL nft_ownership. */
  taxon?: number
}

export type TokenGateOptions = {
  /** InsumerAPI key. Falls back to INSUMER_API_KEY env var. */
  apiKey?: string
  /** One or more token/NFT conditions to check. */
  conditions: TokenCondition[]
  /** Whether the payer must satisfy "any" (default) or "all" conditions. */
  matchMode?: 'any' | 'all'
  /** In-memory cache TTL in seconds. Defaults to 300 (5 minutes). */
  cacheTtlSeconds?: number
  /**
   * InsumerAPI base URL. Defaults to "https://api.insumermodel.com".
   * Override for testing or self-hosted deployments.
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

function cacheKey(address: string, conditions: TokenCondition[]): string {
  const sorted = [...conditions].sort((a, b) => {
    const ca = `${a.chainId}:${a.contractAddress}`.toLowerCase()
    const cb = `${b.chainId}:${b.contractAddress}`.toLowerCase()
    return ca < cb ? -1 : ca > cb ? 1 : 0
  })
  return `${address.toLowerCase()}:${JSON.stringify(sorted)}`
}

/** Clear the in-memory ownership cache. Useful in tests. */
export function clearTokenGateCache(): void {
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

/**
 * Extracts a Solana address from a `did:pkh:solana:{chainId}:{address}` string.
 */
export function parseSolanaDid(source: string): string | null {
  const parts = source.split(':')
  if (parts.length !== 5) return null
  if (parts[0] !== 'did' || parts[1] !== 'pkh' || parts[2] !== 'solana') return null
  return parts[4] || null
}

/**
 * Extracts an XRPL address from a `did:pkh:xrpl:{chainId}:{address}` string.
 */
export function parsXrplDid(source: string): string | null {
  const parts = source.split(':')
  if (parts.length !== 5) return null
  if (parts[0] !== 'did' || parts[1] !== 'pkh' || parts[2] !== 'xrpl') return null
  const address = parts[4]
  if (!address || !address.startsWith('r')) return null
  return address
}

/**
 * Extracts a Bitcoin address from a `did:pkh:bip122:{chainId}:{address}` string.
 */
export function parseBitcoinDid(source: string): string | null {
  const parts = source.split(':')
  if (parts.length !== 5) return null
  if (parts[0] !== 'did' || parts[1] !== 'pkh' || parts[2] !== 'bip122') return null
  return parts[4] || null
}

// ---------------------------------------------------------------------------
// InsumerAPI call
// ---------------------------------------------------------------------------

async function callAttest(
  wallet: string,
  walletType: 'evm' | 'solana' | 'xrpl' | 'bitcoin',
  conditions: TokenCondition[],
  options: Pick<TokenGateOptions, 'apiKey' | 'apiBaseUrl' | 'jwt'>,
): Promise<InsumerAttestation> {
  const apiKey = options.apiKey || process.env.INSUMER_API_KEY
  if (!apiKey) {
    throw new Error(
      'mppx-token-gate: Missing API key. Pass apiKey in options or set INSUMER_API_KEY env var. ' +
      'Get a free key: POST https://api.insumermodel.com/v1/keys/create',
    )
  }

  const baseUrl = options.apiBaseUrl || 'https://api.insumermodel.com'

  const body: Record<string, unknown> = {
    conditions: conditions.map((c) => {
      const cond: Record<string, unknown> = {
        type: c.type,
        contractAddress: c.contractAddress,
        chainId: c.chainId,
      }
      if (c.type === 'token_balance') {
        cond.threshold = c.threshold ?? 1
      }
      if (c.decimals !== undefined) cond.decimals = c.decimals
      if (c.label) cond.label = c.label
      if (c.currency) cond.currency = c.currency
      if (c.taxon !== undefined) cond.taxon = c.taxon
      return cond
    }),
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
    throw new Error(`mppx-token-gate: Attestation failed — ${msg}`)
  }
  return data
}

// ---------------------------------------------------------------------------
// tokenGate wrapper
// ---------------------------------------------------------------------------

/**
 * Wraps an mppx `Method.Server` to grant free access to token holders.
 *
 * Extracts the payer address from `credential.source` (DID), calls InsumerAPI
 * to check token/NFT ownership across 33 chains, and returns a free receipt
 * for holders. Non-holders fall through to the original payment method.
 *
 * The attestation is ECDSA P-256 signed and verifiable offline via JWKS.
 *
 * @example
 * ```ts
 * import { tokenGate } from 'mppx-token-gate'
 *
 * const gatedCharge = tokenGate(tempoCharge, {
 *   conditions: [{
 *     type: 'nft_ownership',
 *     contractAddress: '0xYourNFT',
 *     chainId: 8453,
 *   }],
 * })
 *
 * const mppx = Mppx.create({ methods: [gatedCharge] })
 * ```
 */
export function tokenGate(
  server: Method.AnyServer,
  options: TokenGateOptions,
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
      wallet = parsXrplDid(source)
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
          reference: `token-gate:free:${cached.attestationId}`,
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
          reference: `token-gate:free:${attestation.id}`,
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
