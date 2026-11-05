<!-- Keep changes focused. See CONTRIBUTING.md before opening this pull request. -->

## Summary

<!-- What changes, and why. -->

## Area

<!-- Sync / AI reception / knowledge / accounting / identity / deployment / docs -->

## Behavior change

- [ ] No user-visible behavior change
- [ ] Changes outbound sending, credentials, authorization or financial records
- [ ] Changes a migration, schema or upgrade path
- [ ] Changes only documentation or tooling

## Verification

```
npm run lint
npm run check
```

<!-- Add the affected native suites, e.g. npm run test:upgrade-local, npm run test:portable, npm run test:web:portable -->

Not verified externally (real Ozon delivery, provider pricing, cloud capacity, model quality):

## Safety review

- [ ] Tenant, company, store and product isolation is enforced at the final write, not only at request entry
- [ ] Unknown or unconfirmed outcomes are not retried automatically and are not reported as success
- [ ] Customer content, credentials and raw provider errors stay out of logs, analytics and audit projections
- [ ] New paid or external behavior is opt-in and fails closed without configuration
- [ ] Migrations are additive, or the upgrade/rollback path and tests are described above
- [ ] Documentation and acceptance evidence are updated, with unverified conditions stated

## Migrations and environment

<!-- Migration numbers, new environment variables, rollback constraints, or "none". -->
