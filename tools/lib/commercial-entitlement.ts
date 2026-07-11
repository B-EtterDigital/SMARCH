import fs from 'node:fs';
import crypto from 'node:crypto';
import { verifySealSignature, publicKeyId } from './provenance-seal.ts';

export function entitlementPayload(record) {
  return JSON.stringify({
    brick_id: String(record.brick_id || ''),
    licensee: String(record.licensee || ''),
    issued_at: String(record.issued_at || ''),
    expires_at: record.expires_at ? String(record.expires_at) : null,
    nonce: String(record.nonce || ''),
  });
}

export function verifyCommercialEntitlement({ manifest, brickId, licensee, entitlementFile, trustedKeysFile }) {
  const tier = manifest?.license_tier || manifest?.brick?.license_tier || 'open';
  if (tier !== 'commercial') return { required: false, ok: true };
  const purchase = manifest?.commercial_terms || manifest?.brick?.commercial_terms || 'the commercial terms URI';
  const fail = (reason) => {
    const error = new Error(`commercial brick "${brickId}" requires a valid entitlement for "${licensee || 'the licensee'}": ${reason}. Purchase or request access at ${purchase}`);
    (error as Error & { code?: string }).code = 'COMMERCIAL_ENTITLEMENT_REQUIRED';
    throw error;
  };
  if (!licensee) fail('pass --licensee <id>');
  if (!entitlementFile || !fs.existsSync(entitlementFile)) fail('pass --entitlement <signed-json>');
  let record; try { record = JSON.parse(fs.readFileSync(entitlementFile, 'utf8')); } catch { fail('entitlement JSON is unreadable'); }
  if (record.brick_id !== brickId) fail('brick_id does not match');
  if (record.licensee !== licensee) fail('licensee does not match');
  if (record.expires_at && Date.parse(record.expires_at) <= Date.now()) fail('entitlement expired');
  if (!record.public_key || !record.signature) fail('signature evidence is missing');
  const keyId = publicKeyId(record.public_key);
  if (record.key_id && record.key_id !== keyId) fail('key_id does not match the public key');
  if (trustedKeysFile) {
    let trusted; try { trusted = JSON.parse(fs.readFileSync(trustedKeysFile, 'utf8')).key_ids || []; } catch { fail('trusted key registry is unreadable'); }
    if (!trusted.includes(keyId)) fail(`signing key ${keyId} is not trusted`);
  }
  if (!verifySealSignature(entitlementPayload(record), record.signature, record.public_key)) fail('signature is invalid or entitlement was tampered');
  return { required: true, ok: true, key_id: keyId, entitlement_hash: crypto.createHash('sha256').update(fs.readFileSync(entitlementFile)).digest('hex') };
}
