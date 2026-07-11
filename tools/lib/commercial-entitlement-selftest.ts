#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateSealKeypair, signSealHead } from './provenance-seal.ts';
import { entitlementPayload, verifyCommercialEntitlement } from './commercial-entitlement.ts';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sma-entitlement-'));
try {
  const keys = generateSealKeypair();
  const record: {
    brick_id: string; licensee: string; issued_at: string; nonce: string;
    public_key: string; key_id: string; signature?: string;
  } = { brick_id: 'paid.example', licensee: 'acme', issued_at: new Date().toISOString(), nonce: 'fixture', public_key: keys.publicPem, key_id: keys.key_id };
  record.signature = signSealHead(entitlementPayload(record), keys.privatePem);
  const entitlementFile = path.join(dir, 'entitlement.json');
  const trustedKeysFile = path.join(dir, 'trusted.json');
  fs.writeFileSync(entitlementFile, JSON.stringify(record));
  fs.writeFileSync(trustedKeysFile, JSON.stringify({ key_ids: [keys.key_id] }));
  const manifest = { brick: { license_tier: 'commercial', commercial_terms: 'https://example.test/buy' } };
  assert.equal(verifyCommercialEntitlement({ manifest, brickId: 'paid.example', licensee: 'acme', entitlementFile, trustedKeysFile }).ok, true);
  assert.throws(() => verifyCommercialEntitlement({ manifest, brickId: 'paid.example', licensee: 'acme', entitlementFile: '', trustedKeysFile }), /requires a valid entitlement/);
  fs.writeFileSync(entitlementFile, JSON.stringify({ ...record, licensee: 'tampered' }));
  assert.throws(() => verifyCommercialEntitlement({ manifest, brickId: 'paid.example', licensee: 'tampered', entitlementFile, trustedKeysFile }), /tampered|signature is invalid/);
  console.log('commercial entitlement selftest: ok');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
