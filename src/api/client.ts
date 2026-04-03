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
  passenger_names?: string[];
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

export interface ManifestEntry {
  booking_id: string;
  customer_name: string;
  customer_phone: string;
  phone?: string;
  passenger_name?: string;
  seat_ids: string[];
  seat_numbers?: string[];
  passenger_names: string[];
  status: string;
  payment_status: string;
  payment_method?: string;
  total_amount: number;
  booked_at: number;
  boarded_at?: number | null;
  boarded_by?: string | null;
  // T-TRN-02: Next-of-kin for FRSC manifest compliance
  next_of_kin_name?: string | null;
  next_of_kin_phone?: string | null;
}

export interface TripManifest {
  trip: {
    id: string;
    state: string;
    departure_time: number;
    origin: string;
    destination: string;
    base_fare: number;
    total_seats: number;
    driver: { id: string; name: string; phone: string; license_number: string | null } | null;
  };
  passengers: ManifestEntry[];
  summary: {
    total_bookings: number;
    total_seats: number;
    load_factor: number;
    confirmed_revenue_kobo: number;
  };
  // Top-level aliases for driver-view convenience
  origin?: string;
  destination?: string;
  departure_time?: number;
  driver?: { id: string; name: string; phone: string } | null;
}

export interface Driver {
  id: string;
  operator_id: string;
  name: string;
  phone: string;
  license_number: string | null;
  status: string;
  created_at: number;
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
  vehicle_id?: string;
  state: string;
  departure_time: number;
  driver_id?: string | null;
  origin?: string;
  destination?: string;
  base_fare?: number;
  available_seats?: number;
}

export interface TripDetail extends Trip {
  // P05 fields returned by GET /api/operator/trips/:id
  current_latitude: number | null;
  current_longitude: number | null;
  location_updated_at: number | null;
  sos_active: number;
  sos_triggered_at: number | null;
  sos_triggered_by: string | null;
  inspection_completed_at: number | null;
  delay_reason_code: string | null;
  delay_reported_at: number | null;
  estimated_departure_ms: number | null;
  // Joined fields from vehicles + drivers
  total_seats?: number | null;
  plate_number?: string | null;
  driver_name?: string | null;
  driver_phone?: string | null;
}

export interface BoardingStatus {
  total_confirmed: number;
  total_boarded: number;
  remaining: number;
  last_boarded_at: number | null;
}

export interface InspectionRecord {
  id: string;
  trip_id: string;
  inspected_by: string;
  tires_ok: number;
  brakes_ok: number;
  lights_ok: number;
  fuel_ok: number;
  emergency_equipment_ok: number;
  manifest_count: number | null;
  notes: string | null;
  created_at: number;
}

export interface DelayInfo {
  delay_reason_code: string | null;
  delay_reported_at: number | null;
  estimated_departure_ms: number | null;
}

export interface BoardResult {
  passenger_names: string[];
  seat_numbers: string;
  boarded_at: number;
  message: string;
}

export interface OperatorStats {
  trips: Record<string, number>;
  today_revenue_kobo: number;
}

