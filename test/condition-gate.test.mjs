import test from 'node:test'
import assert from 'node:assert/strict'
import { conditionGate, normalizeProvenPayer, clearConditionGateCache } from '../dist/index.js'

const QUALIFYING = '0x1111111111111111111111111111111111111111'
const CONDITIONS = [{ type: 'token_balance', contractAddress: '0xTOKEN', chainId: 8453 }]

/** Stub /v1/attest. `met` decides pass/fail; `fail` makes the call error. */
function stubAttest({ met = true, fail = false } = {}) {
  globalThis.fetch = async () => {
    if (fail) return { ok: false, status: 500, json: async () => ({ ok: false, error: { message: 'boom' } }) }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        data: { attestation: { id: 'ATST-TEST', pass: met, results: [{ met }] } },
      }),
    }
  }
}

/** A method server. `validate` present unless `legacy`. */
function makeServer({ legacy = false, details = { payer: QUALIFYING } } = {}) {
  const calls = { verify: 0, broadcast: 0, validate: 0 }
  const paidReceipt = { method: 'test', reference: 'PAID', status: 'success', timestamp: 'x' }
  const server = {
    name: 'test',
    verify: async () => { calls.verify++; return paidReceipt },
  }
  if (!legacy) {
    server.validate = async () => { calls.validate++; return { details } }
    server.broadcast = async () => { calls.broadcast++; return paidReceipt }
  }
  return { server, calls }
}

const paid = (r) => r.reference === 'PAID'
const free = (r) => typeof r.reference === 'string' && r.reference.startsWith('condition-gate:free:')

test.beforeEach(() => { clearConditionGateCache() })

// --- The reported vulnerability (GHSA-jg6q-3qfh-r9f8) -----------------------

test('REGRESSION: a qualifying wallet named in credential.source with no ownership proof does NOT get a free receipt', async () => {
  stubAttest({ met: true })
  // No provenPayer resolver configured — the pre-3.0.0 gate would have read
  // credential.source here and granted free access.
  const { server, calls } = makeServer()
  const gated = conditionGate(server, { apiKey: 'k', conditions: CONDITIONS })

  const result = await gated.verify({
    credential: { source: `did:pkh:eip155:8453:${QUALIFYING}` },
  })

  assert.ok(paid(result), 'must fall through to the paid path')
  assert.equal(calls.verify, 1, 'the payment verifier must run')
})

test('REGRESSION: credential.source is never consulted even when a resolver exists', async () => {
  stubAttest({ met: true })
  // Resolver sees only `details`; details carry NO payer, so no free access —
  // despite a qualifying wallet sitting in credential.source.
  const { server, calls } = makeServer({ details: {} })
  const gated = conditionGate(server, {
    apiKey: 'k',
    conditions: CONDITIONS,
    provenPayer: (details) => details?.payer ?? null,
  })

  const result = await gated.verify({
    credential: { source: `did:pkh:eip155:8453:${QUALIFYING}` },
  })

  assert.ok(paid(result))
  assert.equal(calls.verify, 1)
})

test('the resolver receives ONLY validation details — not the credential', async () => {
  stubAttest({ met: true })
  let seen = 'unset'
  const { server } = makeServer({ details: { payer: QUALIFYING, marker: 'DETAILS' } })
  const gated = conditionGate(server, {
    apiKey: 'k',
    conditions: CONDITIONS,
    provenPayer: (arg) => { seen = arg; return arg.payer },
  })

  await gated.verify({ credential: { source: `did:pkh:eip155:8453:${QUALIFYING}` } })

  assert.equal(seen.marker, 'DETAILS')
  assert.equal(seen.credential, undefined, 'resolver must not receive the credential')
  assert.equal(seen.source, undefined, 'resolver must not receive the declared source')
})

// --- Fail-closed paths ------------------------------------------------------

test('no validate hook (legacy verify-only method) never grants free access', async () => {
  stubAttest({ met: true })
  const { server, calls } = makeServer({ legacy: true })
  const gated = conditionGate(server, {
    apiKey: 'k',
    conditions: CONDITIONS,
    provenPayer: () => QUALIFYING,
  })

  const result = await gated.verify({ credential: { source: 'x' } })
  assert.ok(paid(result), 'no safe pre-check exists → paid path')
  assert.equal(calls.verify, 1)
})

test('resolver returning null → paid path', async () => {
  stubAttest({ met: true })
  const { server, calls } = makeServer()
  const gated = conditionGate(server, {
    apiKey: 'k', conditions: CONDITIONS, provenPayer: () => null,
  })
  assert.ok(paid(await gated.verify({ credential: {} })))
  assert.equal(calls.verify, 1)
})

