# Acme Studio Security Documentation

This document records the security controls and incident process for Acme Studio services. Engineers, operators, and reviewers need it whenever they touch authentication, storage, network boundaries, or sensitive data. Read it before implementation and during release review or incident response. Remember that each security claim needs an enforced control and evidence from the real boundary.

## API Security Requirements

### Authentication
- All API endpoints require Clerk JWT authentication via `verifyClerkToken()`
- JWTs are cryptographically verified, not just decoded
- Failed auth attempts are tracked and IPs are blocked after 10 failures in 15 minutes

### Rate Limiting
- **IP-based**: Pre-auth protection via `ipRateLimitMiddleware()`
  - Global: 100 req/min per IP
  - Auth endpoints: 10 req/5min per IP
  - Expensive operations: 20 req/min per IP
- **User-based**: Post-auth limiting via `rateLimitMiddleware()`
  - Tiered limits: free < premium < admin
  - Configurable per-endpoint via `rate_limit_config` table

### Encryption
- API keys encrypted with AES-256-GCM
- Version 3 format includes:
  - Random 16-byte salt per key
  - 310,000 PBKDF2 iterations
  - AAD (Additional Authenticated Data) binding to userId + purpose
- Backward compatible with V1/V2 formats

### Session/User Binding (Task #86)
- Authenticated userId from Clerk JWT is passed to all decrypt operations
- Key derivation uses `${secret}:${userId}` - wrong user = wrong key
- AAD includes userId - tampered userId = auth tag verification fails
- User A cannot decrypt User B's keys even if they access the encrypted blob
- See: `decryptApiKey(key, secret, userId)` in all proxy functions

### CORS & Origin Validation
- Strict origin allowlist in `security-utils.ts`
- Pattern matching for Netlify deploy previews
- Server-to-server requests allowed (no origin header)

### HTTPS Enforcement
- All production requests must be HTTPS
- `enforceHttps()` middleware on all proxy functions
- HSTS headers added to responses

### Webhook Security
- HMAC-SHA256 signature verification via `webhook-verify.ts`
- Timestamp validation (optional, prevents replay attacks)
- Constant-time signature comparison

### Storage Security
- User-specific bucket policies via `get_storage_path_user_id()`
- Users can only access their own files
- Service role bypass for backend operations
- Admin override policies

### Input Validation
- Request body size limits (1MB default, 10MB uploads)
- JSON parsing with error handling
- Field sanitization via `sanitizeInput()`

## Incident Response Procedure

### 1. Detection
- Monitor `security_audit_log` table for suspicious events
- Monitor `rate_limit_events` for blocked requests
- Check `failed_auth_attempts` for credential stuffing

### 2. Containment
- IP blocking via `isIpBlocked()` triggers automatically
- Rate limits escalate automatically
- Manual: Set `is_active = false` on compromised API keys

### 3. Investigation
- Query `security_audit_log` for timeline
- Check `admin_activity_log` for admin actions
- Review function logs in Supabase dashboard

### 4. Recovery
- Rotate exposed secrets:
  - `ENCRYPTION_SECRET` - requires re-encryption of all keys
  - `SUPABASE_ANON_KEY` - update all clients
  - `CLERK_SECRET_KEY` - update in Clerk dashboard
- Deploy updated functions
- Clear rate limit blocks if legitimate users affected

### 5. Post-Incident
- Document incident in this file
- Update detection rules
- Add new patterns to gitleaks config

## Secret Scanning
- GitHub workflow runs gitleaks on push/PR
- Custom rules in `.gitleaks.toml`
- npm audit runs for dependency vulnerabilities

## Monitoring
- Rate limit events in `rate_limit_events` table
- Security events in `security_audit_log` table
- Admin dashboard at `/admin/rate-limits`

## Exposed Secrets (Action Required)

**Task #93: Supabase Anon Key Rotation**
1. Go to Supabase Dashboard → Project Settings → API
2. Click "Rotate anon key"
3. Update `.env.local` with new `VITE_SUPABASE_ANON_KEY`
4. Update Supabase Edge Functions secrets
5. Redeploy frontend

**Task #94: Clerk Dev Secret Key Rotation**
1. Go to Clerk Dashboard → API Keys
2. Create new secret key
3. Update `.env.local` with new `CLERK_SECRET_KEY`
4. Update Supabase Edge Functions secret `CLERK_SECRET_KEY`
5. Redeploy edge functions

After rotation:
- [ ] Test user authentication flow
- [ ] Verify all BYOK proxy functions work
- [ ] Check rate limiting dashboard
3. CI/CD secrets

## Security Contacts
- Report vulnerabilities to: security@acme-studio.app
- Emergency: Contact repository owner directly
