/**
 * LoginScreen — OTP-based phone authentication UI
 * Nigeria-First: validates local phone numbers, shows ₦ branding
 * Step 1: Enter phone → request OTP
 * Step 2: Enter 6-digit code → verify → JWT stored
 */
import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useAuth } from '../core/auth/context';

type Step = 'phone' | 'otp';

export function LoginScreen() {
  const { requestOtp, verifyOtp } = useAuth();
  const [step, setStep] = useState<Step>('phone');
  const [phone, setPhone] = useState('');
  const [requestId, setRequestId] = useState('');
  const [devCode, setDevCode] = useState<string | undefined>(undefined);
  const [otpDigits, setOtpDigits] = useState<string[]>(['', '', '', '', '', '']);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [resendCountdown, setResendCountdown] = useState(0);
  const inputRefs = useRef<Array<HTMLInputElement | null>>(Array(6).fill(null));

  // ── Resend countdown timer ──
  useEffect(() => {
    if (resendCountdown <= 0) return;
    const timer = setTimeout(() => setResendCountdown(c => c - 1), 1000);
    return () => clearTimeout(timer);
  }, [resendCountdown]);

  const handleRequestOtp = async () => {
    const cleaned = phone.replace(/\D/g, '');
    if (cleaned.length < 10) {
      setError('Enter a valid Nigerian phone number (e.g. 08012345678)');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const result = await requestOtp(cleaned);
      setRequestId(result.request_id);
      setDevCode(result.dev_code);
      setStep('otp');
      setResendCountdown(60);
      // Auto-fill dev code in development
      if (result.dev_code) {
        const digits = result.dev_code.split('');
        setOtpDigits(digits);
      }
      setTimeout(() => inputRefs.current[0]?.focus(), 100);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to send OTP');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyOtp = useCallback(async (digits: string[]) => {
    const code = digits.join('');
    if (code.length < 6) return;
    setLoading(true);
    setError('');
    try {
      await verifyOtp(requestId, code);
      // AuthProvider updates state — parent re-renders and hides this screen
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Verification failed');
      setOtpDigits(['', '', '', '', '', '']);
      setTimeout(() => inputRefs.current[0]?.focus(), 100);
    } finally {
      setLoading(false);
    }
  }, [requestId, verifyOtp]);

  const handleOtpChange = useCallback((index: number, value: string) => {
    const digit = value.replace(/\D/g, '').slice(-1);
    const newDigits = [...otpDigits];
    newDigits[index] = digit;
    setOtpDigits(newDigits);

    if (digit && index < 5) {
      inputRefs.current[index + 1]?.focus();
    }
    if (newDigits.every(d => d !== '')) {
      void handleVerifyOtp(newDigits);
    }
  }, [otpDigits, handleVerifyOtp]);

  const handleOtpKeyDown = (index: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !otpDigits[index] && index > 0) {
      inputRefs.current[index - 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6);
    if (pasted.length === 6) {
      const digits = pasted.split('');
      setOtpDigits(digits);
      void handleVerifyOtp(digits);
    }
  };

  const handleResend = async () => {
    setStep('phone');
    setOtpDigits(['', '', '', '', '', '']);
    setError('');
    setDevCode(undefined);
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center',
      background: '#f8fafc', padding: '24px 16px', fontFamily: 'system-ui, sans-serif',
    }}>
      {/* Logo */}
      <div style={{ textAlign: 'center', marginBottom: 32 }}>
        <div style={{ fontSize: 48, marginBottom: 8 }}>🚌</div>
        <div style={{ fontSize: 24, fontWeight: 800, color: '#1e40af' }}>WebWaka</div>
        <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>Your transport companion across Nigeria</div>
      </div>

      <div style={{
        width: '100%', maxWidth: 380,
        background: '#fff', borderRadius: 16,
        border: '1.5px solid #e2e8f0', padding: 28,
        boxShadow: '0 4px 24px rgba(0,0,0,0.06)',
      }}>
        {step === 'phone' ? (
          <>
            <h2 style={{ margin: '0 0 6px', fontSize: 20 }}>Sign in</h2>
            <p style={{ margin: '0 0 24px', fontSize: 13, color: '#64748b' }}>
              Enter your phone number to receive a one-time code
            </p>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Phone number</label>
              <div style={{ display: 'flex', alignItems: 'center', marginTop: 4 }}>
                <div style={{
                  padding: '12px 14px', background: '#f8fafc', border: '1.5px solid #e2e8f0',
                  borderRight: 'none', borderRadius: '10px 0 0 10px', fontSize: 15, color: '#64748b',
                  fontWeight: 600, whiteSpace: 'nowrap',
                }}>
                  🇳🇬 +234
                </div>
                <input
                  value={phone}
                  onChange={e => setPhone(e.target.value)}
                  onKeyDown={e => e.key === 'Enter' && void handleRequestOtp()}
                  placeholder="8012345678"
                  style={{
                    flex: 1, padding: '12px 14px', border: '1.5px solid #e2e8f0',
                    borderRadius: '0 10px 10px 0', fontSize: 15, background: '#fff',
                    boxSizing: 'border-box', outline: 'none',
                  }}
                  type="tel"
                  autoComplete="tel"
                  autoFocus
                />
              </div>
            </div>

            {error && <ErrorBox message={error} />}

            <button
              onClick={() => void handleRequestOtp()}
              disabled={loading}
              style={{ ...primaryBtnStyle, width: '100%', opacity: loading ? 0.6 : 1 }}
            >
              {loading ? 'Sending…' : 'Send one-time code'}
            </button>

            <p style={{ fontSize: 11, color: '#94a3b8', textAlign: 'center', marginTop: 16 }}>
              By continuing you agree to our Terms of Service. Your data is protected under NDPR.
            </p>
          </>
        ) : (
          <>
            <button onClick={handleResend} style={{ ...backBtnStyle, marginBottom: 16 }}>← Change number</button>
            <h2 style={{ margin: '0 0 6px', fontSize: 20 }}>Enter your code</h2>
            <p style={{ margin: '0 0 6px', fontSize: 13, color: '#64748b' }}>
              We sent a 6-digit code to <strong>+234{phone.replace(/\D/g, '')}</strong>
            </p>
            {devCode && (
              <div style={{
                marginBottom: 12, padding: '6px 12px', background: '#fef9c3',
                borderRadius: 8, fontSize: 12, color: '#92400e',
              }}>
                Dev mode — code: <strong>{devCode}</strong>
              </div>
            )}

            {/* 6-digit OTP grid */}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', margin: '20px 0' }} onPaste={handlePaste}>
              {otpDigits.map((digit, i) => (
                <input
                  key={i}
                  ref={el => { inputRefs.current[i] = el; }}
                  value={digit}
                  onChange={e => handleOtpChange(i, e.target.value)}
                  onKeyDown={e => handleOtpKeyDown(i, e)}
                  type="text"
                  inputMode="numeric"
                  maxLength={1}
                  style={{
                    width: 44, height: 52, textAlign: 'center', fontSize: 24, fontWeight: 700,
                    border: '2px solid', borderColor: digit ? '#1e40af' : '#e2e8f0',
                    borderRadius: 10, background: digit ? '#eff6ff' : '#fff',
                    caretColor: '#1e40af', outline: 'none',
                  }}
                />
              ))}
            </div>

            {error && <ErrorBox message={error} />}

            <button
              onClick={() => void handleVerifyOtp(otpDigits)}
              disabled={loading || otpDigits.some(d => !d)}
              style={{ ...primaryBtnStyle, width: '100%', opacity: loading || otpDigits.some(d => !d) ? 0.5 : 1 }}
            >
              {loading ? 'Verifying…' : 'Verify code'}
            </button>

            <div style={{ textAlign: 'center', marginTop: 16 }}>
              {resendCountdown > 0 ? (
                <span style={{ fontSize: 13, color: '#94a3b8' }}>
                  Resend in {resendCountdown}s
                </span>
              ) : (
                <button onClick={() => void handleResend()} style={{ ...linkBtnStyle }}>
                  Resend code
                </button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div style={{
      padding: '10px 14px', background: '#fee2e2', borderRadius: 8,
      color: '#b91c1c', fontSize: 13, marginBottom: 12,
    }}>
      {message}
    </div>
  );
}

const labelStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 600, color: '#374151', display: 'block',
};

const primaryBtnStyle: React.CSSProperties = {
  padding: '14px 20px', borderRadius: 10, border: 'none',
  background: '#1e40af', color: '#fff', fontWeight: 700, fontSize: 15,
  cursor: 'pointer', minHeight: 48,
};

const backBtnStyle: React.CSSProperties = {
  padding: '6px 12px', borderRadius: 8, border: '1.5px solid #e2e8f0',
  background: '#fff', color: '#475569', fontWeight: 600, fontSize: 12, cursor: 'pointer',
  display: 'inline-block',
};

const linkBtnStyle: React.CSSProperties = {
  background: 'none', border: 'none', color: '#1e40af',
  fontSize: 13, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline',
};
