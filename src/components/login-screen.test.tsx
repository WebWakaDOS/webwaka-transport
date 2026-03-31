/**
 * D-002: LoginScreen Component Tests
 * Tests OTP phone flow, validation, and step transitions.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LoginScreen } from './login-screen';

const mockRequestOtp = vi.fn();
const mockVerifyOtp = vi.fn();

vi.mock('../core/auth/context', () => ({
  useAuth: () => ({
    user: null,
    requestOtp: mockRequestOtp,
    verifyOtp: mockVerifyOtp,
    logout: vi.fn(),
    isAuthenticated: false,
  }),
  AuthProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe('LoginScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the WebWaka brand and Sign in heading', () => {
    render(<LoginScreen />);
    expect(screen.getByText(/webwaka/i)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /sign in/i })).toBeTruthy();
  });

  it('renders the phone input with correct placeholder', () => {
    render(<LoginScreen />);
    const phoneInput = screen.getByPlaceholderText('8012345678');
    expect(phoneInput).toBeTruthy();
  });

  it('shows validation error for short phone number', async () => {
    render(<LoginScreen />);
    const phoneInput = screen.getByPlaceholderText('8012345678');
    fireEvent.change(phoneInput, { target: { value: '0801' } });

    const submitBtn = screen.getByRole('button', { name: /send one-time code/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText(/valid nigerian phone/i)).toBeTruthy();
    });
    expect(mockRequestOtp).not.toHaveBeenCalled();
  });

  it('calls requestOtp with cleaned phone number', async () => {
    mockRequestOtp.mockResolvedValueOnce({
      request_id: 'req_test_001',
      dev_code: '123456',
    });

    render(<LoginScreen />);
    const phoneInput = screen.getByPlaceholderText('8012345678');
    fireEvent.change(phoneInput, { target: { value: '08012345678' } });

    fireEvent.click(screen.getByRole('button', { name: /send one-time code/i }));

    await waitFor(() => {
      expect(mockRequestOtp).toHaveBeenCalledWith('08012345678');
    });
  });

  it('shows OTP step heading after successful requestOtp', async () => {
    mockRequestOtp.mockResolvedValueOnce({
      request_id: 'req_test_002',
      dev_code: '654321',
    });

    render(<LoginScreen />);
    const phoneInput = screen.getByPlaceholderText('8012345678');
    fireEvent.change(phoneInput, { target: { value: '08099887766' } });
    fireEvent.click(screen.getByRole('button', { name: /send one-time code/i }));

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /enter your code/i })).toBeTruthy();
    });
  });
});
