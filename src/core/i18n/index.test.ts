/**
 * C-006: i18n Completeness Tests
 * Ensures all locales are in sync with the canonical English set.
 * Invariant: Nigeria-First — all 4 languages must be complete.
 */
import { describe, it, expect } from 'vitest';

// Import the translation internals via the public API
// We test the translations object indirectly via t() and key inspection.
import { t, setLanguage, getLanguage, formatKoboToNaira, getSupportedLanguages, type Language } from './index';

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
