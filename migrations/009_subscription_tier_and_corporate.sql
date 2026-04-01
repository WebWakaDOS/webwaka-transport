-- P15-T1: Subscription tier gating
-- Adds subscription_tier to operators (basic/pro/enterprise)
ALTER TABLE operators ADD COLUMN subscription_tier TEXT NOT NULL DEFAULT 'basic';

-- P15-T3: Corporate travel portal
-- customer_type distinguishes individual vs corporate accounts
-- credit_limit_kobo is the remaining credit balance (decremented on each credit booking)
ALTER TABLE customers ADD COLUMN customer_type TEXT NOT NULL DEFAULT 'individual';
ALTER TABLE customers ADD COLUMN credit_limit_kobo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN company_name TEXT;
ALTER TABLE customers ADD COLUMN contact_email TEXT;
