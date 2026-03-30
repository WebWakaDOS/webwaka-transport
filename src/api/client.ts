/**
 * WebWaka Transport Suite — Typed API Client
 * Single abstraction layer over all Worker API endpoints.
 * Invariants: Nigeria-First (kobo), no raw fetch() in components.
 * Auth: injects Authorization: Bearer <jwt> from localStorage on every request.
 */
import { getStoredToken, clearStoredToken } from '../core/auth/store';

// ============================================================
// Domain types (client-side — slightly richer than D1 row types)
// ============================================================

export interface TripSummary {
  id: string;
  departure_time: number;
  state: string;
  origin: string;
  destination: string;
  base_fare: number;
  operator_name: string;
  available_seats: number;
}

export interface SeatInfo {
  id: string;
  trip_id: string;
  seat_number: string;
  status: 'available' | 'reserved' | 'confirmed' | 'blocked';
  reserved_by: string | null;
  reservation_token: string | null;
  reservation_expires_at: number | null;
}

export interface SeatAvailability {
  trip_id: string;
  total_seats: number;
  available: number;
  reserved: number;
  confirmed: number;
  blocked: number;
  seats: SeatInfo[];
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  ndpr_consent: boolean;
}

export interface Booking {
  id: string;
  customer_id: string;
  trip_id: string;
  seat_ids: string[];
  total_amount: number;
  status: 'pending' | 'confirmed' | 'cancelled';
  payment_status: string;
  payment_method: string;
  payment_reference: string;
  created_at: number;
  confirmed_at?: number;
  origin: string | undefined;
  destination: string | undefined;
  departure_time: number | undefined;
  operator_name: string | undefined;
}

export interface Route {
  id: string;
  operator_id: string;
  origin: string;
  destination: string;
  base_fare: number;
  status: string;
  operator_name?: string;
}

export interface Vehicle {
  id: string;
  operator_id: string;
  plate_number: string;
  vehicle_type: string;
  model: string | null;
  total_seats: number;
  status: string;
}

export interface Trip {
  id: string;
  operator_id: string;
  route_id: string;
  state: string;
  departure_time: number;
  origin?: string;
  destination?: string;
  base_fare?: number;
  available_seats?: number;
}

export interface OperatorStats {
  trips: Record<string, number>;
  today_revenue_kobo: number;
}

export interface ReservationResult {
  seat_id: string;
  trip_id: string;
  token: string;
  expires_at: number;
  ttl_seconds: number;
}

// ============================================================
// Error type
// ============================================================

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly endpoint?: string
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// ============================================================
// Internal API response shape
// ============================================================

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: {
    limit: number;
    offset: number;
    count: number;
    has_more: boolean;
  };
}

// ============================================================
// API Client
// ============================================================

export class ApiClient {
  constructor(private readonly base: string = '') {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal
  ): Promise<T> {
    const url = `${this.base}${path}`;
    const headers: Record<string, string> = {};
    const token = getStoredToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    const init: RequestInit = { method, headers };
    if (signal) init.signal = signal;
    if (body !== undefined) {
      init.body = JSON.stringify(body);
    }
    const res = await fetch(url, init);

    const json = await res.json() as ApiResponse<T>;

    if (!json.success || !res.ok) {
      if (res.status === 401) {
        clearStoredToken();
        window.dispatchEvent(new CustomEvent('waka:unauthorized'));
      }
      throw new ApiError(json.error ?? `HTTP ${res.status}`, res.status, path);
    }

    return json.data as T;
  }

  // ============================================================
  // TRN-3: Public trip search
  // ============================================================

