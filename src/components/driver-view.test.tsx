/**
 * D-002: DriverView Component Tests
 * Tests today's trip list, manifest loading, and boarding actions.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DriverView } from './driver-view';
import type { Trip, TripManifest } from '../api/client';

const mockGetMyDriverTrips = vi.fn();
const mockGetTripManifest = vi.fn();
const mockMarkPassengerBoarded = vi.fn();

vi.mock('../api/client', () => ({
  api: {
    getMyDriverTrips: () => mockGetMyDriverTrips(),
    getTripManifest: (id: string) => mockGetTripManifest(id),
    markPassengerBoarded: (tripId: string, bookingId: string) =>
      mockMarkPassengerBoarded(tripId, bookingId),
  },
  ApiError: class ApiError extends Error {
    constructor(message: string) { super(message); }
  },
}));

vi.mock('../core/i18n/index', () => ({
  formatKoboToNaira: (kobo: number) => `₦${(kobo / 100).toFixed(2)}`,
  t: (key: string) => key,
}));

const mockTrips: Trip[] = [
  {
    id: 'trip_001',
    operator_id: 'op_1',
    route_id: 'route_1',
    vehicle_id: 'v_1',
    driver_id: 'driver_me',
    origin: 'Lagos',
    destination: 'Abuja',
    departure_time: Date.now() + 3600000,
    state: 'boarding',
    base_fare: 500000,
    available_seats: 5,
  },
];

const mockManifest: TripManifest = {
  trip: {
    id: 'trip_001',
    state: 'boarding',
    departure_time: Date.now() + 3600000,
    origin: 'Lagos',
    destination: 'Abuja',
    base_fare: 500000,
    total_seats: 18,
    driver: null,
  },
  passengers: [
    {
      booking_id: 'bkg_001',
      customer_name: 'Ada Obi',
      customer_phone: '08011112222',
      passenger_name: 'Ada Obi',
      passenger_names: ['Ada Obi'],
      seat_ids: ['seat_A1'],
      seat_numbers: ['A1'],
      status: 'confirmed',
      payment_status: 'completed',
      total_amount: 500000,
      booked_at: Date.now() - 86400000,
      boarded_at: null,
    },
    {
      booking_id: 'bkg_002',
      customer_name: 'Tunde Bello',
      customer_phone: '08033334444',
      passenger_name: 'Tunde Bello',
      passenger_names: ['Tunde Bello'],
      seat_ids: ['seat_A2'],
      seat_numbers: ['A2'],
      status: 'confirmed',
      payment_status: 'completed',
      total_amount: 500000,
      booked_at: Date.now() - 86400000,
      boarded_at: Date.now() - 1000,
    },
  ],
  summary: {
    total_bookings: 2,
    total_seats: 18,
    load_factor: 0.11,
    confirmed_revenue_kobo: 1000000,
  },
};

describe('DriverView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading then renders today\'s trips', async () => {
    mockGetMyDriverTrips.mockResolvedValueOnce(mockTrips);
    render(<DriverView />);

    await waitFor(() => {
      expect(screen.getByText(/Lagos/i)).toBeTruthy();
    });
  });

  it('shows empty state when no trips today', async () => {
    mockGetMyDriverTrips.mockResolvedValueOnce([]);
    render(<DriverView />);

    await waitFor(() => {
      expect(screen.getByText(/no trips|rest|scheduled/i)).toBeTruthy();
    });
  });

  it('loads and shows passenger names when a trip card is clicked', async () => {
    mockGetMyDriverTrips.mockResolvedValueOnce(mockTrips);
    mockGetTripManifest.mockResolvedValueOnce(mockManifest);

    render(<DriverView />);

    const tripCard = await screen.findByText(/Lagos/i);
    fireEvent.click(tripCard);

    await waitFor(() => {
      expect(screen.getByText('Ada Obi')).toBeTruthy();
      expect(screen.getByText('Tunde Bello')).toBeTruthy();
    });
  });

  it('calls markPassengerBoarded when Board button is clicked', async () => {
    mockGetMyDriverTrips.mockResolvedValueOnce(mockTrips);
    mockGetTripManifest.mockResolvedValueOnce(mockManifest);
    mockMarkPassengerBoarded.mockResolvedValueOnce(undefined);

    render(<DriverView />);

    const tripCard = await screen.findByText(/Lagos/i);
    fireEvent.click(tripCard);

    await waitFor(() => {
      expect(screen.getByText('Ada Obi')).toBeTruthy();
    });

    const boardBtns = screen.getAllByRole('button', { name: /^Board$/i });
    fireEvent.click(boardBtns[0]!);

    await waitFor(() => {
      expect(mockMarkPassengerBoarded).toHaveBeenCalledWith('trip_001', 'bkg_001');
    });
  });
});
