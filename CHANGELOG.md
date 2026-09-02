# Changelog

## 3.0.2 (2026-09-02)

- Enhances the README so it references only endpoints the gate uses: the free-receipt reference carries the `id` of the attestation returned by `POST /v1/attest`, and the gate keeps only `id` and `pass` in its cache.
- Adds the post-quantum companion fields (`pqSig`, `pqKid`, `pqJwt`) to the `InsumerAttestation` type and notes that every attest response carries them since 2026-09-01.
- Deprecates the `jwt` option: it is still accepted for type compatibility but no longer sent, since the gate returns only an mppx receipt and never surfaced the token. Callers who need `jwt`/`pqJwt` call `POST /v1/attest` with `format: "jwt"` directly.