export interface Agent {
  id: string;
  operator_id: string;
  name: string;
  phone: string;
  email: string | null;
  role: string;
  bus_parks: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface RouteRevenue {
  route_id: string;
  origin: string;
  destination: string;
  trip_count: number;
}

export interface AgentBreakdown {
  agent_id: string;
  agent_name: string | null;
  total_kobo: number;
  transaction_count: number;
}

export interface OperatorNotification {
  id: string;
  event_type: string;
  aggregate_id: string;
  aggregate_type: string;
  payload: Record<string, unknown>;
  created_at: number;
  read_at: number | null;
  is_read: boolean;
}

export interface DailyRevenue {
  date_ms: number;
  total_kobo: number;
}

export interface PushSubscriptionData {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
}

// P10-T2: Dispatcher Dashboard
export interface DispatchVehicle {
  plate_number: string;
  model: string | null;
  total_seats: number | null;
}

export interface DispatchDriver {
  id: string;
  name: string;
  phone: string;
}

export interface DispatchLocation {
  latitude: number;
  longitude: number;
  recorded_at: number | null;
}

export interface DispatchTrip {
  id: string;
  state: string;
  departure_time: number;
  operator_id: string;
  origin: string;
  destination: string;
  vehicle: DispatchVehicle | null;
  driver: DispatchDriver | null;
  location: DispatchLocation | null;
  seats: { total: number; available: number; confirmed: number; reserved: number };
  confirmed_bookings: number;
}

export interface DispatchDashboard {
  trips: DispatchTrip[];
  count: number;
  as_of: number;
}

// P10-T4: Grouped Revenue Analytics
export interface RevenueReportItem {
  group_id: string;
  group_label: string;
  total_trips: number;
  confirmed_seats: number;
  fill_rate_pct: number;
  gross_revenue_kobo: number;
  refunds_kobo: number;
  net_revenue_kobo: number;
  avg_fare_kobo: number;
}

export interface GroupedRevenueReport {
  groupby: string;
  from_ms: number;
  to_ms: number;
  items: RevenueReportItem[];
  total_items: number;
  generated_at: number;
}

// P10-T5: SUPER_ADMIN Platform Analytics
export interface PlatformAnalytics {
  generated_at: number;
  operators: { total: number; active: number };
  trips: { total: number; scheduled: number; boarding: number; in_transit: number; completed: number; cancelled: number };
  bookings: { total: number; confirmed: number; cancelled: number; pending: number };
  revenue: { total_revenue_kobo: number; this_month_revenue_kobo: number };
  top_routes: Array<{ origin: string; destination: string; booking_count: number; revenue_kobo: number }>;
  top_operators: Array<{ id: string; name: string; trip_count: number; revenue_kobo: number }>;
}

export interface RevenueReport {
  period: { from: number; to: number };
  total_revenue_kobo: number;
  booking_revenue_kobo: number;
  agent_sales_revenue_kobo: number;
  total_bookings: number;
  total_agent_transactions: number;
  top_routes: RouteRevenue[];
  agent_breakdown?: AgentBreakdown[];
  daily_breakdown?: DailyRevenue[];
}

export interface PlatformOperator {
  id: string;
  name: string;
  code: string;
  phone: string | null;
  email: string | null;
  status: string;
  created_at: number;
  updated_at: number;
}

export interface ReservationResult {
  seat_id: string;
  trip_id: string;
  token: string;
  expires_at: number;
  ttl_seconds: number;
}

// ============================================================
// P11-T1: API Key Types
// ============================================================

export interface ApiKey {
  id: string;
  operator_id: string;
  name: string;
  scope: 'read' | 'read_write';
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

export interface ApiKeyCreated {
  id: string;
  name: string;
  scope: 'read' | 'read_write';
  key: string;
  created_at: number;
}

// ============================================================
// P11-T3: Route Stop Types
// ============================================================

export interface RouteStop {
  id: string;
  route_id: string;
  stop_name: string;
  sequence: number;
  distance_from_origin_km: number | null;
  fare_from_origin_kobo: number | null;
  created_at?: number;
}

// ============================================================
// Error type
// ============================================================

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly endpoint?: string,
    public readonly data?: unknown
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
      throw new ApiError(json.error ?? `HTTP ${res.status}`, res.status, path, json.data);
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

  // ============================================================
  // Flutterwave payment integration
  // ============================================================

  async initiateFlutterwave(bookingId: string, email: string): Promise<{
    dev_mode: boolean;
    tx_ref: string;
    payment_link: string | null;
    message?: string;
  }> {
    return this.request('POST', '/api/payments/flutterwave/initiate', { booking_id: bookingId, email });
  }

  async verifyFlutterwave(opts: { tx_ref?: string; booking_id?: string }): Promise<{
    status: string;
    booking_id: string;
    booking_status: string;
  }> {
    return this.request('POST', '/api/payments/flutterwave/verify', opts);
  }

  // ============================================================
  // T-TRN-05: Logistics — parcel waybill cargo management
  // ============================================================

