/**
 * C-006: i18n Completeness Tests
 * Ensures all locales are in sync with the canonical English set.
 * Invariant: Nigeria-First — all 4 languages must be complete.
 */
import { describe, it, expect } from 'vitest';

// Import the translation internals via the public API
// We test the translations object indirectly via t() and key inspection.
import { t, setLanguage, getLanguage, formatKoboToNaira, getSupportedLanguages, formatAmount, getCurrency, setCurrency, getSupportedCurrencies, type Language } from './index';

// ============================================================
// Extract all keys from i18n module using the English locale
// as the canonical source of truth.
// ============================================================

// All keys that must exist in every locale
const CANONICAL_KEYS = [
  'app_name', 'dashboard', 'search_trips', 'my_bookings', 'agent_pos', 'operator',
  'origin', 'destination', 'date', 'search', 'available_seats', 'departure', 'fare',
  'book_now', 'no_trips_found',
  'select_seats', 'passenger_name', 'payment_method', 'paystack', 'flutterwave',
  'bank_transfer', 'confirm_booking', 'booking_confirmed', 'booking_cancelled',
  'ndpr_consent', 'ndpr_required',
  'select_trip', 'select_seats_pos', 'cash', 'mobile_money', 'card',
  'print_receipt', 'sale_complete', 'offline_queued', 'pending_sync',
  'available', 'reserved', 'confirmed', 'blocked',
  'scheduled', 'boarding', 'in_transit', 'completed', 'cancelled',
  'trips_today', 'total_revenue', 'active_agents', 'manage_routes', 'manage_vehicles',
  'loading', 'error', 'retry', 'cancel', 'confirm', 'back', 'save', 'online', 'offline',
];

const ALL_LOCALES: Language[] = ['en', 'yo', 'ig', 'ha'];

// ============================================================
// Helper: test a locale's completeness
// ============================================================

function testLocale(locale: Language) {
  describe(`locale: ${locale}`, () => {
    it('has all canonical keys non-empty', () => {
      setLanguage(locale);

      for (const key of CANONICAL_KEYS) {
        const value = t(key);
        expect(value, `[${locale}] key '${key}' is missing or falls back to key itself`).not.toBe(key);
        expect(value.trim().length, `[${locale}] key '${key}' is empty`).toBeGreaterThan(0);
      }
    });
  });
}

// ============================================================
// Test suites
// ============================================================

describe('i18n: supported languages', () => {
  it('getSupportedLanguages returns all 4 locales', () => {
    const langs = getSupportedLanguages();
    expect(langs).toHaveLength(4);
    const codes = langs.map(l => l.code);
    expect(codes).toContain('en');
    expect(codes).toContain('yo');
    expect(codes).toContain('ig');
    expect(codes).toContain('ha');
  });

  it('getLanguage returns current locale', () => {
    setLanguage('en');
    expect(getLanguage()).toBe('en');
    setLanguage('yo');
    expect(getLanguage()).toBe('yo');
    setLanguage('en'); // reset
  });
});

describe('i18n: English canonical locale', () => {
  it('all canonical keys resolve to their English value', () => {
    setLanguage('en');
    expect(t('app_name')).toBe('WebWaka Transport');
    expect(t('search_trips')).toBe('Search Trips');
    expect(t('ndpr_consent')).toContain('NDPR');
    expect(t('offline_queued')).toContain('offline');
  });

  it('unknown key falls back to the key string itself', () => {
    setLanguage('en');
    expect(t('nonexistent_key_xyz')).toBe('nonexistent_key_xyz');
  });
});

// Test all locales for completeness
for (const locale of ALL_LOCALES) {
  testLocale(locale);
}

describe('i18n: formatKoboToNaira', () => {
  it('formats 100 kobo as ₦1.00', () => {
    expect(formatKoboToNaira(100)).toBe('₦1.00');
  });

  it('formats 0 kobo as ₦0.00', () => {
    expect(formatKoboToNaira(0)).toBe('₦0.00');
  });

  it('formats 500000 kobo as ₦5,000.00', () => {
    const result = formatKoboToNaira(500000);
    expect(result).toContain('₦');
    expect(result).toContain('5');
    expect(result).toContain('000');
  });

  it('formats large amounts with thousands separator', () => {
    const result = formatKoboToNaira(1000000); // ₦10,000
    expect(result).toContain('₦');
    expect(result.replace(/[₦,\s]/g, '')).toContain('10000');
  });

  it('includes the ₦ Naira symbol', () => {
    expect(formatKoboToNaira(250)).toMatch(/^₦/);
  });
});

describe('i18n: language switching', () => {
  it('switches language and returns correct translation', () => {
    setLanguage('yo');
    expect(t('search')).toBe('Wá');
    setLanguage('ha');
    expect(t('search')).toBe('Nema');
    setLanguage('ig');
    expect(t('search')).toBe('Chọọ');
    setLanguage('en');
    expect(t('search')).toBe('Search');
  });
});

// ============================================================
// Phase E: Multi-currency tests
// ============================================================

describe('i18n: formatAmount — NGN (Nigerian Naira)', () => {
  it('formats 100 kobo as ₦1.00', () => {
    expect(formatAmount(100, 'NGN')).toBe('₦1.00');
  });
  it('formats 0 kobo as ₦0.00', () => {
    expect(formatAmount(0, 'NGN')).toBe('₦0.00');
  });
  it('formats 500000 kobo, contains ₦ and 5000', () => {
    const result = formatAmount(500000, 'NGN');
    expect(result).toMatch(/^₦/);
    expect(result.replace(/[₦,\s]/g, '')).toContain('5000');
  });
  it('formatKoboToNaira delegates to NGN correctly', () => {
    expect(formatKoboToNaira(100)).toBe('₦1.00');
    expect(formatKoboToNaira(0)).toBe('₦0.00');
  });
});

