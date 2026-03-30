/**
 * WebWaka Auth Context — React auth state management
 * Provides: user, token, login(), verifyOtp(), logout(), isAuthenticated
 * Role-based: CUSTOMER / STAFF / SUPERVISOR / TENANT_ADMIN / SUPER_ADMIN
 */
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import {
  getStoredToken, setStoredToken, clearStoredToken,
  getStoredUser, setStoredUser, isTokenValid,
  type StoredUser,
} from './store';

// ============================================================
// Types
// ============================================================

export type WakaRole = 'SUPER_ADMIN' | 'TENANT_ADMIN' | 'SUPERVISOR' | 'STAFF' | 'DRIVER' | 'CUSTOMER';

export interface AuthUser extends StoredUser {
  role: WakaRole;
}

interface OtpRequestResult {
  request_id: string;
  expires_in: number;
  phone_hint: string;
  dev_code?: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  requestOtp: (phone: string) => Promise<OtpRequestResult>;
  verifyOtp: (requestId: string, code: string) => Promise<void>;
  logout: () => void;
  hasRole: (roles: WakaRole[]) => boolean;
}

// ============================================================
// Context
// ============================================================

const AuthContext = createContext<AuthContextValue | null>(null);

// ============================================================
// Provider
// ============================================================

export function AuthProvider({ children }: React.PropsWithChildren) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Rehydrate from localStorage on mount
  useEffect(() => {
    const stored = getStoredToken();
    const storedUser = getStoredUser();
    if (stored && isTokenValid(stored) && storedUser) {
      setToken(stored);
      setUser(storedUser as AuthUser);
    }
    setIsLoading(false);
  }, []);

  const requestOtp = useCallback(async (phone: string): Promise<OtpRequestResult> => {
    const res = await fetch('/api/auth/otp/request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone }),
    });
    const json = await res.json() as { success: boolean; data?: OtpRequestResult; error?: string };
    if (!json.success || !json.data) {
      throw new Error(json.error ?? 'Failed to send OTP');
    }
    return json.data;
  }, []);

  const verifyOtp = useCallback(async (requestId: string, code: string): Promise<void> => {
    const res = await fetch('/api/auth/otp/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ request_id: requestId, code }),
    });
    const json = await res.json() as {
      success: boolean;
      data?: { token: string; user: StoredUser & { role: WakaRole } };
      error?: string;
    };
    if (!json.success || !json.data) {
      throw new Error(json.error ?? 'OTP verification failed');
    }

    const { token: newToken, user: newUser } = json.data;
    setStoredToken(newToken);
    setStoredUser(newUser);
    setToken(newToken);
    setUser(newUser);
  }, []);

  const logout = useCallback((): void => {
    clearStoredToken();
    setToken(null);
    setUser(null);
  }, []);

  const hasRole = useCallback((roles: WakaRole[]): boolean => {
    if (!user) return false;
    return roles.includes(user.role as WakaRole);
  }, [user]);

  return (
    <AuthContext.Provider value={{
      user,
      token,
      isAuthenticated: isTokenValid(token),
      isLoading,
      requestOtp,
      verifyOtp,
      logout,
      hasRole,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

// ============================================================
// Hook
// ============================================================

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
