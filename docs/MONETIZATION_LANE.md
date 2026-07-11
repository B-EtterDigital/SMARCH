# Commercial brick lane

SMARCH stays open-core: anything already shipped as open remains open. A new brick may opt into `license_tier: "commercial"` only when it also publishes a `commercial_terms` URI. The license lattice blocks an open canonical composition from depending on that brick unless a curator records an explicit commercial waiver.

## End-to-end flow

1. Tag the new commercial brick without changing the tier of an existing open release.
2. Sell access under the terms at `commercial_terms`.
3. Issue a JSON entitlement containing `brick_id`, `licensee`, `issued_at`, optional `expires_at`, a nonce, the Ed25519 public key and key ID, and a signature over the canonical payload. Use the same Ed25519 provenance-seal key infrastructure; pin accepted key IDs in a trusted-key JSON file.
4. Clone with `node tools/sma-clone.ts --brick <id> --target <dir> --licensee <id> --entitlement <file> --entitlement-trusted-keys <trusted.json> --write`.
5. The clone verifies brick and licensee binding, expiry, trusted key identity, and signature before planning or writing files. Missing, mismatched, expired, untrusted, or tampered evidence fails closed and prints the purchase URI.

The entitlement is authorization evidence, not a secret. Do not put payment credentials, session tokens, or private keys in it.