  async searchTrips(
    params: { origin?: string; destination?: string; date?: string },
    signal?: AbortSignal
  ): Promise<TripSummary[]> {
    const q = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v))
    );
    return this.request<TripSummary[]>('GET', `/api/booking/trips/search?${q}`, undefined, signal);
  }

  async getRoutes(signal?: AbortSignal): Promise<Route[]> {
    return this.request<Route[]>('GET', '/api/booking/routes', undefined, signal);
  }

  // ============================================================
  // TRN-1: Seat inventory
  // ============================================================

  async getSeatAvailability(tripId: string, signal?: AbortSignal): Promise<SeatAvailability> {
    return this.request<SeatAvailability>(
      'GET', `/api/seat-inventory/trips/${tripId}/availability`, undefined, signal
    );
  }

  async reserveSeat(tripId: string, seatId: string, userId: string): Promise<ReservationResult> {
    return this.request<ReservationResult>(
      'POST', `/api/seat-inventory/trips/${tripId}/reserve`,
      { seat_id: seatId, user_id: userId }
    );
  }

  async releaseSeat(tripId: string, seatId: string, token?: string): Promise<void> {
    await this.request('POST', `/api/seat-inventory/trips/${tripId}/release`, {
      seat_id: seatId, token,
    });
  }

  // ============================================================
  // TRN-3: Customer + Booking
  // ============================================================

  async registerCustomer(data: {
    name: string;
    phone: string;
    email?: string;
    ndpr_consent: boolean;
  }): Promise<Customer> {
    return this.request<Customer>('POST', '/api/booking/customers', data);
  }

  async createBooking(data: {
    customer_id: string;
    trip_id: string;
    seat_ids: string[];
    passenger_names: string[];
    payment_method: string;
    ndpr_consent: boolean;
  }): Promise<Booking> {
    return this.request<Booking>('POST', '/api/booking/bookings', data);
  }

  async confirmBooking(bookingId: string, paymentReference?: string): Promise<{
    id: string; status: string; payment_status: string; confirmed_at: number;
  }> {
    return this.request('PATCH', `/api/booking/bookings/${bookingId}/confirm`, {
      payment_reference: paymentReference,
    });
  }

  async cancelBooking(bookingId: string): Promise<void> {
    await this.request('PATCH', `/api/booking/bookings/${bookingId}/cancel`, {});
  }

  // ============================================================
  // Paystack payment integration
  // ============================================================

  async initiatePayment(bookingId: string, email: string): Promise<{
    dev_mode: boolean;
    reference: string;
    authorization_url: string | null;
    access_code: string | null;
    message?: string;
  }> {
    return this.request('POST', '/api/payments/initiate', { booking_id: bookingId, email });
  }

  async verifyPayment(opts: { reference?: string; booking_id?: string }): Promise<{
    status: string;
    booking_id: string;
    booking_status: string;
  }> {
    return this.request('POST', '/api/payments/verify', opts);
  }

  async getBookings(params?: { customer_id?: string; status?: string }): Promise<Booking[]> {
    const q = params ? new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v))
    ) : new URLSearchParams();
    return this.request<Booking[]>('GET', `/api/booking/bookings?${q}`);
  }

  async getBooking(id: string): Promise<Booking> {
    return this.request<Booking>('GET', `/api/booking/bookings/${id}`);
  }

  // ============================================================
  // TRN-2: Agent sales
  // ============================================================

  async recordSale(data: {
    agent_id: string;
    trip_id: string;
    seat_ids: string[];
    passenger_names: string[];
    total_amount: number;
    payment_method: string;
  }): Promise<{ id: string; receipt_id: string; total_amount: number; payment_method: string }> {
    return this.request('POST', '/api/agent-sales/transactions', data);
  }

  async getAgentDashboard(agentId?: string): Promise<{ today_transactions: number; today_revenue_kobo: number }> {
    const q = agentId ? `?agent_id=${agentId}` : '';
    return this.request('GET', `/api/agent-sales/dashboard${q}`);
  }

  // ============================================================
  // TRN-4: Operator management
  // ============================================================

  async getOperatorDashboard(): Promise<OperatorStats> {
    return this.request<OperatorStats>('GET', '/api/operator/dashboard');
  }

  async getOperatorRoutes(): Promise<Route[]> {
    return this.request<Route[]>('GET', '/api/operator/routes');
  }

  async createRoute(data: {
    operator_id: string; origin: string; destination: string;
    base_fare: number; distance_km?: number; duration_minutes?: number;
  }): Promise<Route> {
    return this.request<Route>('POST', '/api/operator/routes', data);
  }

  async updateRoute(id: string, data: Partial<{
    origin: string; destination: string; base_fare: number; status: string;
  }>): Promise<void> {
    await this.request('PATCH', `/api/operator/routes/${id}`, data);
  }

  async getVehicles(): Promise<Vehicle[]> {
    return this.request<Vehicle[]>('GET', '/api/operator/vehicles');
  }

  async createVehicle(data: {
    operator_id: string; plate_number: string; vehicle_type: string; total_seats: number; model?: string;
  }): Promise<Vehicle> {
    return this.request<Vehicle>('POST', '/api/operator/vehicles', data);
  }

  async updateVehicle(id: string, data: Partial<{
    plate_number: string; vehicle_type: string; model: string; total_seats: number; status: string;
  }>): Promise<void> {
    await this.request('PATCH', `/api/operator/vehicles/${id}`, data);
  }

  async getOperatorTrips(params?: { state?: string }): Promise<Trip[]> {
    const q = params?.state ? `?state=${params.state}` : '';
    return this.request<Trip[]>('GET', `/api/operator/trips${q}`);
  }

  async createTrip(data: {
    route_id: string; vehicle_id: string; departure_time: number;
    base_fare?: number; total_seats?: number;
  }): Promise<Trip> {
    return this.request<Trip>('POST', '/api/operator/trips', data);
  }

  async transitionTrip(tripId: string, toState: string, reason?: string): Promise<void> {
    await this.request('POST', `/api/operator/trips/${tripId}/transition`, {
      to_state: toState, reason,
    });
  }

  async deleteTrip(tripId: string): Promise<void> {
    await this.request('DELETE', `/api/operator/trips/${tripId}`);
  }
}

export const api = new ApiClient();