  async loadParcel(tripId: string, parcel: {
    tracking_ref: string;
    description?: string;
    weight_kg?: number;
    sender_name?: string;
    receiver_name?: string;
    receiver_phone?: string;
  }): Promise<{
    id: string;
    trip_id: string;
    tracking_ref: string;
    description: string | null;
    weight_kg: number | null;
    sender_name: string | null;
    receiver_name: string | null;
    receiver_phone: string | null;
    loaded_at: number;
    status: string;
  }> {
    return this.request('POST', `/api/logistics/trips/${tripId}/parcels`, parcel);
  }

  async getTripParcels(tripId: string): Promise<Array<{
    id: string;
    trip_id: string;
    tracking_ref: string;
    description: string | null;
    weight_kg: number | null;
    sender_name: string | null;
    receiver_name: string | null;
    receiver_phone: string | null;
    loaded_at: number;
    loaded_by: string | null;
    unloaded_at: number | null;
    status: string;
  }>> {
    return this.request('GET', `/api/logistics/trips/${tripId}/parcels`);
  }

  async removeParcel(tripId: string, trackingRef: string): Promise<{ trip_id: string; tracking_ref: string; status: string; unloaded_at: number }> {
    return this.request('DELETE', `/api/logistics/trips/${tripId}/parcels/${encodeURIComponent(trackingRef)}`);
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
    passenger_id_type?: string | null;
    passenger_id_number?: string | null;
  }): Promise<{
    id: string; receipt_id: string; total_amount: number; payment_method: string;
    qr_code: string; seat_numbers: string[];
  }> {
    return this.request('POST', '/api/agent-sales/transactions', data);
  }

  async getAgentDashboard(agentId?: string): Promise<{ today_transactions: number; today_revenue_kobo: number }> {
    const q = agentId ? `?agent_id=${agentId}` : '';
    return this.request('GET', `/api/agent-sales/dashboard${q}`);
  }

  // P07-T1: Float Reconciliation
  async submitReconciliation(data: {
    agent_id: string; operator_id: string; period_date: string;
    submitted_kobo: number; notes?: string;
  }): Promise<{
    id: string; expected_kobo: number; submitted_kobo: number;
    discrepancy_kobo: number; status: string;
  }> {
    return this.request('POST', '/api/agent-sales/reconciliation', data);
  }

  async getReconciliations(params?: {
    agent_id?: string; status?: string; period_date?: string;
  }): Promise<Array<{
    id: string; agent_id: string; period_date: string;
    expected_kobo: number; submitted_kobo: number; discrepancy_kobo: number;
    status: string; reviewed_by: string | null; notes: string | null; created_at: number;
  }>> {
    const qs = new URLSearchParams(
      Object.entries(params ?? {}).filter(([, v]) => v != null) as [string, string][]
    ).toString();
    return this.request('GET', `/api/agent-sales/reconciliation${qs ? `?${qs}` : ''}`);
  }

  // P07-T4: Bus Parks
  async getBusParks(): Promise<Array<{
    id: string; operator_id: string; name: string; city: string; state: string;
    latitude: number | null; longitude: number | null; created_at: number;
  }>> {
    return this.request('GET', '/api/agent-sales/parks');
  }

