import fs from 'node:fs';
import crypto from 'node:crypto';
import { verifySealSignature, publicKeyId } from './provenance-seal.ts';

type EntitlementRecord = {
  brick_id?: string;
  licensee?: string;
  issued_at?: string;
  expires_at?: string | null;
  nonce?: string;
  public_key?: string;
  signature?: string;
  key_id?: string;
};

type CommercialManifest = {
  license_tier?: string;
  commercial_terms?: string;
  brick?: { license_tier?: string; commercial_terms?: string };
};

export function entitlementPayload(record: EntitlementRecord): string {
  return JSON.stringify({
    brick_id: String(record.brick_id || ''),
    licensee: String(record.licensee || ''),
    issued_at: String(record.issued_at || ''),
    expires_at: record.expires_at ? String(record.expires_at) : null,
    nonce: String(record.nonce || ''),
  });
}

export function verifyCommercialEntitlement({ manifest, brickId, licensee, entitlementFile, trustedKeysFile }: {
  manifest: CommercialManifest | null | undefined;
  brickId: string;
  licensee?: string | null;
  entitlementFile?: string | null;
  trustedKeysFile?: string | null;
}) {
  const tier = manifest?.license_tier || manifest?.brick?.license_tier || 'open';
  if (tier !== 'commercial') return { required: false, ok: true };
  const purchase = manifest?.commercial_terms || manifest?.brick?.commercial_terms || 'the commercial terms URI';
  const fail = (reason: string): never => {
    const error = new Error(`commercial brick "${brickId}" requires a valid entitlement for "${licensee || 'the licensee'}": ${reason}. Purchase or request access at ${purchase}`);
    (error as Error & { code?: string }).code = 'COMMERCIAL_ENTITLEMENT_REQUIRED';
    throw error;
  };
  if (!licensee) return fail('pass --licensee <id>');
  const entitlementPath = entitlementFile ?? fail('pass --entitlement <signed-json>');
  if (!fs.existsSync(entitlementPath)) return fail('pass --entitlement <signed-json>');
  const record: EntitlementRecord = (() => {
    try { return JSON.parse(fs.readFileSync(entitlementPath, 'utf8')) as EntitlementRecord; }
    catch { return fail('entitlement JSON is unreadable'); }
  })();
  if (record.brick_id !== brickId) fail('brick_id does not match');
  if (record.licensee !== licensee) fail('licensee does not match');
  if (record.expires_at && Date.parse(record.expires_at) <= Date.now()) fail('entitlement expired');
  const publicKey = record.public_key ?? fail('signature evidence is missing');
  const signature = record.signature ?? fail('signature evidence is missing');
  const keyId = publicKeyId(publicKey);
  if (record.key_id && record.key_id !== keyId) fail('key_id does not match the public key');
  if (trustedKeysFile) {
    const trusted: string[] = (() => {
      try { return (JSON.parse(fs.readFileSync(trustedKeysFile, 'utf8')) as { key_ids?: string[] }).key_ids || []; }
      catch { return fail('trusted key registry is unreadable'); }
    })();
    if (!trusted.includes(keyId)) fail(`signing key ${keyId} is not trusted`);
  }
  if (!verifySealSignature(entitlementPayload(record), signature, publicKey)) fail('signature is invalid or entitlement was tampered');
  return { required: true, ok: true, key_id: keyId, entitlement_hash: crypto.createHash('sha256').update(fs.readFileSync(entitlementPath)).digest('hex') };
}
