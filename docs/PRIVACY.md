# Privacy, data protection, and residency (GDPR + Swiss FADP)

This document describes how the SMARCH service handles personal data, international transfers, retention, and user rights. Operators, engineers, and privacy reviewers need it when they change data flows or answer a compliance request. Read it before introducing a processor, storage region, moderation path, or retention rule. Remember that the implemented data flow and the written register must agree.

This documents how the SMARCH space processes personal data and how it meets EU GDPR
and Swiss revFADP (revDSG) requirements. It is the processor register + transfer basis
that the moderation and storage code implements. Pair it with `docs/TRANSPARENCY.md`
(what moderation blocks) and `docs/MODERATION.md` (how moderation works).

## Roles
- Controller: the SMARCH operator.
- Processors / sub-processors:
  - **WorkOS** - authentication (identity, session). EU data residency available.
  - **Netlify** - hosting + Blobs storage of signs, images, profiles, presence, analytics, edits.
  - **Moderation provider** - selected by `MOD_PROVIDER`:
    - `fal` (default): fal.ai, model Google Gemini. US processor. Requires SCCs + the
      EU-US Data Privacy Framework basis + a signed DPA before EU production use.
    - `mistral-eu`: Mistral AI, EU-hosted. Keeps moderation inside the EU (no US transfer).
    - `disabled-strict`: no AI processor; everything is blocked (fail-closed).

## Personal data processed + legal basis (GDPR Art. 6)
| Data | Purpose | Basis |
|---|---|---|
| Auth identity + session | let a builder sign in and own their builds | contract (Art. 6(1)(b)) |
| Project signs (title, text, link) | public sharing | consent (Art. 6(1)(a)) |
| Uploaded images | public sharing | consent; images may show faces = special category (Art. 9) - explicit consent + image moderation |
| Content sent to the moderation provider | keep the space safe/lawful | legitimate interest (Art. 6(1)(f)) + Art. 9 for images |
| Presence (position, name) | live multiplayer, opt-in | consent; ephemeral (see retention) |
| Profile (name, color, bio) | attribution | consent |
| Analytics (event counts) | owner build stats | legitimate interest, aggregated |
| Attribution `by` maps | credit bricks | legitimate interest |

## International transfers
- `MOD_PROVIDER=mistral-eu` + Netlify Blobs EU region + WorkOS EU residency = **no personal
  data leaves the EU/EEA**. This is the recommended EU/Swiss production configuration.
- `MOD_PROVIDER=fal` transfers sign text + images to the US - only permissible with SCCs +
  DPF + DPA in place; document them here before enabling in EU production.

## Retention
- Presence: ephemeral, ~15s freshness, TTL-pruned. Moderation cache: 30 days (hashes, not raw PII).
- Analytics: 30-day daily buckets, aggregated. Signs/images/profiles: until the builder erases them.

## Data-subject rights
- **Access (Art. 15):** `GET /api/march-erase` returns a manifest of the caller's held data.
- **Erasure (Art. 17):** `POST /api/march-erase` deletes signs/profile/presence/analytics/tokens
  and anonymizes shared-brick attribution to `removed` (others' bricks are not deleted).
- Rectification: edit profile/signs. Objection/restriction: stop submitting; erase.

## Swiss revFADP (revDSG)
The above aligns with the revised Swiss FADP (in force since Sep 2023): processor register,
data minimization, transparency, and data-subject rights. Supervisory authority: EDOEB (FDPIC).
Swiss users are covered by the same EU-residency configuration.

## Configuration knobs (no redeploy)
`MOD_PROVIDER`, `MISTRAL_KEY`, `FAL_KEY` (env) + the `march-config` blob `moderation` key
(model, policy text, maxLen, timeoutMs, retries). Policy can be tuned by editing the blob;
no code change or redeploy required.
