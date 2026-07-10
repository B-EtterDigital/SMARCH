# RLS Matrix

Brick:
Date:

| Resource | Actor | Select | Insert | Update | Delete | Notes |
|----------|-------|--------|--------|--------|--------|-------|
| table | anon | no | no | no | no | default deny |
| table | owner | yes | yes | own | own | user scoped |
| table | admin | yes | yes | yes | yes | audited |
| table | service | yes | yes | yes | yes | backend only |

## Negative Tests

- [ ] owner cannot read another owner row
- [ ] anon cannot read private row
- [ ] normal user cannot perform admin action
- [ ] service role is not reachable from client code

