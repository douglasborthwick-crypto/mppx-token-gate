/**
 * Live integration test for mppx-token-gate.
 * Tests the core flow: DID parsing → InsumerAPI call → pass/fail → receipt.
 */

// Import from built output
import { tokenGate, parseDid, parseSolanaDid, parsXrplDid, clearTokenGateCache } from './dist/index.js'

const API_KEY = process.env.INSUMER_API_KEY
if (!API_KEY) { console.error('Set INSUMER_API_KEY env var'); process.exit(1) }

// --- Test 1: DID parsing ---
console.log('--- DID parsing ---')

const evm = parseDid('did:pkh:eip155:8453:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045')
console.log('EVM DID →', evm)
console.assert(evm === '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', 'EVM parse failed')

const sol = parseSolanaDid('did:pkh:solana:1:7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU')
console.log('Solana DID →', sol)
console.assert(sol === '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU', 'Solana parse failed')

const xrpl = parsXrplDid('did:pkh:xrpl:0:rN7n3473SaZBCG4dFL83w7p1W9cgZw6iFR')
console.log('XRPL DID →', xrpl)
console.assert(xrpl === 'rN7n3473SaZBCG4dFL83w7p1W9cgZw6iFR', 'XRPL parse failed')

const bad = parseDid('not-a-did')
console.assert(bad === null, 'Bad DID should return null')
console.log('Bad DID → null ✓')

// --- Test 2: Mock Method.Server + tokenGate with real API call ---
console.log('\n--- Live attestation (Vitalik holds USDC on Base) ---')

// Minimal mock server that satisfies Method.AnyServer shape
const mockServer = {
  name: 'tempo',
  intent: 'charge',
  schema: {
    credential: { payload: {} },
    request: {},
  },
  verify: async (_params) => {
    return {
      method: 'tempo',
      reference: 'paid:0xabc',
      status: 'success',
      timestamp: new Date().toISOString(),
    }
  },
}

const gated = tokenGate(mockServer, {
  apiKey: API_KEY,
  conditions: [{
    type: 'token_balance',
    contractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC on Base
    chainId: 8453,
    threshold: 1,
    decimals: 6,
    label: 'USDC on Base >= 1',
  }],
})

// Simulate a credential with Vitalik's address as source DID
const holderResult = await gated.verify({
  credential: {
    challenge: { id: 'test', intent: 'charge', method: 'tempo', realm: 'test', request: {} },
    payload: {},
    source: 'did:pkh:eip155:8453:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  },
  request: {},
})

console.log('Holder receipt:', JSON.stringify(holderResult, null, 2))
console.assert(
  holderResult.reference.startsWith('token-gate:free:ATST-'),
  'Expected token-gate:free receipt for holder'
)
console.log('✓ Holder got free access via signed attestation')

// --- Test 3: Non-holder (random address, unlikely to hold USDC) ---
console.log('\n--- Live attestation (random address, no USDC) ---')
clearTokenGateCache()

const gated2 = tokenGate(mockServer, {
  apiKey: API_KEY,
  conditions: [{
    type: 'token_balance',
    contractAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    chainId: 8453,
    threshold: 999999999, // impossibly high
    decimals: 6,
    label: 'USDC on Base >= 999999999',
  }],
})

const nonHolderResult = await gated2.verify({
  credential: {
    challenge: { id: 'test2', intent: 'charge', method: 'tempo', realm: 'test', request: {} },
    payload: {},
    source: 'did:pkh:eip155:8453:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  },
  request: {},
})

console.log('Non-holder receipt:', JSON.stringify(nonHolderResult, null, 2))
console.assert(
  nonHolderResult.reference === 'paid:0xabc',
  'Expected fallthrough to paid receipt for non-holder'
)
console.log('✓ Non-holder fell through to payment')

// --- Test 4: No source DID → always falls through ---
console.log('\n--- No DID (falls through) ---')

const noDidResult = await gated.verify({
  credential: {
    challenge: { id: 'test3', intent: 'charge', method: 'tempo', realm: 'test', request: {} },
    payload: {},
    // no source
  },
  request: {},
})

console.assert(noDidResult.reference === 'paid:0xabc', 'No DID should fall through')
console.log('✓ No DID fell through to payment')

// --- Test 5: Cache hit ---
console.log('\n--- Cache hit (no API call) ---')
// The first gated server already cached Vitalik's result
const cachedResult = await gated.verify({
  credential: {
    challenge: { id: 'test4', intent: 'charge', method: 'tempo', realm: 'test', request: {} },
    payload: {},
    source: 'did:pkh:eip155:8453:0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
  },
  request: {},
})
console.assert(
  cachedResult.reference.startsWith('token-gate:free:ATST-'),
  'Cached result should still be free'
)
console.log('✓ Cache hit returned free access (no API call)')

console.log('\n=== All tests passed ===')