test('resolver throwing → paid path', async () => {
  stubAttest({ met: true })
  const { server } = makeServer()
  const gated = conditionGate(server, {
    apiKey: 'k', conditions: CONDITIONS,
    provenPayer: () => { throw new Error('nope') },
  })
  assert.ok(paid(await gated.verify({ credential: {} })))
})

test('validate throwing → paid path', async () => {
  stubAttest({ met: true })
  const { server } = makeServer()
  server.validate = async () => { throw new Error('bad credential') }
  const gated = conditionGate(server, {
    apiKey: 'k', conditions: CONDITIONS, provenPayer: () => QUALIFYING,
  })
  assert.ok(paid(await gated.verify({ credential: {} })))
})

test('attestation API error → paid path (fail closed)', async () => {
  stubAttest({ fail: true })
  const { server } = makeServer()
  const gated = conditionGate(server, {
    apiKey: 'k', conditions: CONDITIONS, provenPayer: (d) => d.payer,
  })
  assert.ok(paid(await gated.verify({ credential: {} })))
})

test('conditions not met → paid path', async () => {
  stubAttest({ met: false })
  const { server } = makeServer()
  const gated = conditionGate(server, {
    apiKey: 'k', conditions: CONDITIONS, provenPayer: (d) => d.payer,
  })
  assert.ok(paid(await gated.verify({ credential: {} })))
})

// --- The happy path still works --------------------------------------------

test('proven payer + conditions met → free receipt, payment never runs', async () => {
  stubAttest({ met: true })
  const { server, calls } = makeServer()
  const gated = conditionGate(server, {
    apiKey: 'k', conditions: CONDITIONS, provenPayer: (d) => d.payer,
  })

  const result = await gated.verify({ credential: {} })
  assert.ok(free(result), `expected free receipt, got ${result.reference}`)
  assert.equal(calls.verify, 0, 'payment must NOT run')
  assert.equal(calls.validate, 1)
})

test('broadcast is gated too, and settlement is skipped on free access', async () => {
  stubAttest({ met: true })
  const { server, calls } = makeServer()
  const gated = conditionGate(server, {
    apiKey: 'k', conditions: CONDITIONS, provenPayer: (d) => d.payer,
  })

  const result = await gated.broadcast({ credential: {} })
  assert.ok(free(result))
  assert.equal(calls.broadcast, 0, 'settlement must NOT run')
})

test('cached pass still requires a proven payer on the later request', async () => {
  stubAttest({ met: true })
  const warm = makeServer()
  const gatedWarm = conditionGate(warm.server, {
    apiKey: 'k', conditions: CONDITIONS, provenPayer: (d) => d.payer,
  })
  assert.ok(free(await gatedWarm.verify({ credential: {} })), 'warm the cache')

  // Same wallet is now cached as passing. A request that proves nothing must
  // still take the paid path.
  const cold = makeServer({ details: {} })
  const gatedCold = conditionGate(cold.server, {
    apiKey: 'k', conditions: CONDITIONS, provenPayer: (d) => d?.payer ?? null,
  })
  const result = await gatedCold.verify({
    credential: { source: `did:pkh:eip155:8453:${QUALIFYING}` },
  })
  assert.ok(paid(result), 'cache must not be reachable without a proven payer')
  assert.equal(cold.calls.verify, 1)
})

// --- normalizeProvenPayer ---------------------------------------------------

test('normalizeProvenPayer resolves DIDs and bare EVM, rejects the ambiguous', () => {
  assert.deepEqual(normalizeProvenPayer(`did:pkh:eip155:8453:${QUALIFYING}`), { address: QUALIFYING, type: 'evm' })
  assert.deepEqual(normalizeProvenPayer('did:pkh:solana:mainnet:SoL123'), { address: 'SoL123', type: 'solana' })
  assert.deepEqual(normalizeProvenPayer('did:pkh:xrpl:0:rABC'), { address: 'rABC', type: 'xrpl' })
  assert.deepEqual(normalizeProvenPayer('did:pkh:bip122:0:bc1q'), { address: 'bc1q', type: 'bitcoin' })
  assert.deepEqual(normalizeProvenPayer(QUALIFYING), { address: QUALIFYING, type: 'evm' })
  assert.deepEqual(normalizeProvenPayer({ address: 'SoL123', type: 'solana' }), { address: 'SoL123', type: 'solana' })

  assert.equal(normalizeProvenPayer(null), null)
  assert.equal(normalizeProvenPayer(undefined), null)
  assert.equal(normalizeProvenPayer(''), null)
  assert.equal(normalizeProvenPayer('SoL123'), null, 'bare non-EVM is ambiguous → reject')
  assert.equal(normalizeProvenPayer({ address: 'x' }), null, 'object form needs an explicit type')
})
