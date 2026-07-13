# Subscriptions & Bills

One shared list of everything the household pays for on repeat, with renewal
countdowns, "mark renewed" date rolling, and normalized monthly/yearly totals.

- **Storage:** D1 (`app_subscriptions__subscriptions`)
- **Access:** `adult_writable` — everyone reads, adults manage.
- **Money:** integer cents (`amount_cents`); totals normalized per period.
- **AI:** read-only export `active_subscriptions`.

## Develop

```bash
make install
make dev
make test
make build
```
