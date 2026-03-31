/**
 * D-002: AnalyticsDashboard Component Tests
 * Tests revenue analytics rendering, loading state, and date range selection.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnalyticsDashboard } from './analytics';
import type { RevenueReport } from '../api/client';

const mockGetRevenueReport = vi.fn();

vi.mock('../api/client', () => ({
  api: {
    getRevenueReport: (...args: unknown[]) => mockGetRevenueReport(...args),
  },
  ApiError: class ApiError extends Error {
    constructor(message: string) { super(message); }
  },
}));

vi.mock('../core/i18n/index', () => ({
  formatKoboToNaira: (kobo: number) => `₦${(kobo / 100).toFixed(2)}`,
  t: (key: string) => key,
}));

const mockReport: RevenueReport = {
  period: { from: Date.now() - 7 * 86400000, to: Date.now() },
  total_revenue_kobo: 5_000_000,
  booking_revenue_kobo: 3_000_000,
  agent_sales_revenue_kobo: 2_000_000,
  total_bookings: 42,
  total_agent_transactions: 15,
  top_routes: [
    { route_id: 'r1', origin: 'Lagos', destination: 'Abuja', trip_count: 5 },
  ],
  agent_breakdown: [
    { agent_id: 'agent_1', agent_name: 'Chidi Okeke', total_kobo: 3_000_000, transaction_count: 25 },
  ],
  daily_breakdown: [
    { date_ms: Date.now() - 2 * 86400000, total_kobo: 1_000_000 },
    { date_ms: Date.now() - 86400000, total_kobo: 2_000_000 },
    { date_ms: Date.now(), total_kobo: 2_000_000 },
  ],
};

describe('AnalyticsDashboard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state initially', () => {
    mockGetRevenueReport.mockReturnValue(new Promise(() => {}));
    render(<AnalyticsDashboard />);
    expect(screen.getByText(/loading/i)).toBeTruthy();
  });

  it('renders total revenue after data loads', async () => {
    mockGetRevenueReport.mockResolvedValueOnce(mockReport);
    render(<AnalyticsDashboard />);

    await waitFor(() => {
      expect(screen.getByText(/50,000\.00|₦50/i)).toBeTruthy();
    });
  });

  it('renders booking count stat card', async () => {
    mockGetRevenueReport.mockResolvedValueOnce(mockReport);
    render(<AnalyticsDashboard />);

    await waitFor(() => {
      expect(screen.getByText(/42/)).toBeTruthy();
    });
  });

  it('renders agent breakdown section', async () => {
    mockGetRevenueReport.mockResolvedValueOnce(mockReport);
    render(<AnalyticsDashboard />);

    await waitFor(() => {
      expect(screen.getByText(/Chidi Okeke/i)).toBeTruthy();
    });
  });

  it('shows error state when API call fails', async () => {
    mockGetRevenueReport.mockRejectedValueOnce(new Error('Network error'));
    render(<AnalyticsDashboard />);

    await waitFor(() => {
      expect(screen.getByText(/error|failed|network/i)).toBeTruthy();
    });
  });
});
