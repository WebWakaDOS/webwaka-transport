# WebWaka Transport Suite — NDPR Compliance Guide

> Nigeria Data Protection Regulation (NDPR) 2019 — Federal Competition and Consumer Protection Commission (FCCPC)

---

## 1. Overview

WebWaka Transport Suite processes personal data of Nigerian citizens including phone numbers, names, booking histories, and financial transaction records. This document describes the technical controls in place to comply with the NDPR.

---

## 2. Data Categories Processed

| Category | Table | Retention Period | Basis |
|---|---|---|---|
| Identity (name, phone, email) | `customers`, `agents` | 2 years after last activity | Legitimate interest (transport booking) |
| Booking records | `bookings` | 2 years active / 7 years financial | Contract performance + FIRS requirement |
| Financial transactions | `sales_transactions` | 7 years (FIRS) | Legal obligation |
| Push notification endpoints | `push_subscriptions` | Duration of subscription | Consent |
| OTP sessions | `SESSIONS_KV` | 10 minutes | Operational |
| Event audit trail | `platform_events` | 2 years | Legitimate interest |

---

## 3. Automated Data Retention (C-002)

Two NDPR sweepers run daily at **00:00 UTC** via Cloudflare Workers cron:

### 3.1 `sweepExpiredPII` — 2-Year Inactivity Anonymisation

- **Trigger:** `last_active_at < now - 2 years`
- **Action:** Anonymises PII in `customers` table:
  - `name` → `"[DELETED]"`
  - `phone` → `"+234000000000"`
  - `email` → `null`
  - `deleted_at` = current timestamp
- **Scope:** 100 records per run (batched to avoid D1 timeouts)
- **Idempotent:** yes — rows already anonymised are skipped

### 3.2 `purgeExpiredFinancialData` — 7-Year Financial Soft-Delete

- **Trigger:** `bookings.created_at < now - 7 years`
- **Action:** Marks records as soft-deleted (`deleted_at` = now) in:
  - `bookings`
  - `sales_transactions`
- **FIRS Compliance:** 7-year retention aligns with the Nigerian Federal Inland Revenue Service records requirement
- **Idempotent:** yes — already-deleted records are unaffected

### 3.3 Cron Schedule

```toml
# wrangler.toml
[triggers]
crons = ["* * * * *", "0 0 * * *"]
#         ↑ per-minute sweepers    ↑ daily NDPR sweepers
```

---

## 4. Data Subject Rights

WebWaka operators must implement the following rights on request:

| Right | Technical Mechanism | Owner |
|---|---|---|
| Right to access | `GET /api/booking/bookings` (customer-scoped) | Product team |
| Right to rectification | `PATCH /api/operator/customers/:id` | Operator admin |
| Right to erasure | `sweepExpiredPII` (automated) + manual override endpoint | Super Admin |
| Right to portability | Export bookings as JSON/CSV (roadmap) | Product team |
| Right to withdraw consent | `DELETE /api/notifications/subscribe` | Customer |

---

## 5. Cross-Border Transfers

- All data is stored in **Cloudflare D1** (EU/US Cloudflare PoPs)
- Cloudflare's Data Processing Agreement (DPA) covers GDPR/NDPR-equivalent safeguards
- Nigerian customer data is not intentionally routed outside Africa-adjacent Cloudflare regions
- **Action required:** Obtain FCCPC approval before transferring bulk PII outside Nigeria (NDPR Art. 2.11)

---

## 6. Consent Trail

The `ndpr_consent` Dexie table records per-customer consent:

```typescript
interface NdprConsentRecord {
  id?: number;
  customer_id: string;
  consent_type: 'data_processing' | 'marketing' | 'analytics';
  granted: boolean;
  granted_at: number;
  ip_hash?: string;       // hashed, not raw IP
  user_agent_hash?: string;
}
```

Push notification consent is separately recorded in `push_subscriptions.created_at`.

---

## 7. Security Controls

| Control | Implementation |
|---|---|
| Encryption in transit | Cloudflare TLS 1.3 (automatic) |
| Encryption at rest | Cloudflare D1 encryption (automatic) |
| Access control | JWT + RBAC (`requireRole` middleware) |
| Multi-tenancy isolation | `operator_id` scope on all queries |
| SQL injection prevention | Parameterised queries throughout (no string interpolation) |
| Token-based seat release | SEC-006: `token` field required on `POST /trips/:id/release` |
| OTP rate limiting | 5 requests per phone per 10-minute window |
| Idempotency | `X-Idempotency-Key` header on mutating endpoints |

---

## 8. Incident Response

1. Detect: Cloudflare Workers logs + Cloudflare Zero Trust alerts
2. Contain: Rotate `JWT_SECRET` via `wrangler secret put JWT_SECRET --env production`
3. Assess: Query `platform_events` table for anomalous event sequences
4. Notify: NDPR requires notification to NITDA within **72 hours** of becoming aware of a breach
5. Remediate: Re-run sweepers; invalidate affected sessions via `SESSIONS_KV.delete()`

---

## 9. Data Protection Officer (DPO)

WebWaka Transport Suite operators must designate a DPO if processing data of more than 1,000 data subjects per month (NDPR Art. 4.1(a)).

**Recommended contact:** `dpo@[operator-domain].ng`

---

## 10. Audit Checklist

- [ ] NDPR Privacy Policy published and linked in app footer
- [ ] Data Processing Agreement signed with all sub-processors (Cloudflare, Paystack, Termii)
- [ ] DPO registered with NITDA (if threshold exceeded)
- [ ] Annual DPIA (Data Protection Impact Assessment) conducted
- [ ] Sweeper runs monitored via Cloudflare Workers analytics
- [ ] Consent records backed up before each schema migration
