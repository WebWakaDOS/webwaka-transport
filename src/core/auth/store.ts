/**
 * WebWaka Auth Store — JWT persistence via localStorage
 * Invariants: zero network calls, synchronous reads, safe fallbacks.
 */

const TOKEN_KEY = 'waka_token';
const USER_KEY = 'waka_user';

export interface StoredUser {
  id: string;
  name: string | null;
  phone: string;
  role: string;
  operator_id?: string;
}

export interface TokenPayload {
  sub: string;
  role: string;
  operator_id: string | null;
  phone: string | null;
  jti: string;
  iat: number;
  exp: number;
}

// ============================================================
// Token storage
// ============================================================

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Ignore storage quota errors
  }
}

export function clearStoredToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    // Ignore
  }
}

// ============================================================
// User storage
// ============================================================

export function getStoredUser(): StoredUser | null {
  try {
    const raw = localStorage.getItem(USER_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredUser;
  } catch {
    return null;
  }
}

export function setStoredUser(user: StoredUser): void {
  try {
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  } catch {
    // Ignore
  }
}

// ============================================================
// Token decode + expiry check (no crypto — just base64 decode)
// ============================================================

function base64UrlDecode(str: string): string {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (padded.length % 4)) % 4;
  return atob(padded + '='.repeat(padding));
}

export function decodeToken(token: string): TokenPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(base64UrlDecode(parts[1]!)) as TokenPayload;
    return payload;
  } catch {
    return null;
  }
}

export function isTokenExpired(token: string): boolean {
  const payload = decodeToken(token);
  if (!payload) return true;
  const nowSeconds = Math.floor(Date.now() / 1000);
  // Treat tokens expiring within 60 seconds as expired (clock-skew buffer)
  return payload.exp < nowSeconds + 60;
}

export function isTokenValid(token: string | null): token is string {
  if (!token) return false;
  return !isTokenExpired(token);
}