  async createBusPark(data: {
    operator_id: string; name: string; city: string; state: string;
    latitude?: number | null; longitude?: number | null;
  }): Promise<{ id: string; name: string; city: string; state: string }> {
    return this.request('POST', '/api/agent-sales/parks', data);
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

  async getTripManifest(tripId: string): Promise<TripManifest> {
    return this.request<TripManifest>('GET', `/api/operator/trips/${tripId}/manifest`);
  }

  // T-TRN-02: Download the passenger manifest as a PDF blob.
  // Resolves with a Blob ready for window.URL.createObjectURL().
  async downloadManifestPdf(tripId: string): Promise<Blob> {
    const token = getStoredToken();
    const headers: Record<string, string> = { Accept: 'application/pdf' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const response = await fetch(`${this.base}/api/operator/trips/${tripId}/manifest?format=pdf`, {
      headers,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      throw new Error(`PDF download failed (${response.status}): ${text}`);
    }
    return response.blob();
  }

  async getBookingById(id: string): Promise<Booking> {
    return this.request<Booking>('GET', `/api/booking/bookings/${id}`);
  }

  async createTrip(data: {
    route_id: string; vehicle_id: string; departure_time: number;
    driver_id?: string; base_fare?: number; total_seats?: number;
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

  async copyTrip(tripId: string, departureTime: number): Promise<Trip> {
    return this.request<Trip>('POST', `/api/operator/trips/${tripId}/copy`, { departure_time: departureTime });
  }

  async updateTrip(tripId: string, data: { vehicle_id?: string; departure_time?: number; driver_id?: string | null }): Promise<void> {
    await this.request('PATCH', `/api/operator/trips/${tripId}`, data);
  }

  async createDriver(data: { operator_id: string; name: string; phone: string; license_number?: string }): Promise<Driver> {
    return this.request<Driver>('POST', '/api/operator/drivers', data);
  }

  async getDrivers(params?: { operator_id?: string; status?: string }): Promise<Driver[]> {
    const q = new URLSearchParams();
    if (params?.operator_id) q.set('operator_id', params.operator_id);
    if (params?.status) q.set('status', params.status);
    const qs = q.toString() ? `?${q.toString()}` : '';
    return this.request<Driver[]>('GET', `/api/operator/drivers${qs}`);
  }

  async updateDriver(driverId: string, data: { name?: string; phone?: string; license_number?: string; status?: string }): Promise<void> {
    await this.request('PATCH', `/api/operator/drivers/${driverId}`, data);
  }

  async getAgents(params?: { operator_id?: string; status?: string }): Promise<Agent[]> {
    const q = new URLSearchParams();
    if (params?.operator_id) q.set('operator_id', params.operator_id);
    if (params?.status) q.set('status', params.status);
    const qs = q.toString() ? `?${q.toString()}` : '';
    return this.request<Agent[]>('GET', `/api/agent/agents${qs}`);
  }

  async createAgent(data: { operator_id: string; name: string; phone: string; email?: string; role?: string; bus_parks?: string[] }): Promise<Agent> {
    return this.request<Agent>('POST', '/api/agent/agents', data);
  }

  async updateAgent(agentId: string, data: { name?: string; phone?: string; email?: string; role?: string; status?: string; bus_parks?: string[] }): Promise<void> {
    await this.request('PATCH', `/api/agent/agents/${agentId}`, data);
  }

  async getRevenueReport(params?: { from?: number; to?: number; operator_id?: string }): Promise<RevenueReport> {
    const q = new URLSearchParams();
    if (params?.from != null) q.set('from', String(params.from));
    if (params?.to != null) q.set('to', String(params.to));
    if (params?.operator_id) q.set('operator_id', params.operator_id);
    const qs = q.toString() ? `?${q.toString()}` : '';
    return this.request<RevenueReport>('GET', `/api/operator/reports/revenue${qs}`);
  }

  // ---- Super Admin: Operator Management ----

  async getOperators(params?: { status?: string }): Promise<PlatformOperator[]> {
    const q = new URLSearchParams();
    if (params?.status) q.set('status', params.status);
    const qs = q.toString() ? `?${q.toString()}` : '';
    const res = await this.request<{ data: PlatformOperator[] }>('GET', `/api/operator/operators${qs}`);
    return res.data;
  }

  async createOperator(body: { name: string; code: string; phone?: string; email?: string }): Promise<PlatformOperator> {
    const res = await this.request<{ id: string; name: string; code: string; status: string }>('POST', '/api/operator/operators', body);
    return { ...res, phone: null, email: null, created_at: Date.now(), updated_at: Date.now() };
  }

  async updateOperator(id: string, body: { name?: string; phone?: string; email?: string; status?: string }): Promise<void> {
    await this.request('PATCH', `/api/operator/operators/${id}`, body);
  }

  // ---- P09-T3: Operator Notification Center ----

  async getOperatorNotifications(): Promise<{ notifications: OperatorNotification[]; unread_count: number }> {
    const res = await this.request<{ data: { notifications: OperatorNotification[]; unread_count: number } }>(
      'GET', '/api/operator/notifications'
    );
    return res.data;
  }

  async markNotificationRead(eventId: string): Promise<void> {
    await this.request('POST', `/api/operator/notifications/${eventId}/read`, {});
  }

  // ---- C-001: Web Push Notifications ----

  async subscribeForPush(subscription: PushSubscriptionData): Promise<void> {
    await this.request('POST', '/api/notifications/subscribe', subscription);
  }

  async unsubscribeFromPush(endpoint: string): Promise<void> {
    await this.request('DELETE', '/api/notifications/subscribe', { endpoint });
  }

  // ---- C-004: Driver Mobile View ----

  async getMyDriverTrips(): Promise<Trip[]> {
    const today = new Date().toISOString().split('T')[0]!;
    const res = await this.request<{ data: Trip[]; meta: unknown }>(
      'GET',
      `/api/operator/trips?driver_id=me&date=${today}&limit=50`
    );
    return res.data;
  }

  async markPassengerBoarded(tripId: string, bookingId: string): Promise<void> {
    await this.request('PATCH', `/api/operator/trips/${tripId}/manifest/${bookingId}/board`, {});
  }

  // ---- P06: Extended Driver API ----

  async getTrip(tripId: string): Promise<TripDetail> {
    const res = await this.request<{ data: TripDetail }>('GET', `/api/operator/trips/${tripId}`);
    return res.data;
  }

  async updateTripLocation(tripId: string, lat: number, lng: number, accuracy?: number): Promise<void> {
    await this.request('POST', `/api/operator/trips/${tripId}/location`, {
      latitude: lat, longitude: lng, accuracy_meters: accuracy,
    });
  }

  async triggerSOS(tripId: string): Promise<{ message: string }> {
    return this.request('POST', `/api/operator/trips/${tripId}/sos`, {});
  }

  async clearSOS(tripId: string): Promise<{ message: string }> {
    return this.request('POST', `/api/operator/trips/${tripId}/sos/clear`, {});
  }

  async submitInspection(tripId: string, data: {
    tires_ok: boolean; brakes_ok: boolean; lights_ok: boolean;
    fuel_ok: boolean; emergency_equipment_ok: boolean;
    manifest_count?: number; notes?: string;
  }): Promise<{ data: InspectionRecord }> {
    return this.request('POST', `/api/operator/trips/${tripId}/inspection`, data);
  }

  async getInspection(tripId: string): Promise<InspectionRecord | null> {
    const res = await this.request<{ data: InspectionRecord | null }>('GET', `/api/operator/trips/${tripId}/inspection`);
    return res.data;
  }

  async boardByQR(tripId: string, qrPayload: string): Promise<BoardResult> {
    const res = await this.request<{ data: BoardResult }>('POST', `/api/operator/trips/${tripId}/board`, { qr_payload: qrPayload });
    return res.data;
  }

  async getBoardingStatus(tripId: string): Promise<BoardingStatus> {
    const res = await this.request<{ data: BoardingStatus }>('GET', `/api/operator/trips/${tripId}/boarding-status`);
    return res.data;
  }

  async reportDelay(tripId: string, data: {
    reason_code: string; estimated_departure_ms: number; reason_details?: string;
  }): Promise<void> {
    await this.request('POST', `/api/operator/trips/${tripId}/delay`, data);
  }

  async getDelay(tripId: string): Promise<DelayInfo | null> {
    const res = await this.request<{ data: DelayInfo | null }>('GET', `/api/operator/trips/${tripId}/delay`);
    return res.data;
  }

  async transitionTripState(tripId: string, toState: string, reason?: string): Promise<void> {
    await this.request('POST', `/api/operator/trips/${tripId}/transition`, { to_state: toState, reason });
  }

  // ---- C-007: AI Natural Language Trip Search ----

  async aiSearchTrips(query: string): Promise<TripSummary[]> {
    const res = await this.request<{ data: TripSummary[]; ai_params?: unknown }>(
      'POST',
      '/api/booking/trips/ai-search',
      { query }
    );
    return res.data;
  }

  // ---- C-008: Admin Promotion API ----

  async promoteUser(userId: string, role: string, operatorId?: string): Promise<void> {
    await this.request('PATCH', `/api/operator/users/${userId}/role`, {
      role,
      ...(operatorId ? { operator_id: operatorId } : {}),
    });
  }

  // ---- P08-T5: Group Bookings ----

  async createGroupBooking(body: {
    trip_id: string; agent_id: string; group_name: string;
    leader_name: string; leader_phone: string;
    seat_ids: string[]; passenger_names: string[];
    seat_class?: string; payment_method: string;
    total_amount_kobo?: number;
  }): Promise<{
    group_booking_id: string; booking_id: string; transaction_id: string;
    receipt_id: string; trip_id: string; seat_count: number; seat_numbers: string[];
    total_amount: number; per_seat_fare: number; payment_method: string;
    payment_reference: string; qr_code: string;
  }> {
    const res = await this.request('POST', '/api/agent-sales/group-bookings', body);
    return res as {
      group_booking_id: string; booking_id: string; transaction_id: string;
      receipt_id: string; trip_id: string; seat_count: number; seat_numbers: string[];
      total_amount: number; per_seat_fare: number; payment_method: string;
      payment_reference: string; qr_code: string;
    };
  }

  async getGroupBooking(id: string): Promise<Record<string, unknown>> {
    const res = await this.request('GET', `/api/agent-sales/group-bookings/${id}`);
    return res as Record<string, unknown>;
  }

  // ---- P10-T2: Dispatcher Dashboard ----

  async getDispatchDashboard(): Promise<DispatchDashboard> {
    const res = await this.request<{ success: boolean; data: DispatchDashboard }>(
      'GET', '/api/operator/dispatch'
    );
    return res.data;
  }

  // ---- P10-T4: Grouped Revenue Analytics ----

  async getGroupedRevenueReport(params?: {
    groupby?: 'route' | 'vehicle' | 'driver' | 'operator';
    from?: number;
    to?: number;
  }): Promise<GroupedRevenueReport> {
    const q = new URLSearchParams();
    if (params?.groupby) q.set('groupby', params.groupby);
    if (params?.from != null) q.set('from', String(params.from));
    if (params?.to != null) q.set('to', String(params.to));
    const qs = q.toString() ? `?${q.toString()}` : '';
    const res = await this.request<{ success: boolean; data: GroupedRevenueReport }>(
      'GET', `/api/operator/reports${qs}`
    );
    return res.data;
  }

  // ---- P10-T5: SUPER_ADMIN Platform Analytics ----

  async getPlatformAnalytics(): Promise<PlatformAnalytics> {
    const res = await this.request<{ success: boolean; data: PlatformAnalytics }>(
      'GET', '/api/internal/admin/analytics'
    );
    return res.data;
  }

  // ---- P11-T1: API Key Management ----

  async createApiKey(body: { name: string; scope: 'read' | 'read_write' }): Promise<ApiKeyCreated> {
    const res = await this.request<{ success: boolean; data: ApiKeyCreated; warning?: string }>(
      'POST', '/api/operator/api-keys', body
    );
    return res.data;
  }

  async listApiKeys(): Promise<ApiKey[]> {
    const res = await this.request<{ success: boolean; data: ApiKey[] }>(
      'GET', '/api/operator/api-keys'
    );
    return res.data;
  }

  async revokeApiKey(id: string): Promise<void> {
    await this.request('DELETE', `/api/operator/api-keys/${id}`);
  }

  async updateOperatorProfile(body: {
    name?: string; address?: string; contact_phone?: string;
    cac_number?: string; firs_tin?: string;
  }): Promise<void> {
    await this.request('PATCH', '/api/operator/profile', body);
  }

  // ---- P11-T3: Multi-Stop Route Management ----

  async getRouteStops(routeId: string): Promise<RouteStop[]> {
    const res = await this.request<{ success: boolean; data: RouteStop[] }>(
      'GET', `/api/operator/routes/${routeId}/stops`
    );
    return res.data;
  }

  async setRouteStops(routeId: string, stops: {
    stop_name: string; sequence: number;
    distance_from_origin_km?: number; fare_from_origin_kobo?: number;
  }[]): Promise<RouteStop[]> {
    const res = await this.request<{ success: boolean; data: RouteStop[] }>(
      'POST', `/api/operator/routes/${routeId}/stops`, { stops }
    );
    return res.data;
  }
}

export const api = new ApiClient();