describe('i18n: formatAmount — GHS (Ghanaian Cedi)', () => {
  it('formats 100 pesewa as ₵1.00', () => {
    expect(formatAmount(100, 'GHS')).toBe('₵1.00');
  });
  it('formats 0 as ₵0.00', () => {
    expect(formatAmount(0, 'GHS')).toBe('₵0.00');
  });
  it('formats 50000 pesewa, contains ₵ and 500', () => {
    const result = formatAmount(50000, 'GHS');
    expect(result).toMatch(/^₵/);
    expect(result.replace(/[₵,\s]/g, '')).toContain('500');
  });
});

describe('i18n: formatAmount — KES (Kenyan Shilling)', () => {
  it('formats 100 cents as KSh1.00', () => {
    expect(formatAmount(100, 'KES')).toContain('KSh');
    expect(formatAmount(100, 'KES')).toContain('1');
  });
  it('formats 0 as KSh0.00', () => {
    expect(formatAmount(0, 'KES')).toContain('KSh');
    expect(formatAmount(0, 'KES')).toContain('0');
  });
  it('formats large amounts with KSh prefix', () => {
    const result = formatAmount(1000000, 'KES');
    expect(result).toContain('KSh');
    expect(result.replace(/[KSh,\s]/g, '')).toContain('10000');
  });
});

describe('i18n: formatAmount — UGX (Ugandan Shilling, no sub-unit)', () => {
  it('formats 1000 USh as whole number with USh prefix', () => {
    const result = formatAmount(1000, 'UGX');
    expect(result).toContain('USh');
    expect(result).toContain('1');
    expect(result).not.toContain('.');
  });
  it('formats 0 as USh0', () => {
    const result = formatAmount(0, 'UGX');
    expect(result).toContain('USh');
    expect(result).toContain('0');
  });
  it('subunit factor is 1 — stored amount equals displayed amount', () => {
    const result = formatAmount(50000, 'UGX');
    expect(result).toContain('USh');
    expect(result.replace(/[USh,\s]/g, '')).toContain('50000');
  });
});

describe('i18n: formatAmount — RWF (Rwandan Franc, no sub-unit)', () => {
  it('formats 500 RWF with RWF prefix and no decimal', () => {
    const result = formatAmount(500, 'RWF');
    expect(result).toContain('RWF');
    expect(result).toContain('500');
    expect(result).not.toContain('.');
  });
  it('formats 0 as RWF 0', () => {
    const result = formatAmount(0, 'RWF');
    expect(result).toContain('RWF');
    expect(result).toContain('0');
  });
});

describe('i18n: formatAmount — defaults to current currency', () => {
  it('uses current currency when no currency argument passed', () => {
    setCurrency('GHS');
    const result = formatAmount(100);
    expect(result).toContain('₵');
    setCurrency('NGN');
  });
  it('explicit currency overrides current currency', () => {
    setCurrency('GHS');
    expect(formatAmount(100, 'NGN')).toBe('₦1.00');
    setCurrency('NGN');
  });
});

describe('i18n: getCurrency / setCurrency', () => {
  it('defaults to NGN', () => {
    setCurrency('NGN');
    expect(getCurrency()).toBe('NGN');
  });
  it('setCurrency changes the active currency', () => {
    setCurrency('KES');
    expect(getCurrency()).toBe('KES');
    setCurrency('NGN');
  });
  it('setCurrency persists across subsequent getCurrency calls', () => {
    setCurrency('UGX');
    expect(getCurrency()).toBe('UGX');
    expect(getCurrency()).toBe('UGX');
    setCurrency('NGN');
  });
});

describe('i18n: getSupportedCurrencies', () => {
  it('returns exactly 5 currencies', () => {
    expect(getSupportedCurrencies()).toHaveLength(5);
  });
  it('contains all five supported currency codes', () => {
    const codes = getSupportedCurrencies().map(c => c.code);
    expect(codes).toContain('NGN');
    expect(codes).toContain('GHS');
    expect(codes).toContain('KES');
    expect(codes).toContain('UGX');
    expect(codes).toContain('RWF');
  });
  it('each currency has symbol, flag, name, subunitFactor, fractionDigits', () => {
    for (const cfg of getSupportedCurrencies()) {
      expect(cfg.symbol.length).toBeGreaterThan(0);
      expect(cfg.flag.length).toBeGreaterThan(0);
      expect(cfg.name.length).toBeGreaterThan(0);
      expect(typeof cfg.subunitFactor).toBe('number');
      expect(typeof cfg.fractionDigits).toBe('number');
    }
  });
  it('NGN and GHS have fractionDigits 2, UGX and RWF have 0', () => {
    const map = Object.fromEntries(getSupportedCurrencies().map(c => [c.code, c]));
    expect(map['NGN']!.fractionDigits).toBe(2);
    expect(map['GHS']!.fractionDigits).toBe(2);
    expect(map['KES']!.fractionDigits).toBe(2);
    expect(map['UGX']!.fractionDigits).toBe(0);
    expect(map['RWF']!.fractionDigits).toBe(0);
  });
});
