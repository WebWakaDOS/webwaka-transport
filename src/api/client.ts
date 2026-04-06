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
  /** Canonical field name returned by seat-inventory API */
  trns_seats: SeatInfo[];
  /** Alias for trns_seats — populated client-side for convenience */
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
  // P05 fields returned by GET /api/operator/trns_trips/:id
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
  // Joined fields from trns_vehicles + trns_drivers
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
  trns_trips: Record<string, number>;
  /** Alias for trns_trips */
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
  trns_bus_parks: string;
  /** Alias for trns_bus_parks */
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
  trns_seats: { total: number; available: number; confirmed: number; reserved: number };
  /** Alias for trns_seats */
  seats: { total: number; available: number; confirmed: number; reserved: number };
  confirmed_bookings: number;
}

export interface DispatchDashboard {
  trns_trips: DispatchTrip[];
  /** Alias for trns_trips */
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
  trns_operators: { total: number; active: number };
  /** Alias for trns_operators */
  operators: { total: number; active: number };
  trns_trips: { total: number; scheduled: number; boarding: number; in_transit: number; completed: number; cancelled: number };
  /** Alias for trns_trips */
  trips: { total: number; scheduled: number; boarding: number; in_transit: number; completed: number; cancelled: number };
  trns_bookings: { total: number; confirmed: number; cancelled: number; pending: number };
  /** Alias for trns_bookings */
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
    return this.request<TripSummary[]>('GET', `/api/booking/trns_trips/search?${q}`, undefined, signal);
  }

  async getRoutes(signal?: AbortSignal): Promise<Route[]> {
    return this.request<Route[]>('GET', '/api/booking/trns_routes', undefined, signal);
  }

  // ============================================================
  // TRN-1: Seat inventory
  // ============================================================

  async getSeatAvailability(tripId: string, signal?: AbortSignal): Promise<SeatAvailability> {
    const data = await this.request<SeatAvailability>(
      'GET', `/api/seat-inventory/trns_trips/${tripId}/availability`, undefined, signal
    );
    // Normalize: ensure both trns_seats and seats alias are populated
    if (data.trns_seats && !data.seats) {
      data.seats = data.trns_seats;
    } else if (data.seats && !data.trns_seats) {
      data.trns_seats = data.seats;
    }
    return data;
  }

  async reserveSeat(tripId: string, seatId: string, userId: string): Promise<ReservationResult> {
    return this.request<ReservationResult>(
      'POST', `/api/seat-inventory/trns_trips/${tripId}/reserve`,
      { seat_id: seatId, user_id: userId }
    );
  }

  async releaseSeat(tripId: string, seatId: string, token?: string): Promise<void> {
    await this.request('POST', `/api/seat-inventory/trns_trips/${tripId}/release`, {
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
    return this.request<Customer>('POST', '/api/booking/trns_customers', data);
  }

  async createBooking(data: {
    customer_id: string;
    trip_id: string;
    seat_ids: string[];
    passenger_names: string[];
    payment_method: string;
    ndpr_consent: boolean;
  }): Promise<Booking> {
    return this.request<Booking>('POST', '/api/booking/trns_bookings', data);
  }

  async confirmBooking(bookingId: string, paymentReference?: string): Promise<{
    id: string; status: string; payment_status: string; confirmed_at: number;
  }> {
    return this.request('PATCH', `/api/booking/trns_bookings/${bookingId}/confirm`, {
      payment_reference: paymentReference,
    });
  }

  async cancelBooking(bookingId: string): Promise<void> {
    await this.request('PATCH', `/api/booking/trns_bookings/${bookingId}/cancel`, {});
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
    return this.request('POST', `/api/logistics/trns_trips/${tripId}/parcels`, parcel);
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
    return this.request('GET', `/api/logistics/trns_trips/${tripId}/parcels`);
  }

  async removeParcel(tripId: string, trackingRef: string): Promise<{ trip_id: string; tracking_ref: string; status: string; unloaded_at: number }> {
    return this.request('DELETE', `/api/logistics/trns_trips/${tripId}/parcels/${encodeURIComponent(trackingRef)}`);
  }

  async getBookings(params?: { customer_id?: string; status?: string }): Promise<Booking[]> {
    const q = params ? new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v))
    ) : new URLSearchParams();
    return this.request<Booking[]>('GET', `/api/booking/trns_bookings?${q}`);
  }

  async getBooking(id: string): Promise<Booking> {
    return this.request<Booking>('GET', `/api/booking/trns_bookings/${id}`);
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
    const data = await this.request<OperatorStats>('GET', '/api/operator/dashboard');
    // Normalize alias
    if (data.trns_trips && !data.trips) data.trips = data.trns_trips;
    return data;
  }

  async getOperatorRoutes(): Promise<Route[]> {
    return this.request<Route[]>('GET', '/api/operator/trns_routes');
  }

  async createRoute(data: {
    operator_id: string; origin: string; destination: string;
    base_fare: number; distance_km?: number; duration_minutes?: number;
  }): Promise<Route> {
    return this.request<Route>('POST', '/api/operator/trns_routes', data);
  }

  async updateRoute(id: string, data: Partial<{
    origin: string; destination: string; base_fare: number; status: string;
  }>): Promise<void> {
    await this.request('PATCH', `/api/operator/trns_routes/${id}`, data);
  }

  async getVehicles(): Promise<Vehicle[]> {
    return this.request<Vehicle[]>('GET', '/api/operator/trns_vehicles');
  }

  async createVehicle(data: {
    operator_id: string; plate_number: string; vehicle_type: string; total_seats: number; model?: string;
  }): Promise<Vehicle> {
    return this.request<Vehicle>('POST', '/api/operator/trns_vehicles', data);
  }

  async updateVehicle(id: string, data: Partial<{
    plate_number: string; vehicle_type: string; model: string; total_seats: number; status: string;
  }>): Promise<void> {
    await this.request('PATCH', `/api/operator/trns_vehicles/${id}`, data);
  }

  async getOperatorTrips(params?: { state?: string }): Promise<Trip[]> {
    const q = params?.state ? `?state=${params.state}` : '';
    return this.request<Trip[]>('GET', `/api/operator/trns_trips${q}`);
  }

  async getTripManifest(tripId: string): Promise<TripManifest> {
    return this.request<TripManifest>('GET', `/api/operator/trns_trips/${tripId}/manifest`);
  }

  // T-TRN-02: Download the passenger manifest as a PDF blob.
  // Resolves with a Blob ready for window.URL.createObjectURL().
  async downloadManifestPdf(tripId: string): Promise<Blob> {
    const token = getStoredToken();
    const headers: Record<string, string> = { Accept: 'application/pdf' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const response = await fetch(`${this.base}/api/operator/trns_trips/${tripId}/manifest?format=pdf`, {
      headers,
    });
    if (!response.ok) {
      const text = await response.text().catch(() => 'Unknown error');
      throw new Error(`PDF download failed (${response.status}): ${text}`);
    }
    return response.blob();
  }

  async getBookingById(id: string): Promise<Booking> {
    return this.request<Booking>('GET', `/api/booking/trns_bookings/${id}`);
  }

  async createTrip(data: {
    route_id: string; vehicle_id: string; departure_time: number;
    driver_id?: string; base_fare?: number; total_seats?: number;
  }): Promise<Trip> {
    return this.request<Trip>('POST', '/api/operator/trns_trips', data);
  }

  async transitionTrip(tripId: string, toState: string, reason?: string): Promise<void> {
    await this.request('POST', `/api/operator/trns_trips/${tripId}/transition`, {
      to_state: toState, reason,
    });
  }

  async deleteTrip(tripId: string): Promise<void> {
    await this.request('DELETE', `/api/operator/trns_trips/${tripId}`);
  }

  async copyTrip(tripId: string, departureTime: number): Promise<Trip> {
    return this.request<Trip>('POST', `/api/operator/trns_trips/${tripId}/copy`, { departure_time: departureTime });
  }

  async updateTrip(tripId: string, data: { vehicle_id?: string; departure_time?: number; driver_id?: string | null }): Promise<void> {
    await this.request('PATCH', `/api/operator/trns_trips/${tripId}`, data);
  }

  async createDriver(data: { operator_id: string; name: string; phone: string; license_number?: string }): Promise<Driver> {
    return this.request<Driver>('POST', '/api/operator/trns_drivers', data);
  }

  async getDrivers(params?: { operator_id?: string; status?: string }): Promise<Driver[]> {
    const q = new URLSearchParams();
    if (params?.operator_id) q.set('operator_id', params.operator_id);
    if (params?.status) q.set('status', params.status);
    const qs = q.toString() ? `?${q.toString()}` : '';
    return this.request<Driver[]>('GET', `/api/operator/trns_drivers${qs}`);
  }

  async updateDriver(driverId: string, data: { name?: string; phone?: string; license_number?: string; status?: string }): Promise<void> {
    await this.request('PATCH', `/api/operator/trns_drivers/${driverId}`, data);
  }

  async getAgents(params?: { operator_id?: string; status?: string }): Promise<Agent[]> {
    const q = new URLSearchParams();
    if (params?.operator_id) q.set('operator_id', params.operator_id);
    if (params?.status) q.set('status', params.status);
    const qs = q.toString() ? `?${q.toString()}` : '';
    const agents = await this.request<Agent[]>('GET', `/api/agent/trns_agents${qs}`);
    // Normalize bus_parks alias
    return agents.map(a => {
      if (a.trns_bus_parks !== undefined && a.bus_parks === undefined) a.bus_parks = a.trns_bus_parks;
      return a;
    });
  }

  async createAgent(data: {
    operator_id: string;
    name: string;
    phone: string;
    email?: string;
    role?: string;
    /** Canonical field name */
    trns_bus_parks?: string[];
    /** Alias for trns_bus_parks */
    bus_parks?: string[];
  }): Promise<Agent> {
    // Normalize: if caller used bus_parks alias, map to trns_bus_parks for the API
    const payload = { ...data };
    if (payload.bus_parks !== undefined && payload.trns_bus_parks === undefined) {
      payload.trns_bus_parks = payload.bus_parks;
    }
    delete (payload as Record<string, unknown>).bus_parks;
    const agent = await this.request<Agent>('POST', '/api/agent/trns_agents', payload);
    if (agent.trns_bus_parks !== undefined && agent.bus_parks === undefined) {
      agent.bus_parks = agent.trns_bus_parks;
    }
    return agent;
  }

  async updateAgent(agentId: string, data: { name?: string; phone?: string; email?: string; role?: string; status?: string; trns_bus_parks?: string[] }): Promise<void> {
    await this.request('PATCH', `/api/agent/trns_agents/${agentId}`, data);
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
    const res = await this.request<{ data: PlatformOperator[] }>('GET', `/api/operator/trns_operators${qs}`);
    return res.data;
  }

  async createOperator(body: { name: string; code: string; phone?: string; email?: string }): Promise<PlatformOperator> {
    const res = await this.request<{ id: string; name: string; code: string; status: string }>('POST', '/api/operator/trns_operators', body);
    return { ...res, phone: null, email: null, created_at: Date.now(), updated_at: Date.now() };
  }

  async updateOperator(id: string, body: { name?: string; phone?: string; email?: string; status?: string }): Promise<void> {
    await this.request('PATCH', `/api/operator/trns_operators/${id}`, body);
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
      `/api/operator/trns_trips?driver_id=me&date=${today}&limit=50`
    );
    return res.data;
  }

  async markPassengerBoarded(tripId: string, bookingId: string): Promise<void> {
    await this.request('PATCH', `/api/operator/trns_trips/${tripId}/manifest/${bookingId}/board`, {});
  }

  // ---- P06: Extended Driver API ----

  async getTrip(tripId: string): Promise<TripDetail> {
    const res = await this.request<{ data: TripDetail }>('GET', `/api/operator/trns_trips/${tripId}`);
    return res.data;
  }

  async updateTripLocation(tripId: string, lat: number, lng: number, accuracy?: number): Promise<void> {
    await this.request('POST', `/api/operator/trns_trips/${tripId}/location`, {
      latitude: lat, longitude: lng, accuracy_meters: accuracy,
    });
  }

  async triggerSOS(tripId: string): Promise<{ message: string }> {
    return this.request('POST', `/api/operator/trns_trips/${tripId}/sos`, {});
  }

  async clearSOS(tripId: string): Promise<{ message: string }> {
    return this.request('POST', `/api/operator/trns_trips/${tripId}/sos/clear`, {});
  }

  async submitInspection(tripId: string, data: {
    tires_ok: boolean; brakes_ok: boolean; lights_ok: boolean;
    fuel_ok: boolean; emergency_equipment_ok: boolean;
    manifest_count?: number; notes?: string;
  }): Promise<{ data: InspectionRecord }> {
    return this.request('POST', `/api/operator/trns_trips/${tripId}/inspection`, data);
  }

  async getInspection(tripId: string): Promise<InspectionRecord | null> {
    const res = await this.request<{ data: InspectionRecord | null }>('GET', `/api/operator/trns_trips/${tripId}/inspection`);
    return res.data;
  }

  async boardByQR(tripId: string, qrPayload: string): Promise<BoardResult> {
    const res = await this.request<{ data: BoardResult }>('POST', `/api/operator/trns_trips/${tripId}/board`, { qr_payload: qrPayload });
    return res.data;
  }

  async getBoardingStatus(tripId: string): Promise<BoardingStatus> {
    const res = await this.request<{ data: BoardingStatus }>('GET', `/api/operator/trns_trips/${tripId}/boarding-status`);
    return res.data;
  }

  async reportDelay(tripId: string, data: {
    reason_code: string; estimated_departure_ms: number; reason_details?: string;
  }): Promise<void> {
    await this.request('POST', `/api/operator/trns_trips/${tripId}/delay`, data);
  }

  async getDelay(tripId: string): Promise<DelayInfo | null> {
    const res = await this.request<{ data: DelayInfo | null }>('GET', `/api/operator/trns_trips/${tripId}/delay`);
    return res.data;
  }

  async transitionTripState(tripId: string, toState: string, reason?: string): Promise<void> {
    await this.request('POST', `/api/operator/trns_trips/${tripId}/transition`, { to_state: toState, reason });
  }

  // ---- C-007: AI Natural Language Trip Search ----

  async aiSearchTrips(query: string): Promise<TripSummary[]> {
    const res = await this.request<{ data: TripSummary[]; ai_params?: unknown }>(
      'POST',
      '/api/booking/trns_trips/ai-search',
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
    const res = await this.request('POST', '/api/agent-sales/group-trns_bookings', body);
    return res as {
      group_booking_id: string; booking_id: string; transaction_id: string;
      receipt_id: string; trip_id: string; seat_count: number; seat_numbers: string[];
      total_amount: number; per_seat_fare: number; payment_method: string;
      payment_reference: string; qr_code: string;
    };
  }

  async getGroupBooking(id: string): Promise<Record<string, unknown>> {
    const res = await this.request('GET', `/api/agent-sales/group-trns_bookings/${id}`);
    return res as Record<string, unknown>;
  }

  // ---- P10-T2: Dispatcher Dashboard ----

  async getDispatchDashboard(): Promise<DispatchDashboard> {
    const res = await this.request<{ success: boolean; data: DispatchDashboard }>(
      'GET', '/api/operator/dispatch'
    );
    const data = res.data;
    // Normalize aliases
    if (data.trns_trips && !data.trips) {
      data.trips = data.trns_trips.map(t => {
        if (t.trns_seats && !t.seats) t.seats = t.trns_seats;
        return t;
      });
    }
    return data;
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
    const data = res.data;
    // Normalize aliases
    if (data.trns_operators && !data.operators) data.operators = data.trns_operators;
    if (data.trns_trips && !data.trips) data.trips = data.trns_trips;
    if (data.trns_bookings && !data.bookings) data.bookings = data.trns_bookings;
    return data;
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
      'GET', `/api/operator/trns_routes/${routeId}/stops`
    );
    return res.data;
  }

  async setRouteStops(routeId: string, stops: {
    stop_name: string; sequence: number;
    distance_from_origin_km?: number; fare_from_origin_kobo?: number;
  }[]): Promise<RouteStop[]> {
    const res = await this.request<{ success: boolean; data: RouteStop[] }>(
      'POST', `/api/operator/trns_routes/${routeId}/stops`, { stops }
    );
    return res.data;
  }

  // ============================================================
  // TRN-5: Ride Hailing
  // ============================================================

  async requestRide(data: {
    customer_id: string;
    pickup_latitude: number; pickup_longitude: number; pickup_address?: string;
    dropoff_latitude: number; dropoff_longitude: number; dropoff_address?: string;
    operator_id?: string;
    waypoints?: Array<{ latitude: number; longitude: number; address?: string }>;
    is_scheduled?: boolean; scheduled_for?: number;
    is_carpooled?: boolean; carpool_group_id?: string;
    promo_code?: string;
  }): Promise<{ ride_request_id: string; status: string; surge_multiplier: number; matched_drivers: unknown[]; promo_applied: boolean }> {
    const res = await this.request<{ success: boolean; data: ReturnType<ApiClient['requestRide']> extends Promise<infer T> ? T : never }>(
      'POST', '/api/ride-hailing/request', data
    );
    return res.data;
  }

  async getSurge(params: { zone_id?: string; operator_id?: string; lat?: number; lon?: number }): Promise<{
    zone_id: string; active_riders: number; available_drivers: number;
    demand_ratio: number; surge_multiplier: number; calculated_at: number;
  }> {
    const q = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))
    );
    const res = await this.request<{ success: boolean; data: Awaited<ReturnType<ApiClient['getSurge']>> }>(
      'GET', `/api/ride-hailing/surge?${q}`
    );
    return res.data;
  }

  async getRide(rideId: string): Promise<Record<string, unknown>> {
    const res = await this.request<{ success: boolean; data: Record<string, unknown> }>('GET', `/api/ride-hailing/${rideId}`);
    return res.data;
  }

  async listRides(params?: { customer_id?: string; driver_id?: string; status?: string; limit?: number }): Promise<unknown[]> {
    const q = new URLSearchParams(
      Object.fromEntries(Object.entries(params ?? {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)]))
    );
    const res = await this.request<{ success: boolean; data: unknown[] }>('GET', `/api/ride-hailing?${q}`);
    return res.data;
  }

  async tipDriver(rideId: string, data: { amount_kobo: number; customer_id: string; payment_method?: string; message?: string }): Promise<{ tip_id: string; amount_kobo: number; driver_id: string }> {
    const res = await this.request<{ success: boolean; data: Awaited<ReturnType<ApiClient['tipDriver']>> }>('POST', `/api/ride-hailing/${rideId}/tip`, data);
    return res.data;
  }

  async heartbeatDriver(data: { driver_id: string; operator_id: string; latitude: number; longitude: number; status: 'available' | 'on_ride' | 'offline'; vehicle_id?: string }): Promise<void> {
    await this.request('POST', '/api/ride-hailing/driver/heartbeat', data);
  }

  async searchCarpool(params: { origin?: string; destination?: string; date?: string }): Promise<unknown[]> {
    const q = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v) as [string, string][]));
    const res = await this.request<{ success: boolean; data: unknown[] }>('GET', `/api/ride-hailing/carpool/search?${q}`);
    return res.data;
  }

  async carpoolAction(data: { action: 'create' | 'join'; [key: string]: unknown }): Promise<{ carpool_group_id: string; status: string; current_passengers: number }> {
    const res = await this.request<{ success: boolean; data: Awaited<ReturnType<ApiClient['carpoolAction']>> }>('POST', '/api/ride-hailing/carpool', data);
    return res.data;
  }

  async getTollFees(routeId: string): Promise<{ trns_toll_gates: unknown[]; total_toll_fee_kobo: number }> {
    const res = await this.request<{ success: boolean; data: Awaited<ReturnType<ApiClient['getTollFees']>> }>('GET', `/api/ride-hailing/toll-fees?route_id=${routeId}`);
    return res.data;
  }

  // ============================================================
  // Driver App
  // ============================================================

  async getDriverEarnings(driverId: string, period?: string): Promise<{
    driver_id: string; period: string; totals: Record<string, number>; daily_breakdown: unknown[]; recent_tips: unknown[];
  }> {
    const res = await this.request<{ success: boolean; data: Awaited<ReturnType<ApiClient['getDriverEarnings']>> }>(
      'GET', `/api/driver-app/${driverId}/earnings${period ? `?period=${period}` : ''}`
    );
    return res.data;
  }

  async submitVehicleInspection(driverId: string, data: {
    vehicle_id: string; operator_id: string;
    tires_ok: boolean; brakes_ok: boolean; lights_ok: boolean;
    fuel_level: string; engine_ok: boolean;
    ac_ok?: boolean; mirrors_ok?: boolean;
    emergency_equipment_ok: boolean;
    mileage_km?: number; notes?: string; photos?: string[];
  }): Promise<{ inspection_id: string; status: string; inspection_date: string }> {
    const res = await this.request<{ success: boolean; data: Awaited<ReturnType<ApiClient['submitVehicleInspection']>> }>(
      'POST', `/api/driver-app/${driverId}/inspections`, data
    );
    return res.data;
  }

  async getDriverInspections(driverId: string, date?: string): Promise<unknown[]> {
    const res = await this.request<{ success: boolean; data: unknown[] }>(
      'GET', `/api/driver-app/${driverId}/inspections${date ? `?date=${date}` : ''}`
    );
    return res.data;
  }

  async submitDriverVerification(driverId: string, data: { operator_id: string; selfie_url?: string }): Promise<{ verification_id: string; status: string; shift_date: string; message: string }> {
    const res = await this.request<{ success: boolean; data: Awaited<ReturnType<ApiClient['submitDriverVerification']>> }>(
      'POST', `/api/driver-app/${driverId}/verify`, data
    );
    return res.data;
  }

  async getTodayVerification(driverId: string): Promise<{ status: string; shift_date: string; verification_id?: string }> {
    const res = await this.request<{ success: boolean; data: Awaited<ReturnType<ApiClient['getTodayVerification']>> }>(
      'GET', `/api/driver-app/${driverId}/verify/today`
    );
    return res.data;
  }

  async driverSOS(tripId: string, data?: { message?: string; latitude?: number; longitude?: number }): Promise<void> {
    await this.request('POST', `/api/driver-app/trns_trips/${tripId}/sos`, data ?? {});
  }

  async clearDriverSOS(tripId: string, clearedBy: string): Promise<void> {
    await this.request('DELETE', `/api/driver-app/trns_trips/${tripId}/sos`, { cleared_by: clearedBy });
  }

  async updateDriverLocation(tripId: string, data: { latitude: number; longitude: number; driver_id: string }): Promise<void> {
    await this.request('PATCH', `/api/driver-app/trns_trips/${tripId}/location`, data);
  }

  // ============================================================
  // Lost & Found
  // ============================================================

  async reportLostFound(data: {
    operator_id: string; reporter_type: 'passenger' | 'driver' | 'staff';
    reporter_id?: string; reporter_name: string; reporter_phone: string;
    trip_id?: string; vehicle_id?: string;
    item_description: string; item_category?: string;
    found_at?: string; storage_location?: string;
    photos?: string[]; notes?: string;
  }): Promise<{ item_id: string; status: string; message: string }> {
    const res = await this.request<{ success: boolean; data: Awaited<ReturnType<ApiClient['reportLostFound']>> }>(
      'POST', '/api/lost-found', data
    );
    return res.data;
  }

  async listLostFound(params?: { operator_id?: string; status?: string; category?: string; search?: string }): Promise<unknown[]> {
    const q = new URLSearchParams(Object.fromEntries(Object.entries(params ?? {}).filter(([, v]) => v) as [string, string][]));
    const res = await this.request<{ success: boolean; data: unknown[] }>('GET', `/api/lost-found?${q}`);
    return res.data;
  }

  async claimLostFoundItem(itemId: string, data: { claimant_name: string; claimant_phone: string }): Promise<void> {
    await this.request('POST', `/api/lost-found/${itemId}/claim`, data);
  }

  // ============================================================
  // Promo Codes
  // ============================================================

  async validatePromo(data: { code: string; fare_kobo: number; customer_id?: string; operator_id?: string }): Promise<{
    promo_code_id: string; code: string; discount_type: string;
    discount_value: number; discount_kobo: number; final_fare_kobo: number;
  }> {
    const res = await this.request<{ success: boolean; data: Awaited<ReturnType<ApiClient['validatePromo']>> }>(
      'POST', '/api/promo/validate', data
    );
    return res.data;
  }

  async applyPromo(data: { code: string; fare_kobo: number; customer_id?: string; booking_id?: string; ride_request_id?: string }): Promise<{ use_id: string; discount_kobo: number; final_fare_kobo: number }> {
    const res = await this.request<{ success: boolean; data: Awaited<ReturnType<ApiClient['applyPromo']>> }>(
      'POST', '/api/promo/apply', data
    );
    return res.data;
  }

  async createPromoCode(data: {
    code: string; description?: string; discount_type: 'percentage' | 'flat';
    discount_value: number; max_uses?: number; min_fare_kobo?: number;
    max_discount_kobo?: number; valid_from: number; valid_until: number;
    operator_id?: string; created_by: string;
  }): Promise<{ promo_code_id: string; code: string }> {
    const res = await this.request<{ success: boolean; data: Awaited<ReturnType<ApiClient['createPromoCode']>> }>(
      'POST', '/api/promo/codes', data
    );
    return res.data;
  }

  async listPromoCodes(params?: { operator_id?: string; active?: boolean }): Promise<unknown[]> {
    const q = new URLSearchParams(Object.fromEntries(Object.entries(params ?? {}).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])));
    const res = await this.request<{ success: boolean; data: unknown[] }>('GET', `/api/promo/codes?${q}`);
    return res.data;
  }

  // ============================================================
  // EV Charging Stations
  // ============================================================

  async getNearbyEVStations(params: { lat: number; lon: number; radius_km?: number; connector_type?: string; available_only?: boolean }): Promise<{
    stations: Array<{ id: string; name: string; city: string; distance_km: number; available_points: number; connector_types: string[]; [key: string]: unknown }>;
    total: number;
  }> {
    const q = new URLSearchParams(Object.fromEntries(Object.entries(params).filter(([, v]) => v != null).map(([k, v]) => [k, String(v)])));
    const res = await this.request<{ success: boolean; data: Awaited<ReturnType<ApiClient['getNearbyEVStations']>> }>(
      'GET', `/api/ev-charging/nearby?${q}`
    );
    return res.data;
  }

  async listEVStations(params?: { city?: string; operator_id?: string }): Promise<unknown[]> {
    const q = new URLSearchParams(Object.fromEntries(Object.entries(params ?? {}).filter(([, v]) => v) as [string, string][]));
    const res = await this.request<{ success: boolean; data: unknown[] }>('GET', `/api/ev-charging?${q}`);
    return res.data;
  }

  async registerEVStation(data: {
    name: string; city: string; state?: string; latitude: number; longitude: number;
    connector_types: string[]; total_points?: number; max_power_kw?: number;
    price_per_kwh_kobo?: number; amenities?: string[]; operating_hours?: string;
    operator_id?: string;
  }): Promise<{ station_id: string; name: string; city: string }> {
    const res = await this.request<{ success: boolean; data: Awaited<ReturnType<ApiClient['registerEVStation']>> }>(
      'POST', '/api/ev-charging', data
    );
    return res.data;
  }
}

export const api = new ApiClient();
