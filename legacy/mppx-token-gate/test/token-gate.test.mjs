import test from 'node:test'
import assert from 'node:assert/strict'
import { tokenGate } from '../dist/index.js'

const QUALIFYING = '0x1111111111111111111111111111111111111111'
const CONDITIONS = [{ type: 'token_balance', contractAddress: '0xTOKEN', chainId: 8453 }]

// If anything still called /v1/attest, this would report a passing wallet.
globalThis.fetch = async () => ({
  ok: true, status: 200,
  json: async () => ({ ok: true, data: { attestation: { id: 'ATST-TEST', pass: true, results: [{ met: true }] } } }),
})

function makeServer() {
  const calls = { verify: 0 }
  return {
    calls,
    server: {
      name: 'test',
      verify: async () => { calls.verify++; return { method: 'test', reference: 'PAID', status: 'success', timestamp: 'x' } },
    },
  }
}

test('REGRESSION (GHSA-jg6q-3qfh-r9f8): a qualifying wallet in credential.source gets NO free receipt', async () => {
  const { server, calls } = makeServer()
  const gated = tokenGate(server, { apiKey: 'k', conditions: CONDITIONS })

  const result = await gated.verify({ credential: { source: `did:pkh:eip155:8453:${QUALIFYING}` } })

  assert.equal(result.reference, 'PAID', `expected paid path, got ${result.reference}`)
  assert.equal(calls.verify, 1, 'the payment verifier must run')
})

test('no free receipt is reachable by any DID family', async () => {
  for (const source of [
    `did:pkh:eip155:8453:${QUALIFYING}`,
    'did:pkh:solana:mainnet:SoL123',
    'did:pkh:xrpl:0:rABC',
    'did:pkh:bip122:0:bc1q',
    undefined,
  ]) {
    const { server } = makeServer()
    const gated = tokenGate(server, { apiKey: 'k', conditions: CONDITIONS })
    const result = await gated.verify({ credential: { source } })
    assert.equal(result.reference, 'PAID', `free receipt leaked for source=${source}`)
  }
})

test('the wrapped method is returned unchanged', async () => {
  const { server } = makeServer()
  const gated = tokenGate(server, { apiKey: 'k', conditions: CONDITIONS })
  assert.equal(gated, server, 'gate must delegate entirely')
})
