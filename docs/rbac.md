# WebWaka Transport Suite — RBAC Permission Matrix

> **Invariant**: Nigeria-First, Multi-Tenant, Build Once Use Infinitely
> All permissions are enforced in `@webwaka/core` (`requireRole`) and tenant-scoped
> by `requireTenant` middleware. No role may access another tenant's data.

## Roles

| Role | Scope | Description |
|------|-------|-------------|
| `SUPER_ADMIN` | Platform-wide | WebWaka staff. Can manage all tenants, operators, and configurations. |
| `TENANT_ADMIN` | Tenant-wide | Operator owner/admin. Full control within their operator account. |
| `SUPERVISOR` | Tenant-wide | Senior staff. Read-all + trip management + reporting. No user admin. |
| `STAFF` | Tenant-wide | Booking agents / counter staff. Day-to-day operations. |
| `DRIVER` | Trip-specific | Bus drivers. Read assigned trips + update trip state only. |
| `CUSTOMER` | Own data only | End customers. Search, book, and manage their own bookings. |

## Permission Matrix

### TRN-1: Seat Inventory (Module)

| Action | SUPER_ADMIN | TENANT_ADMIN | SUPERVISOR | STAFF | DRIVER | CUSTOMER |
|--------|:-----------:|:------------:|:----------:|:-----:|:------:|:--------:|
| `GET /api/seat-inventory/trips` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `POST /api/seat-inventory/trips` (create trip) | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `POST /api/seat-inventory/trips/:id/reserve` | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| `POST /api/seat-inventory/trips/:id/confirm` | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| `POST /api/seat-inventory/trips/:id/release` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `GET /api/seat-inventory/trips/:id/availability` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

### TRN-2: Agent Sales / POS (Module)

| Action | SUPER_ADMIN | TENANT_ADMIN | SUPERVISOR | STAFF | DRIVER | CUSTOMER |
|--------|:-----------:|:------------:|:----------:|:-----:|:------:|:--------:|
| `GET /api/agent-sales/transactions` | ✅ | ✅ | ✅ | own | ❌ | ❌ |
| `POST /api/agent-sales/transactions` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `POST /api/agent-sales/transactions/:id/sync` | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ |
| `GET /api/agent-sales/agents` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `POST /api/agent-sales/agents` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |
| `GET /api/agent-sales/daily-summary` | ✅ | ✅ | ✅ | own | ❌ | ❌ |

### TRN-3: Customer Booking Portal (Module)

| Action | SUPER_ADMIN | TENANT_ADMIN | SUPERVISOR | STAFF | DRIVER | CUSTOMER |
|--------|:-----------:|:------------:|:----------:|:-----:|:------:|:--------:|
| `GET /api/booking/routes` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `GET /api/booking/trips/search` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (public) |
| `POST /api/booking/bookings` | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| `GET /api/booking/bookings/:id` | ✅ | ✅ | ✅ | ✅ | ❌ | own |
| `POST /api/booking/bookings/:id/confirm` | ✅ | ✅ | ✅ | ✅ | ❌ | own |
| `POST /api/booking/bookings/:id/cancel` | ✅ | ✅ | ✅ | ✅ | ❌ | own |
| `POST /api/booking/customers/register` | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ |
| `GET /api/booking/customers/:id` | ✅ | ✅ | ✅ | ✅ | ❌ | own |
| `POST /api/booking/otp/request` | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ (public) |
| `POST /api/booking/otp/verify` | ✅ | ✅ | ✅ | ✅ | ❌ | ✅ (public) |

### TRN-4: Operator Management (Module)

| Action | SUPER_ADMIN | TENANT_ADMIN | SUPERVISOR | STAFF | DRIVER | CUSTOMER |
|--------|:-----------:|:------------:|:----------:|:-----:|:------:|:--------:|
| `GET /api/operator/operators` | ✅ | own | ❌ | ❌ | ❌ | ❌ |
| `POST /api/operator/operators` | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| `GET /api/operator/trips` | ✅ | ✅ | ✅ | ✅ | own | ❌ |
| `POST /api/operator/trips` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `PUT /api/operator/trips/:id/state` | ✅ | ✅ | ✅ | ❌ | own | ❌ |
| `GET /api/operator/reports` | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ |
| `GET /api/operator/vehicles` | ✅ | ✅ | ✅ | ✅ | own | ❌ |
| `POST /api/operator/vehicles` | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ |

### Platform Admin (Internal endpoints)

| Action | SUPER_ADMIN | TENANT_ADMIN | SUPERVISOR | STAFF | DRIVER | CUSTOMER |
|--------|:-----------:|:------------:|:----------:|:-----:|:------:|:--------:|
| `POST /api/admin/migrations/run` | MIGRATION_SECRET header only | ❌ | ❌ | ❌ | ❌ | ❌ |
| `GET /health` | ✅ (public) | ✅ (public) | ✅ (public) | ✅ (public) | ✅ (public) | ✅ (public) |

## Enforcement Implementation

```
src/
  middleware/
    auth.ts           — jwtAuthMiddleware (JWT decode + user injection)
  worker.ts           — requireTenantMiddleware (X-Tenant-ID + operator_id scoping)
packages/core/
  src/index.ts        — requireRole(roles[]) — throws 403 if role not in list
                      — requireTenant()      — extracts tenant ID from header
```

## NDPR Compliance Notes

- **CUSTOMER** role requires explicit NDPR consent before booking creation (`ndpr_consent: true` field).
- Customer PII (phone, email, NIN) is never returned in list endpoints.
- Operators must store NDPR consent timestamp (`consent_given_at`) in `customers` table.
- Data retention: bookings retained 7 years per Nigeria financial regulations. Customer PII may be anonymised after 2 years on request.

## Multi-Tenant Isolation

Every DB query in routes carrying `TENANT_ADMIN`, `SUPERVISOR`, `STAFF`, `DRIVER` roles
**must** filter on `operator_id = c.req.raw.headers.get('x-tenant-id')`.

The `requireTenantMiddleware` injects `operatorId` into the Hono context and rejects
requests missing `X-Tenant-ID` for protected routes.

`SUPER_ADMIN` bypasses the tenant filter and can query across all tenants.
`CUSTOMER` is scoped to their own records (filtered by `customer_id`).
