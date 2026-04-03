/**
 * WebWaka Transport Suite — Mobile-First PWA
 * Modules: TRN-1 Seat Inventory, TRN-2 Agent POS, TRN-3 Booking Portal, TRN-4 Operator Dashboard
 * Invariants: Mobile-First, PWA-First, Offline-First, Nigeria-First (₦), Africa-First (4 languages)
 */
import React, { Component, useState, useEffect, useCallback } from 'react';
import { t, setLanguage, getLanguage, getSupportedLanguages, formatAmount, setCurrency, getCurrency, getSupportedCurrencies, autoDetectLanguage, type Language, type CurrencyCode } from './core/i18n/index';
import { useOnlineStatus, useSyncQueue } from './core/offline/hooks';
import { AuthProvider, useAuth, type WakaRole } from './core/auth/context';
import { LoginScreen } from './components/login-screen';
import { BookingFlow } from './components/booking-flow';
import { TicketPage } from './components/ticket';
import { ConflictLog } from './components/conflict-log';
import { DriverView } from './components/driver-view';
import ReceiptModal, { type ReceiptData } from './components/receipt';
import { OnboardingWizard } from './components/onboarding-wizard';
import FareRulesPanel from './components/fare-rules-panel';
import { api, ApiError } from './api/client';
import type { TripSummary, Route, Vehicle, Trip, OperatorStats, Booking, SeatAvailability, TripManifest, ManifestEntry, Driver, Agent, RevenueReport, RouteRevenue, PlatformOperator, OperatorNotification, DispatchDashboard, DispatchTrip, GroupedRevenueReport, RevenueReportItem, PlatformAnalytics, ApiKey, ApiKeyCreated, RouteStop } from './api/client';
import { getConflicts } from './core/offline/db';

// ============================================================
// Error Boundary
// ============================================================
interface ErrorBoundaryState { hasError: boolean; message: string }

class ErrorBoundary extends Component<React.PropsWithChildren<{ label: string }>, ErrorBoundaryState> {
  constructor(props: React.PropsWithChildren<{ label: string }>) {
    super(props);
    this.state = { hasError: false, message: '' };
  }

  static getDerivedStateFromError(err: unknown): ErrorBoundaryState {
    return { hasError: true, message: err instanceof Error ? err.message : 'Unknown error' };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 24, textAlign: 'center', color: '#b91c1c' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>⚠️</div>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{this.props.label} failed to load</div>
          <div style={{ fontSize: 12, color: '#64748b' }}>{this.state.message}</div>
          <button
            onClick={() => this.setState({ hasError: false, message: '' })}
            style={{ marginTop: 16, padding: '8px 20px', borderRadius: 8, border: '1px solid #dc2626', background: '#fff', color: '#dc2626', cursor: 'pointer' }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// ============================================================
// Status Bar
// ============================================================
function StatusBar({ online, pendingSync, syncing, lang, onLangChange, currency, onCurrencyChange }: {
  online: boolean; pendingSync: number; syncing: boolean;
  lang: Language; onLangChange: (l: Language) => void;
  currency: CurrencyCode; onCurrencyChange: (c: CurrencyCode) => void;
}) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '6px 16px', fontSize: 11, fontWeight: 600,
      background: online ? '#16a34a' : '#dc2626', color: '#fff',
    }}>
      <span>{online ? `● ${t('online')}` : `○ ${t('offline')}`}</span>
      {syncing && <span>↻ {t('syncing') ?? 'Syncing…'}</span>}
      {!syncing && pendingSync > 0 && <span>⟳ {pendingSync} {t('pending_sync')}</span>}
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <select
          value={currency}
          onChange={e => onCurrencyChange(e.target.value as CurrencyCode)}
          style={{ background: 'transparent', color: '#fff', border: 'none', fontSize: 11, cursor: 'pointer' }}
          aria-label="Currency"
        >
          {getSupportedCurrencies().map(c => (
            <option key={c.code} value={c.code} style={{ color: '#000' }}>{c.flag} {c.code}</option>
          ))}
        </select>
        <select
          value={lang}
          onChange={e => onLangChange(e.target.value as Language)}
          style={{ background: 'transparent', color: '#fff', border: 'none', fontSize: 11, cursor: 'pointer' }}
          aria-label="Language"
        >
          {getSupportedLanguages().map(l => (
            <option key={l.code} value={l.code} style={{ color: '#000' }}>{l.name}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ============================================================
// P13-T3: Compact inline language selector — used in module headers
// Self-contained: reads/writes from i18n state directly.
// ============================================================
const LANG_FLAGS: Record<Language, string> = { en: '🇬🇧', yo: '🇳🇬', ig: '🇳🇬', ha: '🇳🇬' };
const LANG_ABBR: Record<Language, string> = { en: 'EN', yo: 'YO', ig: 'IG', ha: 'HA' };

function InlineLangSelector() {
  const [lang, setLang] = useState<Language>(getLanguage());
  const handleChange = (l: Language) => {
    setLanguage(l);
    setLang(l);
  };
  return (
    <select
      value={lang}
      onChange={e => handleChange(e.target.value as Language)}
      aria-label={t('language')}
      style={{
        fontSize: 11, padding: '4px 6px', borderRadius: 6,
        border: '1px solid #e2e8f0', background: '#f8fafc', color: '#475569',
        cursor: 'pointer', fontWeight: 600,
      }}
    >
      {getSupportedLanguages().map(l => (
        <option key={l.code} value={l.code}>
          {LANG_FLAGS[l.code]} {LANG_ABBR[l.code]}
        </option>
      ))}
    </select>
  );
}

// ============================================================
// Trip Search Module (TRN-3 Booking Portal)
// ============================================================
function TripSearchModule() {
  const [origin, setOrigin] = useState('');
  const [destination, setDestination] = useState('');
  const [date, setDate] = useState(new Date().toISOString().split('T')[0]!);
  const [trips, setTrips] = useState<TripSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [selectedTrip, setSelectedTrip] = useState<TripSummary | null>(null);
  const [aiMode, setAiMode] = useState(false);
  const [aiQuery, setAiQuery] = useState('');

  const search = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const results = await api.searchTrips({ origin, destination, date });
      setTrips(results);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Search failed');
      setTrips([]);
    } finally {
      setLoading(false);
    }
  }, [origin, destination, date]);

  const aiSearch = useCallback(async () => {
    if (!aiQuery.trim()) return;
    setLoading(true);
    setError('');
    try {
      const results = await api.aiSearchTrips(aiQuery);
      setTrips(results);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'AI search failed — try standard search');
      setTrips([]);
    } finally {
      setLoading(false);
    }
  }, [aiQuery]);

  if (selectedTrip) {
    return (
      <BookingFlow
        trip={selectedTrip}
        onBack={() => setSelectedTrip(null)}
      />
    );
  }

  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{t('search_trips')}</h2>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <InlineLangSelector />
          <button
            onClick={() => setAiMode(m => !m)}
            style={{
              fontSize: 11, padding: '5px 12px', borderRadius: 20, border: `1px solid ${aiMode ? '#7c3aed' : '#e2e8f0'}`,
              background: aiMode ? '#f5f3ff' : '#fff', color: aiMode ? '#7c3aed' : '#64748b', cursor: 'pointer', fontWeight: 600,
            }}
            title="Toggle AI natural language search"
          >
            ✨ AI Search {aiMode ? 'ON' : 'OFF'}
          </button>
        </div>
      </div>

      {aiMode ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <textarea
            placeholder='Describe your trip… e.g. "Lagos to Abuja tomorrow morning, cheapest"'
            value={aiQuery}
            onChange={e => setAiQuery(e.target.value)}
            rows={3}
            style={{ ...inputStyle, resize: 'vertical' }}
          />
          <button onClick={() => void aiSearch()} style={{ ...primaryBtnStyle, background: '#7c3aed' }}>
            {loading ? 'Searching…' : '✨ Find My Trip'}
          </button>
          <button onClick={() => setAiMode(false)} style={secondaryBtnStyle}>
            Use standard form
          </button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <input placeholder={t('origin')} value={origin} onChange={e => setOrigin(e.target.value)} style={inputStyle} />
          <input placeholder={t('destination')} value={destination} onChange={e => setDestination(e.target.value)} style={inputStyle} />
          <input type="date" value={date} onChange={e => setDate(e.target.value)} style={inputStyle} />
          <button onClick={() => void search()} style={primaryBtnStyle}>
            {loading ? t('loading') : t('search')}
          </button>
        </div>
      )}

      {error && (
        <div style={{ marginTop: 12, padding: '10px 14px', background: '#fee2e2', borderRadius: 8, color: '#b91c1c', fontSize: 13 }}>
          {error}
        </div>
      )}
      <div style={{ marginTop: 20 }}>
        {trips.length === 0 && !loading && !error && (
          <p style={{ color: '#94a3b8', textAlign: 'center', fontSize: 14 }}>{t('no_trips_found')}</p>
        )}
        {trips.map(trip => (
          <div key={trip.id} onClick={() => setSelectedTrip(trip)} style={cardStyle}>
            <div style={{ fontWeight: 700 }}>{trip.origin} → {trip.destination}</div>
            <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
              {new Date(trip.departure_time).toLocaleString('en-NG')} · {trip.operator_name}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8 }}>
              <span style={{ color: '#16a34a', fontWeight: 700 }}>{formatAmount(trip.base_fare)}</span>
              <span style={{ fontSize: 12, color: '#64748b' }}>{trip.available_seats} {t('available_seats')}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// P15-T6: useLiveSeatUpdates — WebSocket hook for real-time seat change notifications
// Connects to /trips/:id/ws (DO proxy) and invokes onSeatChange on each update.
// ============================================================
type LiveSeatStatus = 'available' | 'reserved' | 'confirmed' | 'blocked';
interface LiveSeatPayload { type: 'seat_changed'; seat: { id: string; status: LiveSeatStatus } }

function useLiveSeatUpdates(tripId: string, onSeatChange: (seat: { id: string; status: LiveSeatStatus }) => void) {
  const onSeatChangeRef = React.useRef(onSeatChange);
  onSeatChangeRef.current = onSeatChange;

  useEffect(() => {
    if (!tripId) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${window.location.host}/api/seat-inventory/trips/${tripId}/ws`;
    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;
    let consecutiveFailures = 0;
    const FALLBACK_AFTER_FAILURES = 5;
    const POLL_INTERVAL_MS = 10_000;

    // Fallback: poll seat availability every 10s when WebSocket is unavailable
    const startPolling = () => {
      if (pollInterval) return;
      pollInterval = setInterval(() => {
        if (cancelled) return;
        api.getSeatAvailability(tripId).then(data => {
          for (const seat of data.seats) {
            onSeatChangeRef.current({ id: seat.id, status: seat.status });
          }
        }).catch(() => {});
      }, POLL_INTERVAL_MS);
    };

    const stopPolling = () => {
      if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    };

    const connect = () => {
      if (cancelled) return;
      try {
        if (!('WebSocket' in window)) { startPolling(); return; }
        ws = new WebSocket(wsUrl);

        ws.onopen = () => {
          consecutiveFailures = 0;
          stopPolling(); // WebSocket recovered — stop polling
        };

        ws.onmessage = (ev) => {
          try {
            const data = JSON.parse(ev.data as string) as LiveSeatPayload;
            if (data.type === 'seat_changed' && data.seat) {
              onSeatChangeRef.current(data.seat);
            }
          } catch { /* ignore malformed frames */ }
        };

        ws.onclose = () => {
          if (!cancelled) {
            consecutiveFailures++;
            if (consecutiveFailures >= FALLBACK_AFTER_FAILURES) {
              // Switch to polling fallback after repeated WS failures
              startPolling();
            } else {
              reconnectTimeout = setTimeout(connect, 3000);
            }
          }
        };

        ws.onerror = () => { ws?.close(); };
      } catch {
        // WebSocket constructor unavailable — use polling
        startPolling();
      }
    };

    connect();

    return () => {
      cancelled = true;
      stopPolling();
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      ws?.close();
    };
  }, [tripId]);
}

// ============================================================
// Agent POS Module (TRN-2) — P07-enhanced with receipt, ID capture, float reconciliation, parks, session switcher
// ============================================================
const ID_TYPES = ['NIN', 'BVN', 'passport', 'drivers_license'] as const;
type PassengerIdType = (typeof ID_TYPES)[number];

function AgentPOSModule({ online }: { online: boolean }) {
  const { user, logout } = useAuth();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [tripsLoading, setTripsLoading] = useState(false);
  const [tripId, setTripId] = useState('');
  const [seatAvailability, setSeatAvailability] = useState<SeatAvailability | null>(null);
  const [seatsLoading, setSeatsLoading] = useState(false);
  const [selectedSeats, setSelectedSeats] = useState<string[]>([]);
  const [passengers, setPassengers] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<'cash' | 'mobile_money' | 'card'>('cash');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // P07-T5: Passenger ID
  const [passIdType, setPassIdType] = useState<PassengerIdType | ''>('');
  const [passIdNumber, setPassIdNumber] = useState('');

  // P07-T4: Bus Park
  const [parks, setParks] = useState<{ id: string; name: string; city: string }[]>([]);
  const [parkId, setParkId] = useState('');

  // P07-T2: Receipt modal
  const [receiptModal, setReceiptModal] = useState<ReceiptData | null>(null);

  // P07-T1: Float reconciliation
  const [eodOpen, setEodOpen] = useState(false);
  const [eodSubmitting, setEodSubmitting] = useState(false);
  const [eodCash, setEodCash] = useState('');
  const [eodNote, setEodNote] = useState('');
  const [eodTodayStats, setEodTodayStats] = useState<{ today_transactions: number; today_revenue_kobo: number } | null>(null);
  const [graceMode, setGraceMode] = useState(false);
  const [eodResult, setEodResult] = useState<{
    expected_kobo: number; submitted_kobo: number; discrepancy_kobo: number; status: string;
  } | null>(null);
  const [eodError, setEodError] = useState('');

  // P07-T3: Session switcher
  const [agentSessions, setAgentSessions] = useState<{ agent_id: string; name: string; expires_at: number }[]>([]);

  // P08-T5: POS mode toggle — individual sale vs. group booking
  const [posMode, setPosMode] = useState<'sale' | 'group'>('sale');
  const [grpName, setGrpName] = useState('');
  const [grpLeaderName, setGrpLeaderName] = useState('');
  const [grpLeaderPhone, setGrpLeaderPhone] = useState('');
  const [grpSeatClass, setGrpSeatClass] = useState<'standard' | 'window' | 'vip' | 'front'>('standard');
  const [grpPassengers, setGrpPassengers] = useState(''); // comma-separated
  const [grpSuccess, setGrpSuccess] = useState<{ group_booking_id: string; total_amount: number; payment_reference: string } | null>(null);
  const [grpError, setGrpError] = useState('');
  const [grpSubmitting, setGrpSubmitting] = useState(false);

  // Load active trips
  useEffect(() => {
    if (!online) return;
    setTripsLoading(true);
    api.getOperatorTrips()
      .then(data => setTrips(data.filter(tr => tr.state === 'scheduled' || tr.state === 'boarding')))
      .catch(() => setTrips([]))
      .finally(() => setTripsLoading(false));
  }, [online]);

  // Load bus parks
  useEffect(() => {
    if (!online) return;
    api.getBusParks()
      .then(data => setParks(data.map(p => ({ id: p.id, name: p.name, city: p.city }))))
      .catch(() => {/* non-fatal */});
  }, [online]);

  // Load cached agent sessions for switcher + detect grace mode for current user
  useEffect(() => {
    void (async () => {
      try {
        const { listAgentSessions, getAgentSession } = await import('./core/offline/db');
        const sessions = await listAgentSessions();
        setAgentSessions(sessions.map(s => ({ agent_id: s.agent_id, name: s.name, expires_at: s.expires_at })));
        // T3-3/T3-5: Check if current session is in grace period
        if (user?.id) {
          const sess = await getAgentSession(user.id, { offline: !online });
          setGraceMode(sess?.gracePeriod ?? false);
        }
      } catch { /* non-fatal */ }
    })();
  }, [user?.id, online]);

  // T1-9: Fetch today's transaction stats when EOD panel opens
  useEffect(() => {
    if (!eodOpen || !user?.id) return;
    api.getAgentDashboard(user.id)
      .then(stats => setEodTodayStats(stats))
      .catch(() => setEodTodayStats(null));
  }, [eodOpen, user?.id]);

  // Load seat availability when trip changes
  useEffect(() => {
    if (!tripId) { setSeatAvailability(null); setSelectedSeats([]); return; }
    setSeatsLoading(true);
    api.getSeatAvailability(tripId)
      .then(data => { setSeatAvailability(data); setSelectedSeats([]); })
      .catch(() => setSeatAvailability(null))
      .finally(() => setSeatsLoading(false));
  }, [tripId]);

  // P15-T6: Live seat updates via WebSocket (Durable Object fan-out)
  useLiveSeatUpdates(tripId, useCallback((updatedSeat) => {
    setSeatAvailability(prev => {
      if (!prev) return prev;
      return {
        ...prev,
        seats: prev.seats.map(s => s.id === updatedSeat.id ? { ...s, status: updatedSeat.status } : s),
      };
    });
    // Deselect seat if it became unavailable remotely
    if (updatedSeat.status !== 'available') {
      setSelectedSeats(prev => prev.filter(id => id !== updatedSeat.id));
    }
  }, []));

  // Auto-fill amount from trip base_fare × seat count
  useEffect(() => {
    const trip = trips.find(tr => tr.id === tripId);
    if (trip?.base_fare != null && selectedSeats.length > 0) {
      setAmount(String(Math.round(trip.base_fare * selectedSeats.length / 100)));
    } else if (selectedSeats.length === 0) {
      setAmount('');
    }
  }, [selectedSeats, tripId, trips]);

  const toggleSeat = (seatId: string) => {
    setSelectedSeats(prev => prev.includes(seatId) ? prev.filter(s => s !== seatId) : [...prev, seatId]);
  };

  const handleSale = async () => {
    if (!tripId || selectedSeats.length === 0 || !amount) return;
    setSubmitting(true);
    setError('');
    const amountKobo = Math.round(parseFloat(amount) * 100);
    const passArr = passengers.split(',').map(p => p.trim()).filter(Boolean);
    const agentId = user?.id ?? 'agent';

    if (!online) {
      const { saveOfflineTicket, generateTicketNumber } = await import('./core/offline/db');
      const ticket_number = generateTicketNumber();
      await saveOfflineTicket({
        ticket_number,
        operator_id: user?.operator_id ?? '',
        agent_id: agentId,
        trip_id: tripId,
        seat_ids: selectedSeats,
        passenger_names: passArr,
        fare_kobo: Math.round(amountKobo / Math.max(1, selectedSeats.length)),
        total_kobo: amountKobo,
        payment_method: method,
        status: 'draft',
      });
      // Show an offline receipt so the agent can print or share immediately.
      // The ticket will be confirmed on the server when connectivity is restored.
      const trip = trips.find(tr => tr.id === tripId);
      setReceiptModal({
        receipt_id: ticket_number,
        transaction_id: ticket_number,
        trip_origin: trip?.origin ?? trip?.route_id ?? '—',
        trip_destination: trip?.destination ?? '—',
        departure_time: trip?.departure_time ?? Date.now(),
        agent_name: user?.name ?? undefined,
        seat_numbers: selectedSeats,
        passenger_names: passArr,
        total_amount: amountKobo,
        payment_method: method,
        qr_code: ticket_number,
        issued_at: Date.now(),
      });
      setSubmitting(false);
      return;
    }

    try {
      const result = await api.recordSale({
        agent_id: agentId,
        trip_id: tripId,
        seat_ids: selectedSeats,
        passenger_names: passArr,
        total_amount: amountKobo,
        payment_method: method,
        passenger_id_type: passIdType || null,
        passenger_id_number: passIdNumber.trim() || null,
      });

      // Build receipt data for thermal print modal (P07-T2)
      const trip = trips.find(tr => tr.id === tripId);
      setReceiptModal({
        receipt_id: result.receipt_id,
        transaction_id: result.id,
        trip_origin: trip?.origin ?? trip?.route_id ?? '—',
        trip_destination: trip?.destination ?? '—',
        departure_time: trip?.departure_time ?? Date.now(),
        agent_name: user?.name ?? undefined,
        seat_numbers: result.seat_numbers ?? selectedSeats,
        passenger_names: passArr,
        total_amount: amountKobo,
        payment_method: method,
        qr_code: result.qr_code,
        issued_at: Date.now(),
      });

      // Reset form
      setTripId(''); setSelectedSeats([]); setSeatAvailability(null);
      setPassengers(''); setAmount(''); setPassIdType(''); setPassIdNumber('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : t('error'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleEodSubmit = async () => {
    if (!eodCash || !user) return;
    setEodSubmitting(true);
    setEodError('');
    const submittedKobo = Math.round(parseFloat(eodCash) * 100);
    const today = new Date().toISOString().slice(0, 10);
    try {
      const result = await api.submitReconciliation({
        agent_id: user.id,
        operator_id: user.operator_id ?? '',
        period_date: today,
        submitted_kobo: submittedKobo,
        ...(eodNote.trim() ? { notes: eodNote.trim() } : {}),
      });
      setEodResult(result);
      setEodCash(''); setEodNote('');
    } catch (e) {
      setEodError(e instanceof ApiError ? e.message : 'Failed to submit reconciliation');
    } finally {
      setEodSubmitting(false);
    }
  };

  const handleSwitchAgent = useCallback(() => {
    if (window.confirm('Switch agent? Your pending offline transactions are saved.')) {
      // T3-2: Flush sync queue first (errors are non-blocking — switch always proceeds)
      import('./core/offline/sync').then(({ syncEngine }) => {
        syncEngine.flush().catch(err => console.warn('[session-switch] flush failed:', err));
      }).catch(err => console.warn('[session-switch] import failed:', err))
        .finally(() => { logout(); });
    }
  }, [logout]);

  const formatKobo = (k: number) =>
    new Intl.NumberFormat('en-NG', { style: 'currency', currency: 'NGN' }).format(k / 100);

  // P08-T5: Group booking submission
  const handleGroupSale = async () => {
    if (!tripId || selectedSeats.length === 0 || !grpName || !grpLeaderName || !grpLeaderPhone) return;
    setGrpSubmitting(true);
    setGrpError('');
    setGrpSuccess(null);
    const passArr = grpPassengers
      ? grpPassengers.split(',').map(p => p.trim()).filter(Boolean)
      : Array.from({ length: selectedSeats.length }, (_, i) => `Passenger ${i + 1}`);
    // Pad passenger names to seat count if insufficient
    while (passArr.length < selectedSeats.length) passArr.push(`Passenger ${passArr.length + 1}`);
    try {
      const result = await api.createGroupBooking({
        trip_id: tripId,
        group_name: grpName,
        leader_name: grpLeaderName,
        leader_phone: grpLeaderPhone,
        seat_ids: selectedSeats,
        passenger_names: passArr.slice(0, selectedSeats.length),
        seat_class: grpSeatClass,
        payment_method: method,
        agent_id: user?.id ?? 'agent',
      });
      setGrpSuccess(result);
      setGrpName(''); setGrpLeaderName(''); setGrpLeaderPhone(''); setGrpPassengers('');
      setSelectedSeats([]); setTripId('');
    } catch (e) {
      setGrpError(e instanceof Error ? e.message : 'Group booking failed');
    } finally {
      setGrpSubmitting(false);
    }
  };

  return (
    <div style={{ padding: 16 }}>
      {/* P07-T3: Session switcher header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 18 }}>{t('agent_pos')}</h2>
          {user?.name && (
            <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
              Agent: <strong>{user.name}</strong>
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <InlineLangSelector />
          {agentSessions.length > 1 && (
            <button
              onClick={handleSwitchAgent}
              style={{
                padding: '5px 10px', borderRadius: 6, border: '1px solid #e2e8f0',
                background: '#fff', color: '#475569', fontSize: 11, cursor: 'pointer', fontWeight: 600,
              }}
            >
              Switch Agent
            </button>
          )}
          <button
            onClick={() => { setEodOpen(o => !o); setEodResult(null); setEodError(''); }}
            style={{
              padding: '5px 10px', borderRadius: 6, border: '1px solid #d97706',
              background: eodOpen ? '#fef3c7' : '#fff', color: '#b45309', fontSize: 11, cursor: 'pointer', fontWeight: 700,
            }}
          >
            End of Day
          </button>
        </div>
      </div>

      {/* P07-T1: End of Day float reconciliation panel */}
      {eodOpen && (
        <div style={{ ...cardStyle, background: '#fffbeb', borderColor: '#f59e0b', marginBottom: 14 }}>
          <div style={{ fontWeight: 700, color: '#92400e', marginBottom: 10, fontSize: 14 }}>
            Cash Float Reconciliation — {new Date().toLocaleDateString('en-NG')}
          </div>
          {eodResult ? (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8, marginBottom: 10 }}>
                {[
                  { label: 'Expected', value: formatKobo(eodResult.expected_kobo), color: '#1e40af' },
                  { label: 'Submitted', value: formatKobo(eodResult.submitted_kobo), color: '#16a34a' },
                  {
                    label: 'Discrepancy',
                    value: formatKobo(Math.abs(eodResult.discrepancy_kobo)),
                    // positive = shortage (red), negative = overage (orange), zero = balanced (green)
                    color: eodResult.discrepancy_kobo === 0 ? '#16a34a' : eodResult.discrepancy_kobo > 0 ? '#dc2626' : '#d97706',
                  },
                ].map(item => (
                  <div key={item.label} style={{ textAlign: 'center', padding: '8px 4px', background: '#fff', borderRadius: 6 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: item.color }}>{item.value}</div>
                    <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>{item.label}</div>
                  </div>
                ))}
              </div>
              <div style={{
                padding: '8px 12px', borderRadius: 6, textAlign: 'center', fontWeight: 700, fontSize: 13,
                background: eodResult.discrepancy_kobo === 0 ? '#f0fdf4' : '#fef3c7',
                color: eodResult.discrepancy_kobo === 0 ? '#16a34a' : '#92400e',
              }}>
                {eodResult.discrepancy_kobo === 0
                  ? '✓ Balanced — great work!'
                  : eodResult.discrepancy_kobo > 0
                    ? '⚠ Shortage — cash submitted is less than expected'
                    : '⚠ Overage — cash submitted exceeds expected'}
              </div>
              <button
                onClick={() => { setEodOpen(false); setEodResult(null); }}
                style={{ ...primaryBtnStyle, marginTop: 10, background: '#92400e', borderColor: '#92400e' }}
              >
                Close
              </button>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {/* T1-9: Today's transaction summary before cash input */}
              {eodTodayStats && (
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 4 }}>
                  <div style={{ textAlign: 'center', padding: '8px 4px', background: '#fff', borderRadius: 6, border: '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: 18, fontWeight: 800, color: '#1e40af' }}>{eodTodayStats.today_transactions}</div>
                    <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>Today's Sales</div>
                  </div>
                  <div style={{ textAlign: 'center', padding: '8px 4px', background: '#fff', borderRadius: 6, border: '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: 13, fontWeight: 800, color: '#16a34a' }}>{formatKobo(eodTodayStats.today_revenue_kobo)}</div>
                    <div style={{ fontSize: 10, color: '#64748b', marginTop: 2 }}>Expected Cash</div>
                  </div>
                </div>
              )}
              {eodError && (
                <div style={{ padding: '8px 12px', background: '#fee2e2', borderRadius: 6, color: '#b91c1c', fontSize: 12 }}>
                  {eodError}
                </div>
              )}
              <input
                type="number"
                placeholder="Cash collected (₦)"
                value={eodCash}
                onChange={e => setEodCash(e.target.value)}
                style={inputStyle}
              />
              <input
                placeholder="Notes (optional)"
                value={eodNote}
                onChange={e => setEodNote(e.target.value)}
                style={inputStyle}
              />
              <button
                onClick={() => void handleEodSubmit()}
                disabled={eodSubmitting || !eodCash}
                style={{ ...primaryBtnStyle, background: '#b45309', borderColor: '#b45309' }}
              >
                {eodSubmitting ? 'Submitting…' : 'Submit Reconciliation'}
              </button>
            </div>
          )}
        </div>
      )}

      {!online && (
        <div style={{ padding: '8px 14px', background: '#fef3c7', borderRadius: 8, color: '#92400e', fontSize: 12, marginBottom: 12 }}>
          Offline — sales will be queued and synced when connection is restored.
        </div>
      )}

      {/* T3-5: Grace period banner — JWT expired but within 8h offline window */}
      {graceMode && (
        <div style={{ padding: '8px 14px', background: '#fef9c3', border: '1px solid #facc15', borderRadius: 8, color: '#854d0e', fontSize: 12, marginBottom: 12 }}>
          ⚠ Session grace period active — your session has expired but you are allowed to continue working offline for up to 8 hours. Please sync and re-login as soon as you are back online.
        </div>
      )}

      {/* P08-T5: POS mode sub-tabs */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
        {(['sale', 'group'] as const).map(mode => (
          <button
            key={mode}
            onClick={() => { setPosMode(mode); setGrpError(''); setGrpSuccess(null); }}
            style={{
              flex: 1, padding: '8px 4px', borderRadius: 8, border: '2px solid',
              borderColor: posMode === mode ? '#2563eb' : '#e2e8f0',
              background: posMode === mode ? '#eff6ff' : '#fff',
              fontWeight: posMode === mode ? 700 : 400, fontSize: 12, cursor: 'pointer',
            }}
          >
            {mode === 'sale' ? '🎟 Individual Sale' : '👥 Group Booking'}
          </button>
        ))}
      </div>

      {error && posMode === 'sale' && (
        <div style={{ padding: '10px 14px', background: '#fee2e2', borderRadius: 8, color: '#b91c1c', fontSize: 13, marginBottom: 12 }}>
          {error}
        </div>
      )}

      <div style={{ display: posMode === 'sale' ? 'flex' : 'none', flexDirection: 'column', gap: 10 }}>
        {/* P07-T4: Park selector */}
        {parks.length > 0 && (
          <select value={parkId} onChange={e => setParkId(e.target.value)} style={inputStyle}>
            <option value="">-- Bus Park (optional) --</option>
            {parks.map(p => (
              <option key={p.id} value={p.id}>{p.name} · {p.city}</option>
            ))}
          </select>
        )}

        {/* Trip selector */}
        {online && trips.length > 0 ? (
          <select value={tripId} onChange={e => setTripId(e.target.value)} style={inputStyle}>
            <option value="">-- {t('select_trip')} --</option>
            {trips.map(tr => (
              <option key={tr.id} value={tr.id}>
                {tr.origin ?? tr.route_id} → {tr.destination ?? ''} · {new Date(tr.departure_time).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })} · {tr.available_seats ?? '?'} avail
              </option>
            ))}
          </select>
        ) : (
          <input
            placeholder={tripsLoading ? t('loading') : t('select_trip')}
            value={tripId}
            onChange={e => setTripId(e.target.value)}
            style={inputStyle}
            disabled={tripsLoading}
          />
        )}

        {/* Seat grid */}
        {tripId && (
          seatsLoading ? (
            <p style={{ color: '#94a3b8', textAlign: 'center', fontSize: 13, margin: '4px 0' }}>{t('loading')} seats…</p>
          ) : seatAvailability ? (
            <div style={{ marginTop: 2 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 6 }}>
                Seats — {selectedSeats.length} selected
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5 }}>
                {seatAvailability.seats.map(seat => {
                  const isAvail = seat.status === 'available';
                  const isSel = selectedSeats.includes(seat.id);
                  return (
                    <button
                      key={seat.id}
                      disabled={!isAvail}
                      onClick={() => { if (isAvail) toggleSeat(seat.id); }}
                      style={{
                        padding: '7px 4px', borderRadius: 6, fontSize: 11, fontWeight: 700,
                        cursor: isAvail ? 'pointer' : 'not-allowed',
                        border: '1.5px solid',
                        borderColor: isSel ? '#1e40af' : isAvail ? '#e2e8f0' : '#f1f5f9',
                        background: isSel ? '#1e40af' : isAvail ? '#fff' : '#f1f5f9',
                        color: isSel ? '#fff' : isAvail ? '#1e293b' : '#cbd5e1',
                      }}
                    >
                      {seat.seat_number}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null
        )}

        <input
          placeholder={selectedSeats.length > 0 ? `${t('passenger_name')} (${selectedSeats.length}, comma-separated)` : t('passenger_name')}
          value={passengers}
          onChange={e => setPassengers(e.target.value)}
          style={inputStyle}
        />

        {/* P07-T5: Passenger ID capture */}
        <div style={{ display: 'flex', gap: 6 }}>
          <select
            value={passIdType}
            onChange={e => setPassIdType(e.target.value as PassengerIdType | '')}
            style={{ ...inputStyle, flex: '0 0 140px' }}
          >
            <option value="">ID Type (opt.)</option>
            {ID_TYPES.map(t => (
              <option key={t} value={t}>{t.replace('_', ' ')}</option>
            ))}
          </select>
          <input
            placeholder="ID Number"
            value={passIdNumber}
            onChange={e => setPassIdNumber(e.target.value)}
            style={{ ...inputStyle, flex: 1 }}
            disabled={!passIdType}
          />
        </div>

        <input
          placeholder={`${t('fare')} (₦)`}
          type="number"
          value={amount}
          onChange={e => setAmount(e.target.value)}
          style={inputStyle}
        />
        <div style={{ display: 'flex', gap: 8 }}>
          {(['cash', 'mobile_money', 'card'] as const).map(m => (
            <button key={m} onClick={() => setMethod(m)} style={{
              flex: 1, padding: '10px 4px', borderRadius: 8, border: '2px solid',
              borderColor: method === m ? '#2563eb' : '#e2e8f0',
              background: method === m ? '#eff6ff' : '#fff',
              fontWeight: method === m ? 700 : 400, fontSize: 12, cursor: 'pointer',
            }}>
              {t(m)}
            </button>
          ))}
        </div>
        <button
          onClick={() => void handleSale()}
          disabled={submitting || !tripId || selectedSeats.length === 0 || !amount}
          style={primaryBtnStyle}
        >
          {submitting ? t('loading') : t('sale_complete')}
        </button>
      </div>

      {/* P08-T5: Group Booking Form */}
      {posMode === 'group' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {grpSuccess ? (
            <div style={{ padding: 16, background: '#f0fdf4', border: '1px solid #86efac', borderRadius: 10 }}>
              <div style={{ fontWeight: 700, color: '#16a34a', fontSize: 14, marginBottom: 6 }}>Group Booking Confirmed!</div>
              <div style={{ fontSize: 12, color: '#374151' }}>
                <div>Ref: <strong>{grpSuccess.payment_reference}</strong></div>
                <div>ID: <strong>{grpSuccess.group_booking_id}</strong></div>
                <div>Total: <strong>{formatKobo(grpSuccess.total_amount)}</strong></div>
              </div>
              <button onClick={() => setGrpSuccess(null)} style={{ ...primaryBtnStyle, marginTop: 10, background: '#16a34a', borderColor: '#16a34a' }}>
                New Group Booking
              </button>
            </div>
          ) : (
            <>
              {grpError && (
                <div style={{ padding: '8px 12px', background: '#fee2e2', borderRadius: 6, color: '#b91c1c', fontSize: 12 }}>
                  {grpError}
                </div>
              )}
              {/* Trip selector — shared with individual sale */}
              {online && trips.length > 0 ? (
                <select value={tripId} onChange={e => setTripId(e.target.value)} style={inputStyle}>
                  <option value="">-- Select Trip --</option>
                  {trips.map(tr => (
                    <option key={tr.id} value={tr.id}>
                      {tr.origin ?? tr.route_id} → {tr.destination ?? ''} · {new Date(tr.departure_time).toLocaleTimeString('en-NG', { hour: '2-digit', minute: '2-digit' })} · {tr.available_seats ?? '?'} avail
                    </option>
                  ))}
                </select>
              ) : (
                <input placeholder="Trip ID" value={tripId} onChange={e => setTripId(e.target.value)} style={inputStyle} />
              )}
              {/* Seat selector */}
              {tripId && seatAvailability && (
                <div>
                  <div style={{ fontSize: 12, fontWeight: 600, color: '#475569', marginBottom: 6 }}>Select Seats — {selectedSeats.length} selected</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 5 }}>
                    {seatAvailability.seats.map(seat => {
                      const isAvail = seat.status === 'available';
                      const isSel = selectedSeats.includes(seat.id);
                      return (
                        <button
                          key={seat.id}
                          disabled={!isAvail && !isSel}
                          onClick={() => toggleSeat(seat.id)}
                          style={{
                            padding: '7px 4px', borderRadius: 6, border: '1.5px solid',
                            borderColor: isSel ? '#16a34a' : isAvail ? '#cbd5e1' : '#f1f5f9',
                            background: isSel ? '#f0fdf4' : isAvail ? '#fff' : '#f8fafc',
                            color: isSel ? '#16a34a' : isAvail ? '#0f172a' : '#cbd5e1',
                            fontSize: 11, cursor: isAvail || isSel ? 'pointer' : 'not-allowed', fontWeight: isSel ? 700 : 400,
                          }}
                        >
                          {seat.seat_number}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              {/* Group info */}
              <input placeholder="Group Name (e.g. ABC School Trip)" value={grpName} onChange={e => setGrpName(e.target.value)} style={inputStyle} />
              <input placeholder="Leader Name" value={grpLeaderName} onChange={e => setGrpLeaderName(e.target.value)} style={inputStyle} />
              <input placeholder="Leader Phone (e.g. 08012345678)" value={grpLeaderPhone} onChange={e => setGrpLeaderPhone(e.target.value)} style={inputStyle} type="tel" />
              <input placeholder="Passenger Names (comma-separated, optional)" value={grpPassengers} onChange={e => setGrpPassengers(e.target.value)} style={inputStyle} />
              {/* Seat class */}
              <select value={grpSeatClass} onChange={e => setGrpSeatClass(e.target.value as typeof grpSeatClass)} style={inputStyle}>
                {(['standard', 'window', 'vip', 'front'] as const).map(sc => (
                  <option key={sc} value={sc}>{sc.charAt(0).toUpperCase() + sc.slice(1)}</option>
                ))}
              </select>
              {/* Payment method */}
              <div style={{ display: 'flex', gap: 8 }}>
                {(['cash', 'mobile_money', 'card'] as const).map(m => (
                  <button key={m} onClick={() => setMethod(m)} style={{
                    flex: 1, padding: '10px 4px', borderRadius: 8, border: '2px solid',
                    borderColor: method === m ? '#2563eb' : '#e2e8f0',
                    background: method === m ? '#eff6ff' : '#fff',
                    fontWeight: method === m ? 700 : 400, fontSize: 12, cursor: 'pointer',
                  }}>
                    {t(m)}
                  </button>
                ))}
              </div>
              <button
                onClick={() => void handleGroupSale()}
                disabled={grpSubmitting || !tripId || selectedSeats.length === 0 || !grpName || !grpLeaderName || !grpLeaderPhone}
                style={primaryBtnStyle}
              >
                {grpSubmitting ? 'Booking…' : `Confirm Group Booking (${selectedSeats.length} seats)`}
              </button>
            </>
          )}
        </div>
      )}

      {/* P07-T2: Thermal Receipt Modal */}
      {receiptModal && (
        <ReceiptModal
          receipt={receiptModal}
          onClose={() => setReceiptModal(null)}
        />
      )}
    </div>
  );
}

// ============================================================
// P09-T3: Operator Notification Panel — badge + slide-in drawer
// ============================================================
const SOS_EVENT_TYPES = ['trip:SOS_ACTIVATED'];
const COMPLIANCE_EVENT_TYPES = ['vehicle.maintenance_due_soon', 'vehicle.document_expiring', 'driver.document_expiring'];

function notificationColor(eventType: string): string {
  if (SOS_EVENT_TYPES.includes(eventType)) return '#dc2626';
  if (COMPLIANCE_EVENT_TYPES.includes(eventType)) return '#d97706';
  return '#2563eb';
}

function notificationLabel(n: OperatorNotification): string {
  const labels: Record<string, string> = {
    'trip:SOS_ACTIVATED': 'SOS Alert',
    'agent.reconciliation_filed': 'Reconciliation Filed',
    'vehicle.maintenance_due_soon': 'Maintenance Due',
    'vehicle.document_expiring': 'Vehicle Doc Expiring',
    'driver.document_expiring': 'Driver Doc Expiring',
    'booking:ABANDONED': 'Abandoned Booking',
    'payment:AMOUNT_MISMATCH': 'Payment Mismatch',
    'trip:DELAYED': 'Trip Delayed',
    'booking:REFUNDED': 'Booking Refunded',
  };
  return labels[n.event_type] ?? n.event_type;
}

function useOperatorNotifications() {
  const [notifications, setNotifications] = useState<OperatorNotification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);

  const refresh = useCallback(() => {
    api.getOperatorNotifications()
      .then(res => {
        setNotifications(res.notifications);
        setUnreadCount(res.unread_count);
      })
      .catch(() => {/* silently ignore if operator role not active */});
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  const markRead = useCallback(async (eventId: string) => {
    await api.markNotificationRead(eventId).catch(() => {});
    setNotifications(prev => prev.map(n => n.id === eventId ? { ...n, is_read: true, read_at: Date.now() } : n));
    setUnreadCount(prev => Math.max(0, prev - 1));
  }, []);

  return { notifications, unreadCount, markRead, refresh };
}

function NotificationPanel({ notifications, unreadCount, markRead, onClose }: {
  notifications: OperatorNotification[];
  unreadCount: number;
  markRead: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const sosCounts = notifications.filter(n => SOS_EVENT_TYPES.includes(n.event_type) && !n.is_read).length;

  return (
    <div style={{
      position: 'fixed', top: 0, right: 0, bottom: 0, width: 320, maxWidth: '92vw',
      background: '#fff', boxShadow: '-4px 0 24px rgba(0,0,0,0.15)', zIndex: 9999,
      display: 'flex', flexDirection: 'column', overflowY: 'hidden',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 16px', borderBottom: '1px solid #e2e8f0' }}>
        <div>
          <span style={{ fontWeight: 700, fontSize: 16 }}>Notifications</span>
          {unreadCount > 0 && (
            <span style={{ marginLeft: 8, background: '#dc2626', color: '#fff', borderRadius: 10, padding: '1px 7px', fontSize: 11, fontWeight: 700 }}>
              {unreadCount}
            </span>
          )}
        </div>
        <button onClick={onClose} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#64748b' }}>✕</button>
      </div>

      {sosCounts > 0 && (
        <div style={{ background: '#dc2626', color: '#fff', padding: '10px 16px', fontSize: 13, fontWeight: 600 }}>
          ⚠ {sosCounts} active SOS alert{sosCounts > 1 ? 's' : ''} — respond immediately
        </div>
      )}

      <div style={{ overflowY: 'auto', flex: 1 }}>
        {notifications.length === 0 ? (
          <p style={{ textAlign: 'center', color: '#94a3b8', padding: 24, fontSize: 14 }}>No notifications in the last 7 days</p>
        ) : notifications.map(n => (
          <div
            key={n.id}
            onClick={() => { if (!n.is_read) void markRead(n.id); }}
            style={{
              padding: '12px 16px', borderBottom: '1px solid #f1f5f9', cursor: n.is_read ? 'default' : 'pointer',
              background: n.is_read ? '#fff' : '#f8fafc',
              borderLeft: `4px solid ${notificationColor(n.event_type)}`,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <span style={{ fontWeight: n.is_read ? 400 : 700, fontSize: 13, color: notificationColor(n.event_type) }}>
                {notificationLabel(n)}
              </span>
              {!n.is_read && (
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: notificationColor(n.event_type), display: 'inline-block', marginTop: 3, flexShrink: 0 }} />
              )}
            </div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 3 }}>
              {new Date(n.created_at).toLocaleString()}
            </div>
            {n.aggregate_id && (
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                ID: {n.aggregate_id}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Operator Dashboard Module (TRN-4) — Routes, Vehicles, Trips
// ============================================================
type OperatorView = 'overview' | 'routes' | 'vehicles' | 'trips' | 'drivers' | 'agents' | 'reports' | 'dispatch' | 'api-keys';

function OperatorOverview({ onNav }: { onNav: (v: OperatorView) => void }) {
  const [stats, setStats] = useState<OperatorStats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getOperatorDashboard()
      .then(setStats)
      .catch(() => setStats(null))
      .finally(() => setLoading(false));
  }, []);

  const tripStates = ['scheduled', 'boarding', 'in_transit', 'completed', 'cancelled'] as const;
  const stateColors: Record<string, string> = {
    scheduled: '#2563eb', boarding: '#d97706', in_transit: '#16a34a',
    completed: '#64748b', cancelled: '#dc2626',
  };

  return (
    <>
      <h2 style={{ margin: '0 0 4px', fontSize: 18 }}>{t('operator')}</h2>
      <p style={{ margin: '0 0 16px', fontSize: 12, color: '#64748b' }}>{t('dashboard')}</p>
      {loading ? (
        <p style={{ color: '#94a3b8', textAlign: 'center' }}>{t('loading')}</p>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
            {tripStates.map(state => (
              <div key={state} style={{ ...cardStyle, borderLeft: `4px solid ${stateColors[state]}`, cursor: 'default' }}>
                <div style={{ fontSize: 22, fontWeight: 800, color: stateColors[state] }}>{stats?.trips[state] ?? 0}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 2, textTransform: 'capitalize' }}>{state.replace('_', ' ')}</div>
              </div>
            ))}
            {stats?.today_revenue_kobo != null && (
              <div style={{ ...cardStyle, borderLeft: '4px solid #16a34a', cursor: 'default', gridColumn: 'span 2' }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#16a34a' }}>
                  {formatAmount(stats.today_revenue_kobo)}
                </div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>Today's Revenue</div>
              </div>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <button onClick={() => onNav('routes')} style={navCardStyle}>
              <span style={{ fontSize: 24 }}>🗺️</span>
              <span style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>{t('manage_routes')}</span>
            </button>
            <button onClick={() => onNav('vehicles')} style={navCardStyle}>
              <span style={{ fontSize: 24 }}>🚌</span>
              <span style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>{t('manage_vehicles')}</span>
            </button>
            <button onClick={() => onNav('trips')} style={navCardStyle}>
              <span style={{ fontSize: 24 }}>📋</span>
              <span style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>Manage Trips</span>
            </button>
            <button onClick={() => onNav('drivers')} style={navCardStyle}>
              <span style={{ fontSize: 24 }}>🧑‍✈️</span>
              <span style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>Manage Drivers</span>
            </button>
            <button onClick={() => onNav('agents')} style={navCardStyle}>
              <span style={{ fontSize: 24 }}>👤</span>
              <span style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>Manage Agents</span>
            </button>
            <button onClick={() => onNav('dispatch')} style={{ ...navCardStyle, gridColumn: 'span 2' }}>
              <span style={{ fontSize: 24 }}>🗺</span>
              <span style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>Dispatcher Dashboard</span>
            </button>
            <button onClick={() => onNav('reports')} style={{ ...navCardStyle, gridColumn: 'span 2' }}>
              <span style={{ fontSize: 24 }}>📊</span>
              <span style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>Revenue Reports</span>
            </button>
            <button onClick={() => onNav('api-keys')} style={{ ...navCardStyle, gridColumn: 'span 2' }}>
              <span style={{ fontSize: 24 }}>🔑</span>
              <span style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>API Keys</span>
            </button>
          </div>
        </>
      )}
    </>
  );
}

// ============================================================
// P10-T2: DispatcherDashboard — active trips with GPS + seats
// ============================================================
function DispatcherDashboard({ onBack }: { onBack: () => void }) {
  const [data, setData] = useState<DispatchDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await api.getDispatchDashboard());
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to load dispatch data');
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const stateColor: Record<string, string> = {
    scheduled: '#2563eb', boarding: '#d97706', in_transit: '#16a34a',
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={backBtnStyle}>←</button>
        <div style={{ flex: 1 }}>
          <h2 style={{ margin: 0, fontSize: 18 }}>Dispatcher Dashboard</h2>
          {data && <div style={{ fontSize: 11, color: '#64748b' }}>As of {new Date(data.as_of).toLocaleTimeString('en-NG')}</div>}
        </div>
        <button onClick={() => void load()} style={{ background: '#eff6ff', border: 'none', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 12, color: '#2563eb', fontWeight: 600 }}>
          Refresh
        </button>
      </div>

      {loading ? (
        <p style={{ color: '#94a3b8', textAlign: 'center' }}>Loading…</p>
      ) : error ? (
        <div style={{ padding: 14, background: '#fee2e2', borderRadius: 8, color: '#b91c1c', fontSize: 13 }}>{error}</div>
      ) : !data || data.trips.length === 0 ? (
        <div style={{ textAlign: 'center', padding: 32, color: '#94a3b8', fontSize: 14 }}>
          <div style={{ fontSize: 40, marginBottom: 8 }}>🚌</div>
          No active trips at the moment
        </div>
      ) : (
        data.trips.map((trip: DispatchTrip) => (
          <div key={trip.id} style={{ ...cardStyle, cursor: 'default', marginBottom: 10, borderLeft: `4px solid ${stateColor[trip.state] ?? '#64748b'}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>
                {trip.origin} → {trip.destination}
              </div>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                background: `${stateColor[trip.state] ?? '#64748b'}22`,
                color: stateColor[trip.state] ?? '#64748b',
                textTransform: 'uppercase',
              }}>
                {trip.state.replace('_', ' ')}
              </span>
            </div>

            <div style={{ fontSize: 12, color: '#475569', marginBottom: 6 }}>
              🕐 {new Date(trip.departure_time).toLocaleString('en-NG', { timeZone: 'Africa/Lagos', dateStyle: 'short', timeStyle: 'short' })}
            </div>

            {/* Seat counts */}
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
              {[
                { label: 'Avail', val: trip.seats.available, color: '#16a34a' },
                { label: 'Conf', val: trip.seats.confirmed, color: '#2563eb' },
                { label: 'Resv', val: trip.seats.reserved, color: '#d97706' },
                { label: 'Total', val: trip.seats.total, color: '#64748b' },
              ].map(({ label, val, color }) => (
                <div key={label} style={{ fontSize: 11, fontWeight: 700, color, background: `${color}11`, padding: '2px 8px', borderRadius: 8 }}>
                  {label}: {val}
                </div>
              ))}
            </div>

            {/* Driver & vehicle */}
            <div style={{ display: 'flex', gap: 12, fontSize: 12, color: '#64748b' }}>
              {trip.driver && (
                <span>🧑‍✈️ {trip.driver.name} · {trip.driver.phone}</span>
              )}
              {trip.vehicle && (
                <span>🚌 {trip.vehicle.plate_number}{trip.vehicle.model ? ` (${trip.vehicle.model})` : ''}</span>
              )}
            </div>

            {trip.location && (
              <div style={{ marginTop: 4, fontSize: 11, color: '#64748b' }}>
                📍 {trip.location.latitude.toFixed(4)}, {trip.location.longitude.toFixed(4)}
              </div>
            )}

            <div style={{ marginTop: 4, fontSize: 11, color: '#94a3b8' }}>
              {trip.confirmed_bookings} confirmed booking{trip.confirmed_bookings !== 1 ? 's' : ''} · ID: {trip.id}
            </div>
          </div>
        ))
      )}
    </>
  );
}

// ============================================================
// P11-T1: ApiKeysPanel — list, create, revoke operator API keys
// ============================================================
function ApiKeysPanel({ onBack }: { onBack: () => void }) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', scope: 'read' as 'read' | 'read_write' });
  const [creating, setCreating] = useState(false);
  const [newKey, setNewKey] = useState<ApiKeyCreated | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try { setKeys(await api.listApiKeys()); } catch { setKeys([]); } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async () => {
    if (!form.name.trim()) { setError('Key name is required'); return; }
    setCreating(true);
    setError('');
    try {
      const created = await api.createApiKey({ name: form.name.trim(), scope: form.scope });
      setNewKey(created);
      setShowForm(false);
      setForm({ name: '', scope: 'read' });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to create API key');
    } finally { setCreating(false); }
  };

  const handleRevoke = async (id: string) => {
    if (!confirm('Revoke this API key? Any integrations using it will stop working.')) return;
    setRevoking(id);
    try {
      await api.revokeApiKey(id);
      await load();
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Failed to revoke key');
    } finally { setRevoking(null); }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const activeKeys = keys.filter(k => !k.revoked_at);
  const revokedKeys = keys.filter(k => k.revoked_at);

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={backBtnStyle}>←</button>
        <h2 style={{ margin: 0, fontSize: 18, flex: 1 }}>API Keys</h2>
        <button onClick={() => { setShowForm(s => !s); setNewKey(null); setError(''); }} style={{ ...primaryBtnStyle, padding: '8px 14px', fontSize: 13 }}>
          {showForm ? 'Cancel' : '+ New Key'}
        </button>
      </div>

      {newKey && (
        <div style={{ ...cardStyle, cursor: 'default', background: '#f0fdf4', border: '1.5px solid #16a34a', marginBottom: 14 }}>
          <div style={{ fontWeight: 700, fontSize: 14, color: '#15803d', marginBottom: 6 }}>Key created — copy it now, it won't be shown again</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, background: '#fff', borderRadius: 8, padding: '8px 10px', border: '1px solid #dcfce7' }}>
            <code style={{ flex: 1, fontSize: 11, wordBreak: 'break-all', color: '#166534' }}>{newKey.key}</code>
            <button
              onClick={() => handleCopy(newKey.key)}
              style={{ ...primaryBtnStyle, padding: '6px 10px', fontSize: 11, background: copied ? '#16a34a' : '#2563eb' }}
            >
              {copied ? 'Copied!' : 'Copy'}
            </button>
          </div>
          <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>
            Name: {newKey.name} · Scope: {newKey.scope} · Created: {new Date(newKey.created_at).toLocaleDateString('en-NG')}
          </div>
          <button onClick={() => setNewKey(null)} style={{ marginTop: 8, background: 'none', border: 'none', color: '#94a3b8', fontSize: 11, cursor: 'pointer' }}>Dismiss</button>
        </div>
      )}

      {showForm && (
        <div style={{ ...cardStyle, marginBottom: 16, cursor: 'default' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input
              placeholder="Key name (e.g. Mobile App, POS Terminal)"
              value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
              style={inputStyle}
            />
            <select
              value={form.scope}
              onChange={e => setForm(f => ({ ...f, scope: e.target.value as 'read' | 'read_write' }))}
              style={inputStyle}
            >
              <option value="read">Read only — view trips & schedules</option>
              <option value="read_write">Read & write — create bookings</option>
            </select>
            {error && <p style={{ color: '#dc2626', fontSize: 12, margin: 0 }}>{error}</p>}
            <button onClick={() => void handleCreate()} disabled={creating} style={primaryBtnStyle}>
              {creating ? 'Creating...' : 'Create API Key'}
            </button>
          </div>
        </div>
      )}

      <p style={{ margin: '0 0 10px', fontSize: 12, color: '#64748b' }}>
        Use API keys to integrate WebWaka with your apps, POS terminals, or booking websites.
      </p>

      {loading ? (
        <p style={{ color: '#94a3b8', textAlign: 'center' }}>Loading...</p>
      ) : activeKeys.length === 0 && revokedKeys.length === 0 ? (
        <p style={{ color: '#94a3b8', textAlign: 'center', fontSize: 14 }}>No API keys yet. Create one to get started.</p>
      ) : (
        <>
          {activeKeys.map(k => (
            <div key={k.id} style={{ ...cardStyle, cursor: 'default' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{k.name}</div>
                  <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                    Scope: <strong>{k.scope === 'read_write' ? 'Read & Write' : 'Read only'}</strong>
                    {' · '}Created: {new Date(k.created_at).toLocaleDateString('en-NG')}
                    {k.last_used_at ? ` · Last used: ${new Date(k.last_used_at).toLocaleDateString('en-NG')}` : ' · Never used'}
                  </div>
                  <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>ID: {k.id}</div>
                </div>
                <button
                  onClick={() => void handleRevoke(k.id)}
                  disabled={revoking === k.id}
                  style={{ background: '#fef2f2', color: '#dc2626', border: '1px solid #fca5a5', borderRadius: 8, padding: '5px 10px', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}
                >
                  {revoking === k.id ? '...' : 'Revoke'}
                </button>
              </div>
            </div>
          ))}
          {revokedKeys.length > 0 && (
            <>
              <div style={{ margin: '12px 0 6px', fontSize: 12, fontWeight: 600, color: '#94a3b8' }}>Revoked Keys</div>
              {revokedKeys.map(k => (
                <div key={k.id} style={{ ...cardStyle, cursor: 'default', opacity: 0.55 }}>
                  <div style={{ fontWeight: 600, fontSize: 13, textDecoration: 'line-through', color: '#94a3b8' }}>{k.name}</div>
                  <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>
                    {k.scope} · Revoked: {k.revoked_at ? new Date(k.revoked_at).toLocaleDateString('en-NG') : '—'}
                  </div>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </>
  );
}

// ============================================================
// Route Stops sub-panel (used inline in RoutesPanel)
// ============================================================
function RouteStopsPanel({ routeId, onClose }: { routeId: string; onClose: () => void }) {
  const [stops, setStops] = useState<RouteStop[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // draft list for editing
  const [draft, setDraft] = useState<{ stop_name: string; distance_from_origin_km: string; fare_from_origin_kobo: string }[]>([]);
  const [dirty, setDirty] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getRouteStops(routeId);
      setStops(data);
      setDraft(data.map(s => ({
        stop_name: s.stop_name,
        distance_from_origin_km: s.distance_from_origin_km != null ? String(s.distance_from_origin_km) : '',
        fare_from_origin_kobo: s.fare_from_origin_kobo != null ? String(s.fare_from_origin_kobo / 100) : '',
      })));
      setDirty(false);
    } catch { setStops([]); setDraft([]); } finally { setLoading(false); }
  }, [routeId]);

  useEffect(() => { void load(); }, [load]);

  const addStop = () => {
    setDraft(d => [...d, { stop_name: '', distance_from_origin_km: '', fare_from_origin_kobo: '' }]);
    setDirty(true);
  };

  const updateStop = (idx: number, field: string, val: string) => {
    setDraft(d => d.map((s, i) => i === idx ? { ...s, [field]: val } : s));
    setDirty(true);
  };

  const removeStop = (idx: number) => {
    setDraft(d => d.filter((_, i) => i !== idx));
    setDirty(true);
  };

  const handleSave = async () => {
    const valid = draft.filter(s => s.stop_name.trim());
    if (valid.length === 0) { setError('Add at least one stop name'); return; }
    setSaving(true);
    setError('');
    try {
      await api.setRouteStops(routeId, valid.map((s, idx) => ({
        stop_name: s.stop_name.trim(),
        sequence: idx + 1,
        ...(s.distance_from_origin_km ? { distance_from_origin_km: parseFloat(s.distance_from_origin_km) } : {}),
        ...(s.fare_from_origin_kobo ? { fare_from_origin_kobo: Math.round(parseFloat(s.fare_from_origin_kobo) * 100) } : {}),
      })));
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to save stops');
    } finally { setSaving(false); }
  };

  return (
    <div style={{ marginTop: 10, padding: '12px 14px', background: '#f8fafc', borderRadius: 10, border: '1px solid #e2e8f0' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <span style={{ fontWeight: 700, fontSize: 13 }}>Intermediate Stops ({stops.length})</span>
        <div style={{ display: 'flex', gap: 6 }}>
          {dirty && (
            <button onClick={() => void handleSave()} disabled={saving} style={{ ...primaryBtnStyle, padding: '5px 10px', fontSize: 12 }}>
              {saving ? 'Saving...' : 'Save'}
            </button>
          )}
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#94a3b8', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>×</button>
        </div>
      </div>
      {loading ? (
        <p style={{ color: '#94a3b8', fontSize: 12, margin: 0 }}>Loading stops...</p>
      ) : (
        <>
          {draft.length === 0 && !dirty && (
            <p style={{ color: '#94a3b8', fontSize: 12, margin: '0 0 8px' }}>No intermediate stops yet. Add stops for multi-stop ticketing.</p>
          )}
          {draft.map((s, idx) => (
            <div key={idx} style={{ display: 'flex', gap: 6, alignItems: 'flex-start', marginBottom: 6 }}>
              <span style={{ minWidth: 20, paddingTop: 10, fontSize: 11, color: '#94a3b8', fontWeight: 600 }}>{idx + 1}.</span>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
                <input
                  placeholder="Stop name (e.g. Ore)"
                  value={s.stop_name}
                  onChange={e => updateStop(idx, 'stop_name', e.target.value)}
                  style={{ ...inputStyle, padding: '7px 10px', fontSize: 12 }}
                />
                <div style={{ display: 'flex', gap: 4 }}>
                  <input
                    placeholder="Distance from origin (km)"
                    type="number"
                    value={s.distance_from_origin_km}
                    onChange={e => updateStop(idx, 'distance_from_origin_km', e.target.value)}
                    style={{ ...inputStyle, padding: '5px 8px', fontSize: 11, flex: 1 }}
                  />
                  <input
                    placeholder="Fare from origin (₦)"
                    type="number"
                    value={s.fare_from_origin_kobo}
                    onChange={e => updateStop(idx, 'fare_from_origin_kobo', e.target.value)}
                    style={{ ...inputStyle, padding: '5px 8px', fontSize: 11, flex: 1 }}
                  />
                </div>
              </div>
              <button onClick={() => removeStop(idx)} style={{ background: 'none', border: 'none', color: '#dc2626', fontSize: 18, cursor: 'pointer', paddingTop: 6 }}>×</button>
            </div>
          ))}
          {error && <p style={{ color: '#dc2626', fontSize: 12, margin: '4px 0 0' }}>{error}</p>}
          <button onClick={addStop} style={{ marginTop: 6, background: 'none', border: '1.5px dashed #cbd5e1', borderRadius: 8, color: '#475569', fontSize: 12, padding: '7px 12px', cursor: 'pointer', width: '100%' }}>
            + Add Stop
          </button>
        </>
      )}
    </div>
  );
}

function RoutesPanel({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const [routes, setRoutes] = useState<Route[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ origin: '', destination: '', base_fare: '', operator_id: user?.operator_id ?? '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [expandedStopsRouteId, setExpandedStopsRouteId] = useState<string | null>(null);
  const [expandedFareRulesRouteId, setExpandedFareRulesRouteId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getOperatorRoutes();
      setRoutes(data);
    } catch { setRoutes([]); } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async () => {
    const operatorId = user?.operator_id ?? form.operator_id;
    if (!form.origin || !form.destination || !form.base_fare || !operatorId) {
      setError('All fields required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.createRoute({
        origin: form.origin,
        destination: form.destination,
        base_fare: Math.round(parseFloat(form.base_fare) * 100),
        operator_id: operatorId,
      });
      setShowForm(false);
      setForm({ origin: '', destination: '', base_fare: '', operator_id: user?.operator_id ?? '' });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to create route');
    } finally { setSaving(false); }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={backBtnStyle}>←</button>
        <h2 style={{ margin: 0, fontSize: 18, flex: 1 }}>{t('manage_routes')}</h2>
        <button onClick={() => setShowForm(s => !s)} style={{ ...primaryBtnStyle, padding: '8px 14px', fontSize: 13 }}>
          {showForm ? 'Cancel' : '+ Add'}
        </button>
      </div>
      {showForm && (
        <div style={{ ...cardStyle, marginBottom: 16, cursor: 'default' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input placeholder="Origin (e.g. Lagos)" value={form.origin} onChange={e => setForm(f => ({ ...f, origin: e.target.value }))} style={inputStyle} />
            <input placeholder="Destination (e.g. Abuja)" value={form.destination} onChange={e => setForm(f => ({ ...f, destination: e.target.value }))} style={inputStyle} />
            <input placeholder="Base fare (₦)" type="number" value={form.base_fare} onChange={e => setForm(f => ({ ...f, base_fare: e.target.value }))} style={inputStyle} />
            {user?.operator_id ? (
              <div style={{ padding: '10px 14px', background: '#eff6ff', borderRadius: 10, fontSize: 13, color: '#1e40af', fontWeight: 600 }}>
                Operator: {user.operator_id}
              </div>
            ) : (
              <input placeholder="Operator ID (Super Admin)" value={form.operator_id} onChange={e => setForm(f => ({ ...f, operator_id: e.target.value }))} style={inputStyle} />
            )}
            {error && <p style={{ color: '#dc2626', fontSize: 12, margin: 0 }}>{error}</p>}
            <button onClick={() => void handleCreate()} disabled={saving} style={primaryBtnStyle}>
              {saving ? t('loading') : 'Create Route'}
            </button>
          </div>
        </div>
      )}
      {loading ? (
        <p style={{ color: '#94a3b8', textAlign: 'center' }}>{t('loading')}</p>
      ) : routes.length === 0 ? (
        <p style={{ color: '#94a3b8', textAlign: 'center', fontSize: 14 }}>No routes found</p>
      ) : (
        routes.map(r => (
          <div key={r.id} style={{ ...cardStyle, cursor: 'default' }}>
            <div style={{ fontWeight: 700 }}>{r.origin} → {r.destination}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6, alignItems: 'center' }}>
              <span style={{ color: '#16a34a', fontWeight: 700 }}>{formatAmount(r.base_fare)}</span>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 12,
                background: r.status === 'active' ? '#dcfce7' : '#f1f5f9',
                color: r.status === 'active' ? '#16a34a' : '#64748b',
              }}>{r.status}</span>
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>ID: {r.id}</div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              <button
                onClick={() => setExpandedStopsRouteId(v => v === r.id ? null : r.id)}
                style={{ background: 'none', border: '1px solid #e2e8f0', borderRadius: 7, color: '#475569', fontSize: 11, padding: '5px 10px', cursor: 'pointer', fontWeight: 600 }}
              >
                {expandedStopsRouteId === r.id ? 'Hide Stops ▲' : 'Manage Stops ▼'}
              </button>
              <button
                onClick={() => setExpandedFareRulesRouteId(v => v === r.id ? null : r.id)}
                style={{ background: 'none', border: '1px solid #bfdbfe', borderRadius: 7, color: '#1e40af', fontSize: 11, padding: '5px 10px', cursor: 'pointer', fontWeight: 600 }}
              >
                {expandedFareRulesRouteId === r.id ? 'Hide Fare Rules ▲' : 'Fare Rules ▼'}
              </button>
            </div>
            {expandedStopsRouteId === r.id && (
              <RouteStopsPanel routeId={r.id} onClose={() => setExpandedStopsRouteId(null)} />
            )}
            {expandedFareRulesRouteId === r.id && (
              <FareRulesPanel routeId={r.id} routeLabel={`${r.origin} → ${r.destination}`} />
            )}
          </div>
        ))
      )}
    </>
  );
}

function VehiclesPanel({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ operator_id: user?.operator_id ?? '', plate_number: '', model: '', total_seats: '', vehicle_type: 'bus' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setVehicles(await api.getVehicles());
    } catch { setVehicles([]); } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async () => {
    const operatorId = user?.operator_id ?? form.operator_id;
    if (!operatorId || !form.plate_number || !form.total_seats) {
      setError('All fields required');
      return;
    }
    setSaving(true);
    setError('');
    try {
      await api.createVehicle({
        operator_id: operatorId,
        plate_number: form.plate_number,
        vehicle_type: form.vehicle_type,
        total_seats: parseInt(form.total_seats, 10),
        ...(form.model ? { model: form.model } : {}),
      });
      setShowForm(false);
      setForm({ operator_id: user?.operator_id ?? '', plate_number: '', model: '', total_seats: '', vehicle_type: 'bus' });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Failed to register vehicle');
    } finally { setSaving(false); }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={backBtnStyle}>←</button>
        <h2 style={{ margin: 0, fontSize: 18, flex: 1 }}>{t('manage_vehicles')}</h2>
        <button onClick={() => setShowForm(s => !s)} style={{ ...primaryBtnStyle, padding: '8px 14px', fontSize: 13 }}>
          {showForm ? 'Cancel' : '+ Add'}
        </button>
      </div>
      {showForm && (
        <div style={{ ...cardStyle, marginBottom: 16, cursor: 'default' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {user?.operator_id ? (
              <div style={{ padding: '10px 14px', background: '#eff6ff', borderRadius: 10, fontSize: 13, color: '#1e40af', fontWeight: 600 }}>
                Operator: {user.operator_id}
              </div>
            ) : (
              <input placeholder="Operator ID (Super Admin)" value={form.operator_id} onChange={e => setForm(f => ({ ...f, operator_id: e.target.value }))} style={inputStyle} />
            )}
            <input placeholder="Plate number (e.g. LAG-123-XY)" value={form.plate_number} onChange={e => setForm(f => ({ ...f, plate_number: e.target.value }))} style={inputStyle} />
            <input placeholder="Model (e.g. Toyota Coaster)" value={form.model} onChange={e => setForm(f => ({ ...f, model: e.target.value }))} style={inputStyle} />
            <input placeholder="Capacity (seats)" type="number" value={form.total_seats} onChange={e => setForm(f => ({ ...f, total_seats: e.target.value }))} style={inputStyle} />
            <select value={form.vehicle_type} onChange={e => setForm(f => ({ ...f, vehicle_type: e.target.value }))} style={inputStyle}>
              <option value="bus">Bus</option>
              <option value="minibus">Minibus</option>
              <option value="car">Car</option>
            </select>
            {error && <p style={{ color: '#dc2626', fontSize: 12, margin: 0 }}>{error}</p>}
            <button onClick={() => void handleCreate()} disabled={saving} style={primaryBtnStyle}>
              {saving ? t('loading') : 'Register Vehicle'}
            </button>
          </div>
        </div>
      )}
      {loading ? (
        <p style={{ color: '#94a3b8', textAlign: 'center' }}>{t('loading')}</p>
      ) : vehicles.length === 0 ? (
        <p style={{ color: '#94a3b8', textAlign: 'center', fontSize: 14 }}>No vehicles found</p>
      ) : (
        vehicles.map(v => (
          <div key={v.id} style={{ ...cardStyle, cursor: 'default' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontWeight: 700 }}>{v.plate_number}</div>
                <div style={{ fontSize: 13, color: '#64748b', marginTop: 2 }}>{v.model ?? 'N/A'} · {v.total_seats} seats</div>
              </div>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 12,
                background: v.status === 'active' ? '#dcfce7' : '#f1f5f9',
                color: v.status === 'active' ? '#16a34a' : '#64748b',
              }}>{v.status}</span>
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4, textTransform: 'capitalize' }}>{v.vehicle_type}</div>
          </div>
        ))
      )}
    </>
  );
}

function TripsPanel({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const [trips, setTrips] = useState<Trip[]>([]);
  const [loading, setLoading] = useState(true);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [routes, setRoutes] = useState<Route[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [createForm, setCreateForm] = useState({ route_id: '', vehicle_id: '', departure_time: '', base_fare: '', total_seats: '' });
  const [saving, setSaving] = useState(false);
  const [createError, setCreateError] = useState('');
  const [manifestTripId, setManifestTripId] = useState<string | null>(null);
  const [manifest, setManifest] = useState<TripManifest | null>(null);
  const [loadingManifest, setLoadingManifest] = useState(false);
  const [copyingTripId, setCopyingTripId] = useState<string | null>(null);
  const [copyTime, setCopyTime] = useState('');

  const stateColors: Record<string, string> = {
    scheduled: '#2563eb', boarding: '#d97706', in_transit: '#16a34a',
    completed: '#64748b', cancelled: '#dc2626',
  };

  const nextStates: Record<string, string[]> = {
    scheduled: ['boarding', 'cancelled'],
    boarding: ['in_transit', 'cancelled'],
    in_transit: ['completed'],
    completed: [],
    cancelled: [],
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [tripsData, driversData] = await Promise.all([
        api.getOperatorTrips(),
        api.getDrivers(user?.operator_id ? { operator_id: user.operator_id } : {}),
      ]);
      setTrips(tripsData);
      setDrivers(driversData.filter(d => d.status === 'active'));
    } catch { setTrips([]); } finally { setLoading(false); }
  }, [user?.operator_id]);

  useEffect(() => { void load(); }, [load]);

  // Load routes + vehicles for the create form dropdowns
  useEffect(() => {
    if (!showForm) return;
    Promise.all([api.getOperatorRoutes(), api.getVehicles()])
      .then(([r, v]) => { setRoutes(r); setVehicles(v); })
      .catch(() => {});
  }, [showForm]);

  const assignDriver = async (tripId: string, driverId: string) => {
    setUpdatingId(tripId);
    try {
      await api.updateTrip(tripId, { driver_id: driverId || null });
      await load();
    } catch { /* ignore */ } finally { setUpdatingId(null); }
  };

  // Auto-fill base_fare when route changes
  const handleRouteChange = (routeId: string) => {
    const route = routes.find(r => r.id === routeId);
    setCreateForm(f => ({
      ...f,
      route_id: routeId,
      base_fare: route ? String(Math.round(route.base_fare / 100)) : f.base_fare,
    }));
  };

  // Auto-fill total_seats when vehicle changes
  const handleVehicleChange = (vehicleId: string) => {
    const vehicle = vehicles.find(v => v.id === vehicleId);
    setCreateForm(f => ({
      ...f,
      vehicle_id: vehicleId,
      total_seats: vehicle ? String(vehicle.total_seats) : f.total_seats,
    }));
  };

  const handleCreate = async () => {
    if (!createForm.route_id || !createForm.vehicle_id || !createForm.departure_time) {
      setCreateError('Route, vehicle and departure time are required');
      return;
    }
    const departureMs = new Date(createForm.departure_time).getTime();
    if (isNaN(departureMs)) { setCreateError('Invalid departure time'); return; }

    setSaving(true);
    setCreateError('');
    try {
      await api.createTrip({
        route_id: createForm.route_id,
        vehicle_id: createForm.vehicle_id,
        departure_time: departureMs,
        ...(createForm.base_fare ? { base_fare: Math.round(parseFloat(createForm.base_fare) * 100) } : {}),
        ...(createForm.total_seats ? { total_seats: parseInt(createForm.total_seats, 10) } : {}),
      });
      setShowForm(false);
      setCreateForm({ route_id: '', vehicle_id: '', departure_time: '', base_fare: '', total_seats: '' });
      await load();
    } catch (e) {
      setCreateError(e instanceof ApiError ? e.message : 'Failed to create trip');
    } finally { setSaving(false); }
  };

  const transition = async (tripId: string, newState: string) => {
    setUpdatingId(tripId);
    try {
      await api.transitionTrip(tripId, newState);
      await load();
    } catch { /* ignore */ } finally { setUpdatingId(null); }
  };

  const startCopy = (trip: Trip) => {
    const nextDay = new Date(trip.departure_time + 86400_000);
    const pad = (n: number) => String(n).padStart(2, '0');
    const local = `${nextDay.getFullYear()}-${pad(nextDay.getMonth() + 1)}-${pad(nextDay.getDate())}T${pad(nextDay.getHours())}:${pad(nextDay.getMinutes())}`;
    setCopyingTripId(trip.id);
    setCopyTime(local);
  };

  const handleCopy = async (tripId: string) => {
    const ms = new Date(copyTime).getTime();
    if (isNaN(ms)) return;
    try {
      await api.copyTrip(tripId, ms);
      setCopyingTripId(null);
      setCopyTime('');
      await load();
    } catch { /* ignore */ }
  };

  const loadManifest = async (tripId: string) => {
    if (manifestTripId === tripId) { setManifestTripId(null); setManifest(null); return; }
    setManifestTripId(tripId);
    setManifest(null);
    setLoadingManifest(true);
    try {
      setManifest(await api.getTripManifest(tripId));
    } catch { setManifest(null); }
    finally { setLoadingManifest(false); }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={backBtnStyle}>←</button>
        <h2 style={{ margin: 0, fontSize: 18, flex: 1 }}>Manage Trips</h2>
        <button onClick={() => void load()} style={{ ...secondaryBtnStyle, padding: '8px 14px', fontSize: 13 }}>↻</button>
        <button onClick={() => setShowForm(s => !s)} style={{ ...primaryBtnStyle, padding: '8px 14px', fontSize: 13 }}>
          {showForm ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {showForm && (
        <div style={{ ...cardStyle, marginBottom: 16, cursor: 'default' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <select
              value={createForm.route_id}
              onChange={e => handleRouteChange(e.target.value)}
              style={inputStyle}
            >
              <option value="">-- Select Route --</option>
              {routes.map(r => (
                <option key={r.id} value={r.id}>{r.origin} → {r.destination} · {formatAmount(r.base_fare)}</option>
              ))}
            </select>
            <select
              value={createForm.vehicle_id}
              onChange={e => handleVehicleChange(e.target.value)}
              style={inputStyle}
            >
              <option value="">-- Select Vehicle --</option>
              {vehicles.map(v => (
                <option key={v.id} value={v.id}>{v.plate_number} · {v.model ?? v.vehicle_type} · {v.total_seats} seats</option>
              ))}
            </select>
            <input
              type="datetime-local"
              value={createForm.departure_time}
              onChange={e => setCreateForm(f => ({ ...f, departure_time: e.target.value }))}
              style={inputStyle}
            />
            <input
              placeholder="Base fare (₦) — defaults to route fare"
              type="number"
              value={createForm.base_fare}
              onChange={e => setCreateForm(f => ({ ...f, base_fare: e.target.value }))}
              style={inputStyle}
            />
            <input
              placeholder="Seats — defaults to vehicle capacity"
              type="number"
              value={createForm.total_seats}
              onChange={e => setCreateForm(f => ({ ...f, total_seats: e.target.value }))}
              style={inputStyle}
            />
            {createError && <p style={{ color: '#dc2626', fontSize: 12, margin: 0 }}>{createError}</p>}
            <button onClick={() => void handleCreate()} disabled={saving} style={primaryBtnStyle}>
              {saving ? t('loading') : 'Schedule Trip'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <p style={{ color: '#94a3b8', textAlign: 'center' }}>{t('loading')}</p>
      ) : trips.length === 0 ? (
        <p style={{ color: '#94a3b8', textAlign: 'center', fontSize: 14 }}>No trips found</p>
      ) : (
        trips.map(trip => {
          const possibleNext = nextStates[trip.state] ?? [];
          return (
            <div key={trip.id} style={{ ...cardStyle, cursor: 'default' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{trip.origin ?? trip.route_id} → {trip.destination ?? ''}</div>
                  <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>
                    {new Date(trip.departure_time).toLocaleString('en-NG')}
                  </div>
                </div>
                <span style={{
                  fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 12,
                  background: `${stateColors[trip.state] ?? '#64748b'}20`,
                  color: stateColors[trip.state] ?? '#64748b',
                  whiteSpace: 'nowrap',
                }}>{trip.state.replace('_', ' ')}</span>
              </div>
              <div style={{ fontSize: 12, color: '#64748b', marginTop: 4 }}>
                {trip.available_seats ?? '—'} available
                {trip.base_fare != null && ` · ${formatAmount(trip.base_fare)}`}
              </div>
              {drivers.length > 0 && (
                <select
                  value={trip.driver_id ?? ''}
                  disabled={updatingId === trip.id}
                  onChange={e => void assignDriver(trip.id, e.target.value)}
                  style={{ ...inputStyle, marginTop: 8, fontSize: 12 }}
                >
                  <option value="">— Assign Driver —</option>
                  {drivers.map(d => (
                    <option key={d.id} value={d.id}>{d.name} · {d.phone}</option>
                  ))}
                </select>
              )}
              {possibleNext.length > 0 && (
                <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                  {possibleNext.map(ns => (
                    <button
                      key={ns}
                      disabled={updatingId === trip.id}
                      onClick={() => void transition(trip.id, ns)}
                      style={{
                        flex: 1, padding: '7px 4px', borderRadius: 8, border: '1.5px solid',
                        borderColor: stateColors[ns] ?? '#e2e8f0',
                        background: `${stateColors[ns] ?? '#64748b'}10`,
                        color: stateColors[ns] ?? '#64748b',
                        fontWeight: 600, fontSize: 11, cursor: 'pointer',
                      }}
                    >
                      → {ns.replace('_', ' ')}
                    </button>
                  ))}
                </div>
              )}
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                <button
                  onClick={() => void loadManifest(trip.id)}
                  style={{
                    flex: 1, padding: '7px', borderRadius: 8,
                    border: '1.5px solid #2563eb20', background: '#eff6ff',
                    color: '#2563eb', fontWeight: 600, fontSize: 12, cursor: 'pointer',
                  }}
                >
                  {manifestTripId === trip.id ? '▲ Manifest' : '▼ Manifest'}
                </button>
                {trip.state !== 'cancelled' && (
                  <button
                    onClick={() => copyingTripId === trip.id ? (setCopyingTripId(null), setCopyTime('')) : startCopy(trip)}
                    style={{
                      padding: '7px 12px', borderRadius: 8,
                      border: '1.5px solid #d97706', background: copyingTripId === trip.id ? '#fef3c7' : '#fff',
                      color: '#d97706', fontWeight: 600, fontSize: 12, cursor: 'pointer',
                    }}
                  >
                    {copyingTripId === trip.id ? '✕' : '⧉ Copy'}
                  </button>
                )}
              </div>

              {copyingTripId === trip.id && (
                <div style={{ marginTop: 8, display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                  <input
                    type="datetime-local"
                    value={copyTime}
                    onChange={e => setCopyTime(e.target.value)}
                    style={{ ...inputStyle, flex: 1, minWidth: 160, fontSize: 12, padding: '6px 8px' }}
                  />
                  <button
                    onClick={() => void handleCopy(trip.id)}
                    disabled={!copyTime}
                    style={{ ...primaryBtnStyle, padding: '7px 14px', fontSize: 12, whiteSpace: 'nowrap' }}
                  >
                    Confirm Copy
                  </button>
                </div>
              )}

              {manifestTripId === trip.id && (
                <div style={{ marginTop: 8 }}>
                  {loadingManifest ? (
                    <p style={{ color: '#94a3b8', fontSize: 12, textAlign: 'center' }}>{t('loading')}</p>
                  ) : manifest ? (
                    <ManifestPanel manifest={manifest} />
                  ) : (
                    <p style={{ color: '#dc2626', fontSize: 12 }}>Failed to load manifest</p>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </>
  );
}

function ManifestPanel({ manifest }: { manifest: TripManifest }) {
  const { summary, passengers, trip } = manifest;
  const payColors: Record<string, string> = { paid: '#16a34a', pending: '#d97706', refunded: '#6366f1' };
  return (
    <div style={{ borderTop: '1px solid #e2e8f0', paddingTop: 10 }}>
      {trip.driver && (
        <div style={{ fontSize: 12, color: '#475569', background: '#f1f5f9', borderRadius: 6, padding: '6px 10px', marginBottom: 8 }}>
          <strong>Driver:</strong> {trip.driver.name} · {trip.driver.phone}
          {trip.driver.license_number && <span style={{ color: '#64748b' }}> · {trip.driver.license_number}</span>}
        </div>
      )}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10, fontSize: 12 }}>
        <span style={{ color: '#64748b' }}>
          <strong>{summary.total_bookings}</strong> booked / <strong>{summary.total_seats}</strong> seats
          ({summary.load_factor}% load)
        </span>
        <span style={{ color: '#16a34a', fontWeight: 700 }}>
          {formatAmount(summary.confirmed_revenue_kobo)} collected
        </span>
      </div>
      {passengers.length === 0 ? (
        <p style={{ color: '#94a3b8', fontSize: 12, textAlign: 'center' }}>No passengers yet</p>
      ) : (
        passengers.map((p: ManifestEntry) => (
          <div key={p.booking_id} style={{
            padding: '8px 10px', borderRadius: 8, background: '#f8fafc',
            border: '1px solid #e2e8f0', marginBottom: 6,
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontWeight: 700, fontSize: 13 }}>{p.customer_name}</span>
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 10,
                background: `${payColors[p.payment_status] ?? '#64748b'}20`,
                color: payColors[p.payment_status] ?? '#64748b',
              }}>{p.payment_status}</span>
            </div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
              {p.passenger_names.join(', ')}
              {p.seat_ids.length > 0 && (
                <span style={{ marginLeft: 6 }}>
                  · Seats: {p.seat_ids.map(s => s.split('_s')[1] ?? s).join(', ')}
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: '#64748b', marginTop: 1 }}>
              {formatAmount(p.total_amount)} · #{p.booking_id.slice(-8)}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

// ============================================================
// Drivers Panel (TRN-4)
// ============================================================
function DriversPanel({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const [drivers, setDrivers] = useState<Driver[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', phone: '', license_number: '', operator_id: user?.operator_id ?? '' });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getDrivers(user?.operator_id ? { operator_id: user.operator_id } : {});
      setDrivers(data);
    } catch { setDrivers([]); } finally { setLoading(false); }
  }, [user?.operator_id]);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async () => {
    if (!form.name || !form.phone) { setFormError('Name and phone are required'); return; }
    const operatorId = (form.operator_id || user?.operator_id) ?? '';
    if (!operatorId) { setFormError('Operator ID required'); return; }
    setSaving(true); setFormError('');
    try {
      await api.createDriver({
        operator_id: operatorId,
        name: form.name,
        phone: form.phone,
        ...(form.license_number ? { license_number: form.license_number } : {}),
      });
      setShowForm(false);
      setForm({ name: '', phone: '', license_number: '', operator_id: user?.operator_id ?? '' });
      await load();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : 'Failed to create driver');
    } finally { setSaving(false); }
  };

  const toggleStatus = async (driver: Driver) => {
    const newStatus = driver.status === 'active' ? 'suspended' : 'active';
    try {
      await api.updateDriver(driver.id, { status: newStatus });
      await load();
    } catch { /* ignore */ }
  };

  const statusColors: Record<string, string> = { active: '#16a34a', suspended: '#dc2626', inactive: '#64748b' };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={backBtnStyle}>←</button>
        <h2 style={{ margin: 0, fontSize: 18, flex: 1 }}>Manage Drivers</h2>
        <button onClick={() => void load()} style={{ ...secondaryBtnStyle, padding: '8px 14px', fontSize: 13 }}>↻</button>
        <button onClick={() => setShowForm(s => !s)} style={{ ...primaryBtnStyle, padding: '8px 14px', fontSize: 13 }}>
          {showForm ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {showForm && (
        <div style={{ ...cardStyle, marginBottom: 16, cursor: 'default' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input placeholder="Full name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={inputStyle} />
            <input placeholder="Phone number" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} style={inputStyle} />
            <input placeholder="License number (optional)" value={form.license_number} onChange={e => setForm(f => ({ ...f, license_number: e.target.value }))} style={inputStyle} />
            {!user?.operator_id && (
              <input placeholder="Operator ID" value={form.operator_id} onChange={e => setForm(f => ({ ...f, operator_id: e.target.value }))} style={inputStyle} />
            )}
            {formError && <p style={{ color: '#dc2626', fontSize: 12, margin: 0 }}>{formError}</p>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleCreate} disabled={saving} style={{ ...primaryBtnStyle, flex: 1 }}>
                {saving ? 'Saving…' : 'Create Driver'}
              </button>
              <button onClick={() => { setShowForm(false); setFormError(''); }} style={{ ...secondaryBtnStyle, flex: 1 }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <p style={{ color: '#94a3b8', textAlign: 'center' }}>{t('loading')}</p>
      ) : drivers.length === 0 ? (
        <p style={{ color: '#94a3b8', textAlign: 'center', marginTop: 32 }}>No drivers yet. Add one to get started.</p>
      ) : (
        drivers.map(d => (
          <div key={d.id} style={{ ...cardStyle, cursor: 'default', marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 700 }}>{d.name}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{d.phone}</div>
                {d.license_number && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 1 }}>🪪 {d.license_number}</div>}
              </div>
              <span style={{
                fontSize: 11, fontWeight: 700, padding: '3px 9px', borderRadius: 12,
                background: `${statusColors[d.status] ?? '#64748b'}20`,
                color: statusColors[d.status] ?? '#64748b',
              }}>{d.status}</span>
            </div>
            <button
              onClick={() => void toggleStatus(d)}
              style={{ ...secondaryBtnStyle, marginTop: 10, width: '100%', fontSize: 12 }}
            >
              {d.status === 'active' ? 'Suspend' : 'Reactivate'}
            </button>
          </div>
        ))
      )}
    </>
  );
}

// ============================================================
// Agents Panel (TRN-4)
// ============================================================
function AgentsPanel({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const [agents, setAgents] = useState<Agent[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: '', phone: '', email: '', role: 'agent',
    bus_parks: '', operator_id: user?.operator_id ?? '',
  });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getAgents(user?.operator_id ? { operator_id: user.operator_id } : {});
      setAgents(data);
    } catch { setAgents([]); } finally { setLoading(false); }
  }, [user?.operator_id]);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async () => {
    if (!form.name || !form.phone) { setFormError('Name and phone are required'); return; }
    const operatorId = (form.operator_id || user?.operator_id) ?? '';
    if (!operatorId) { setFormError('Operator ID required'); return; }
    setSaving(true); setFormError('');
    try {
      const parsedParks = form.bus_parks ? form.bus_parks.split(',').map(s => s.trim()).filter(Boolean) : [];
      await api.createAgent({
        operator_id: operatorId,
        name: form.name,
        phone: form.phone,
        ...(form.email ? { email: form.email } : {}),
        role: form.role || 'agent',
        ...(parsedParks.length > 0 ? { bus_parks: parsedParks } : {}),
      });
      setShowForm(false);
      setForm({ name: '', phone: '', email: '', role: 'agent', bus_parks: '', operator_id: user?.operator_id ?? '' });
      await load();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : 'Failed to create agent');
    } finally { setSaving(false); }
  };

  const toggleStatus = async (agent: Agent) => {
    const newStatus = agent.status === 'active' ? 'suspended' : 'active';
    try { await api.updateAgent(agent.id, { status: newStatus }); await load(); } catch { /* ignore */ }
  };

  const roleColors: Record<string, string> = { agent: '#2563eb', supervisor: '#7c3aed' };
  const statusColors: Record<string, string> = { active: '#16a34a', suspended: '#dc2626', inactive: '#64748b' };

  const parseBusParks = (raw: string): string[] => {
    try { return JSON.parse(raw) as string[]; } catch { return []; }
  };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={backBtnStyle}>←</button>
        <h2 style={{ margin: 0, fontSize: 18, flex: 1 }}>Manage Agents</h2>
        <button onClick={() => void load()} style={{ ...secondaryBtnStyle, padding: '8px 14px', fontSize: 13 }}>↻</button>
        <button onClick={() => setShowForm(s => !s)} style={{ ...primaryBtnStyle, padding: '8px 14px', fontSize: 13 }}>
          {showForm ? 'Cancel' : '+ Add'}
        </button>
      </div>

      {showForm && (
        <div style={{ ...cardStyle, marginBottom: 16, cursor: 'default' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input placeholder="Full name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={inputStyle} />
            <input placeholder="Phone number" value={form.phone} onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} style={inputStyle} />
            <input placeholder="Email (optional)" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} style={inputStyle} />
            <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))} style={inputStyle}>
              <option value="agent">Agent (POS)</option>
              <option value="supervisor">Supervisor</option>
            </select>
            <input placeholder="Bus parks (comma-separated IDs, optional)" value={form.bus_parks} onChange={e => setForm(f => ({ ...f, bus_parks: e.target.value }))} style={inputStyle} />
            {!user?.operator_id && (
              <input placeholder="Operator ID" value={form.operator_id} onChange={e => setForm(f => ({ ...f, operator_id: e.target.value }))} style={inputStyle} />
            )}
            {formError && <p style={{ color: '#dc2626', fontSize: 12, margin: 0 }}>{formError}</p>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleCreate} disabled={saving} style={{ ...primaryBtnStyle, flex: 1 }}>{saving ? 'Saving…' : 'Create Agent'}</button>
              <button onClick={() => { setShowForm(false); setFormError(''); }} style={{ ...secondaryBtnStyle, flex: 1 }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <p style={{ color: '#94a3b8', textAlign: 'center' }}>{t('loading')}</p>
      ) : agents.length === 0 ? (
        <p style={{ color: '#94a3b8', textAlign: 'center', marginTop: 32 }}>No agents yet. Add one to get started.</p>
      ) : (
        agents.map(a => {
          const parks = parseBusParks(a.bus_parks);
          return (
            <div key={a.id} style={{ ...cardStyle, cursor: 'default', marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontWeight: 700 }}>{a.name}</div>
                  <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{a.phone}{a.email && ` · ${a.email}`}</div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
                    background: `${roleColors[a.role] ?? '#64748b'}20`,
                    color: roleColors[a.role] ?? '#64748b',
                  }}>{a.role}</span>
                  <span style={{
                    fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 10,
                    background: `${statusColors[a.status] ?? '#64748b'}20`,
                    color: statusColors[a.status] ?? '#64748b',
                  }}>{a.status}</span>
                </div>
              </div>
              {parks.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6 }}>
                  {parks.map(p => (
                    <span key={p} style={{ fontSize: 10, padding: '2px 6px', borderRadius: 6, background: '#f1f5f9', color: '#475569', border: '1px solid #e2e8f0' }}>{p}</span>
                  ))}
                </div>
              )}
              <button
                onClick={() => void toggleStatus(a)}
                style={{ ...secondaryBtnStyle, marginTop: 10, width: '100%', fontSize: 12 }}
              >
                {a.status === 'active' ? 'Suspend' : 'Reactivate'}
              </button>
            </div>
          );
        })
      )}
    </>
  );
}

// ============================================================
// Reports Panel (TRN-4)
// ============================================================
type ReportPreset = 'today' | 'week' | 'month' | 'all';

function ReportsPanel({ onBack }: { onBack: () => void }) {
  const { user } = useAuth();
  const [report, setReport] = useState<RevenueReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [preset, setPreset] = useState<ReportPreset>('today');

  const loadReport = useCallback(async (p: ReportPreset) => {
    setLoading(true);
    const now = Date.now();
    let from: number;
    switch (p) {
      case 'today': from = new Date().setHours(0, 0, 0, 0); break;
      case 'week': from = now - 7 * 24 * 3600_000; break;
      case 'month': from = now - 30 * 24 * 3600_000; break;
      default: from = 0;
    }
    try {
      setReport(await api.getRevenueReport({
        from,
        to: now,
        ...(user?.operator_id ? { operator_id: user.operator_id } : {}),
      }));
    } catch { setReport(null); } finally { setLoading(false); }
  }, [user?.operator_id]);

  useEffect(() => { void loadReport(preset); }, [loadReport, preset]);

  const presetLabels: Record<ReportPreset, string> = { today: 'Today', week: 'Last 7 days', month: 'Last 30 days', all: 'All time' };

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <button onClick={onBack} style={backBtnStyle}>←</button>
        <h2 style={{ margin: 0, fontSize: 18, flex: 1 }}>Revenue Reports</h2>
        <button onClick={() => void loadReport(preset)} style={{ ...secondaryBtnStyle, padding: '8px 14px', fontSize: 13 }}>↻</button>
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {(['today', 'week', 'month', 'all'] as ReportPreset[]).map(p => (
          <button
            key={p}
            onClick={() => setPreset(p)}
            style={{
              padding: '6px 12px', borderRadius: 8, border: '1.5px solid',
              borderColor: preset === p ? '#2563eb' : '#e2e8f0',
              background: preset === p ? '#eff6ff' : '#fff',
              color: preset === p ? '#2563eb' : '#64748b',
              fontWeight: preset === p ? 700 : 400, fontSize: 12, cursor: 'pointer',
            }}
          >{presetLabels[p]}</button>
        ))}
      </div>

      {loading ? (
        <p style={{ color: '#94a3b8', textAlign: 'center' }}>{t('loading')}</p>
      ) : !report ? (
        <p style={{ color: '#dc2626', fontSize: 12, textAlign: 'center' }}>Failed to load report</p>
      ) : (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginBottom: 16 }}>
            <div style={{ ...cardStyle, cursor: 'default', borderLeft: '4px solid #16a34a' }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: '#16a34a' }}>{formatAmount(report.total_revenue_kobo)}</div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>Total Revenue</div>
            </div>
            <div style={{ ...cardStyle, cursor: 'default', borderLeft: '4px solid #2563eb' }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: '#2563eb' }}>{formatAmount(report.booking_revenue_kobo)}</div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>Online Bookings</div>
            </div>
            <div style={{ ...cardStyle, cursor: 'default', borderLeft: '4px solid #d97706' }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: '#d97706' }}>{formatAmount(report.agent_sales_revenue_kobo)}</div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>Agent Sales</div>
            </div>
            <div style={{ ...cardStyle, cursor: 'default', borderLeft: '4px solid #7c3aed' }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: '#7c3aed' }}>{report.total_bookings + report.total_agent_transactions}</div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>Total Transactions</div>
            </div>
          </div>

          {report.top_routes.length > 0 && (
            <div style={{ ...cardStyle, cursor: 'default' }}>
              <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 8 }}>Top Routes</div>
              {report.top_routes.map((r: RouteRevenue) => (
                <div key={r.route_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid #f1f5f9' }}>
                  <div>
                    <span style={{ fontWeight: 600, fontSize: 12 }}>{r.origin} → {r.destination}</span>
                  </div>
                  <span style={{ fontSize: 12, color: '#64748b' }}>{r.trip_count} trip{r.trip_count !== 1 ? 's' : ''}</span>
                </div>
              ))}
            </div>
          )}
          {report.top_routes.length === 0 && (
            <p style={{ color: '#94a3b8', textAlign: 'center', fontSize: 12 }}>No route data for this period</p>
          )}
        </>
      )}
    </>
  );
}

function OperatorDashboardModule() {
  const [view, setView] = useState<OperatorView>('overview');
  const [panelOpen, setPanelOpen] = useState(false);
  const { notifications, unreadCount, markRead } = useOperatorNotifications();
  const { user } = useAuth();

  // P11-T2: Onboarding wizard detection — show for new TENANT_ADMIN operators
  const [showWizard, setShowWizard] = useState(false);
  const [wizardChecked, setWizardChecked] = useState(false);

  useEffect(() => {
    if (user?.role !== 'TENANT_ADMIN' || !user?.operator_id) { setWizardChecked(true); return; }
    const wasExited = localStorage.getItem('webwaka_onboarding_exited') === '1';
    if (wasExited) { setWizardChecked(true); return; }
    // If the wizard was started but not finished (step saved), always resume it
    const savedStep = localStorage.getItem('webwaka_onboarding_step');
    if (savedStep) { setShowWizard(true); setWizardChecked(true); return; }
    // For brand new operators: show wizard when there are no routes AND no vehicles yet
    Promise.all([
      api.getOperatorRoutes().catch(() => [] as Route[]),
      api.getVehicles().catch(() => [] as Vehicle[]),
    ]).then(([routes, vehicles]) => {
      if (routes.length === 0 && vehicles.length === 0) setShowWizard(true);
      setWizardChecked(true);
    }).catch(() => setWizardChecked(true));
  }, [user]);

  const handleWizardComplete = useCallback(() => {
    localStorage.setItem('webwaka_onboarding_exited', '1');
    setShowWizard(false);
  }, []);

  const sosActive = notifications.some(n => SOS_EVENT_TYPES.includes(n.event_type) && !n.is_read);

  return (
    <div style={{ padding: 16 }}>
      {/* P11-T2: Onboarding wizard for new operators */}
      {showWizard && user?.operator_id && (
        <OnboardingWizard
          operatorId={user.operator_id}
          operatorName=""
          onComplete={handleWizardComplete}
        />
      )}

      {/* SOS persistent banner — only cleared when SOS notifications are read */}
      {sosActive && (
        <div style={{
          background: '#dc2626', color: '#fff', padding: '10px 14px', borderRadius: 8,
          marginBottom: 12, fontWeight: 700, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span>⚠ ACTIVE SOS ALERT — trip in distress. Check notifications for details.</span>
        </div>
      )}

      {/* Notification badge button */}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <button
          onClick={() => setPanelOpen(true)}
          style={{
            position: 'relative', background: '#fff', border: '1px solid #e2e8f0',
            borderRadius: 20, padding: '6px 14px', cursor: 'pointer', fontSize: 13,
            display: 'flex', alignItems: 'center', gap: 6, boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
          }}
        >
          🔔
          {unreadCount > 0 && (
            <span style={{
              position: 'absolute', top: -4, right: -4,
              background: '#dc2626', color: '#fff', borderRadius: 10,
              padding: '1px 6px', fontSize: 10, fontWeight: 700, minWidth: 16, textAlign: 'center',
            }}>
              {unreadCount}
            </span>
          )}
        </button>
      </div>

      {view === 'overview' && <OperatorOverview onNav={setView} />}
      {view === 'routes' && <RoutesPanel onBack={() => setView('overview')} />}
      {view === 'vehicles' && <VehiclesPanel onBack={() => setView('overview')} />}
      {view === 'trips' && <TripsPanel onBack={() => setView('overview')} />}
      {view === 'drivers' && <DriversPanel onBack={() => setView('overview')} />}
      {view === 'agents' && <AgentsPanel onBack={() => setView('overview')} />}
      {view === 'reports' && <ReportsPanel onBack={() => setView('overview')} />}
      {view === 'dispatch' && <DispatcherDashboard onBack={() => setView('overview')} />}
      {view === 'api-keys' && <ApiKeysPanel onBack={() => setView('overview')} />}

      {panelOpen && (
        <>
          <div
            onClick={() => setPanelOpen(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 9998 }}
          />
          <NotificationPanel
            notifications={notifications}
            unreadCount={unreadCount}
            markRead={markRead}
            onClose={() => setPanelOpen(false)}
          />
        </>
      )}
    </div>
  );
}

// ============================================================
// My Bookings Module (TRN-3)
// ============================================================
function MyBookingsModule() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const loadBookings = useCallback(() => {
    setLoading(true);
    api.getBookings()
      .then(data => setBookings(data))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadBookings(); }, [loadBookings]);

  const handleCancel = async (id: string) => {
    if (!confirm('Cancel this booking?')) return;
    setCancelling(id);
    try {
      await api.cancelBooking(id);
      loadBookings();
    } catch (e) {
      alert(e instanceof ApiError ? e.message : 'Failed to cancel booking');
    } finally { setCancelling(null); }
  };

  const statusColors: Record<string, string> = {
    pending: '#d97706', confirmed: '#16a34a', cancelled: '#dc2626', completed: '#64748b',
  };

  return (
    <div style={{ padding: 16 }}>
      <h2 style={{ margin: '0 0 16px', fontSize: 18 }}>{t('my_bookings')}</h2>
      {loading ? (
        <p style={{ color: '#94a3b8', textAlign: 'center' }}>{t('loading')}</p>
      ) : error ? (
        <div style={{ padding: '10px 14px', background: '#fee2e2', borderRadius: 8, color: '#b91c1c', fontSize: 13 }}>{error}</div>
      ) : bookings.length === 0 ? (
        <p style={{ color: '#94a3b8', textAlign: 'center', fontSize: 14 }}>{t('no_trips_found')}</p>
      ) : (
        bookings.map(bkg => {
          const isExpanded = expandedId === bkg.id;
          const safeSeatIds: string[] = (() => {
            if (Array.isArray(bkg.seat_ids)) return bkg.seat_ids;
            try { return JSON.parse(bkg.seat_ids as unknown as string) as string[]; } catch { return []; }
          })();
          const safePassengerNames: string[] = (() => {
            if (!bkg.passenger_names) return [];
            if (Array.isArray(bkg.passenger_names)) return bkg.passenger_names;
            try { return JSON.parse(bkg.passenger_names as unknown as string) as string[]; } catch { return []; }
          })();
          return (
            <div
              key={bkg.id}
              style={{ ...cardStyle, cursor: 'pointer' }}
              onClick={() => setExpandedId(isExpanded ? null : bkg.id)}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontWeight: 700 }}>
                  {bkg.origin != null ? bkg.origin : '—'} → {bkg.destination != null ? bkg.destination : '—'}
                </span>
                <span style={{
                  fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 12,
                  background: `${statusColors[bkg.status] ?? '#64748b'}20`,
                  color: statusColors[bkg.status] ?? '#64748b',
                }}>
                  {t(bkg.status)}
                </span>
              </div>
              {bkg.departure_time != null && (
                <div style={{ fontSize: 13, color: '#64748b', marginTop: 4 }}>
                  {new Date(bkg.departure_time).toLocaleString('en-NG')}
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 4 }}>
                <div style={{ fontSize: 15, fontWeight: 700, color: '#16a34a' }}>
                  {formatAmount(bkg.total_amount)}
                </div>
                {bkg.status === 'pending' && (
                  <button
                    disabled={cancelling === bkg.id}
                    onClick={e => { e.stopPropagation(); void handleCancel(bkg.id); }}
                    style={{
                      padding: '5px 12px', borderRadius: 8, border: '1.5px solid #dc2626',
                      background: '#fee2e2', color: '#b91c1c', fontWeight: 600, fontSize: 12, cursor: 'pointer',
                    }}
                  >
                    {cancelling === bkg.id ? '…' : 'Cancel'}
                  </button>
                )}
              </div>

              {isExpanded && (
                <div style={{ marginTop: 12, borderTop: '1px solid #e2e8f0', paddingTop: 12 }}
                     onClick={e => e.stopPropagation()}>
                  <div style={{
                    background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 10,
                    padding: '12px 14px', fontFamily: 'monospace',
                  }}>
                    <div style={{ fontSize: 11, color: '#16a34a', fontWeight: 700, letterSpacing: 1, marginBottom: 6 }}>
                      BOOKING CONFIRMATION
                    </div>
                    <div style={{ fontSize: 18, fontWeight: 900, letterSpacing: 2, color: '#1e293b', marginBottom: 8 }}>
                      #{bkg.id.slice(-10).toUpperCase()}
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '4px 12px', fontSize: 12 }}>
                      <span style={{ color: '#64748b' }}>Route</span>
                      <span style={{ fontWeight: 600 }}>{bkg.origin ?? '—'} → {bkg.destination ?? '—'}</span>
                      {bkg.departure_time != null && <>
                        <span style={{ color: '#64748b' }}>Departure</span>
                        <span style={{ fontWeight: 600 }}>{new Date(bkg.departure_time).toLocaleString('en-NG')}</span>
                      </>}
                      {safePassengerNames.length > 0 && <>
                        <span style={{ color: '#64748b' }}>Passenger{safePassengerNames.length > 1 ? 's' : ''}</span>
                        <span style={{ fontWeight: 600 }}>{safePassengerNames.join(', ')}</span>
                      </>}
                      {safeSeatIds.length > 0 && <>
                        <span style={{ color: '#64748b' }}>Seat{safeSeatIds.length > 1 ? 's' : ''}</span>
                        <span style={{ fontWeight: 600 }}>{safeSeatIds.map(s => s.split('_s')[1] ?? s).join(', ')}</span>
                      </>}
                      <span style={{ color: '#64748b' }}>Amount</span>
                      <span style={{ fontWeight: 600, color: '#16a34a' }}>{formatAmount(bkg.total_amount)}</span>
                      <span style={{ color: '#64748b' }}>Payment</span>
                      <span style={{ fontWeight: 600 }}>{bkg.payment_status} · {bkg.payment_method}</span>
                      {bkg.payment_reference && <>
                        <span style={{ color: '#64748b' }}>Ref</span>
                        <span style={{ fontWeight: 600, wordBreak: 'break-all', fontSize: 11 }}>{bkg.payment_reference}</span>
                      </>}
                      {bkg.operator_name && <>
                        <span style={{ color: '#64748b' }}>Operator</span>
                        <span style={{ fontWeight: 600 }}>{bkg.operator_name}</span>
                      </>}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}

// ============================================================
// Role gating — which roles can see which tabs
// ============================================================
// ============================================================
// Super Admin Module — Operator CRUD (Platform view)
// ============================================================
function OperatorsPanel() {
  const [operators, setOperators] = useState<PlatformOperator[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ name: '', code: '', phone: '', email: '' });
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try { setOperators(await api.getOperators()); }
    catch { setOperators([]); } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const handleCreate = async () => {
    if (!form.name.trim() || !form.code.trim()) { setFormError('Name and code are required'); return; }
    setSaving(true); setFormError('');
    try {
      await api.createOperator({
        name: form.name.trim(),
        code: form.code.trim().toUpperCase(),
        ...(form.phone.trim() ? { phone: form.phone.trim() } : {}),
        ...(form.email.trim() ? { email: form.email.trim() } : {}),
      });
      setShowForm(false);
      setForm({ name: '', code: '', phone: '', email: '' });
      await load();
    } catch (e) {
      setFormError(e instanceof ApiError ? e.message : 'Failed to create operator');
    } finally { setSaving(false); }
  };

  const toggleStatus = async (op: PlatformOperator) => {
    const newStatus = op.status === 'active' ? 'suspended' : 'active';
    try { await api.updateOperator(op.id, { status: newStatus }); await load(); }
    catch { /* ignore */ }
  };

  const statusColor = (s: string) => s === 'active' ? '#16a34a' : '#dc2626';

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 18, flex: 1 }}>Operators</h2>
        <button onClick={() => void load()} style={{ ...secondaryBtnStyle, padding: '8px 14px', fontSize: 13 }}>↻</button>
        <button onClick={() => setShowForm(s => !s)} style={{ ...primaryBtnStyle, padding: '8px 14px', fontSize: 13 }}>
          {showForm ? 'Cancel' : '+ New'}
        </button>
      </div>

      {showForm && (
        <div style={{ ...cardStyle, cursor: 'default', marginBottom: 16 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input placeholder="Operator name (e.g. Sunrise Motors)" value={form.name}
              onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={inputStyle} />
            <input placeholder="Short code (e.g. SRM) — unique" value={form.code}
              onChange={e => setForm(f => ({ ...f, code: e.target.value }))} style={inputStyle} />
            <input placeholder="Phone (optional)" value={form.phone}
              onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} style={inputStyle} />
            <input placeholder="Email (optional)" value={form.email}
              onChange={e => setForm(f => ({ ...f, email: e.target.value }))} style={inputStyle} />
            {formError && <p style={{ color: '#dc2626', fontSize: 12, margin: 0 }}>{formError}</p>}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleCreate} disabled={saving} style={{ ...primaryBtnStyle, flex: 1 }}>
                {saving ? 'Creating…' : 'Create Operator'}
              </button>
              <button onClick={() => { setShowForm(false); setFormError(''); }}
                style={{ ...secondaryBtnStyle, flex: 1 }}>Cancel</button>
            </div>
          </div>
        </div>
      )}

      {loading ? (
        <p style={{ color: '#94a3b8', textAlign: 'center' }}>{t('loading')}</p>
      ) : operators.length === 0 ? (
        <p style={{ color: '#94a3b8', textAlign: 'center', marginTop: 32 }}>No operators yet. Create one to get started.</p>
      ) : (
        operators.map(op => (
          <div key={op.id} style={{ ...cardStyle, cursor: 'default', marginBottom: 10 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontWeight: 700 }}>{op.name}</div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>
                  Code: <span style={{ fontFamily: 'monospace', fontWeight: 700 }}>{op.code}</span>
                  {op.phone && <> · {op.phone}</>}
                  {op.email && <> · {op.email}</>}
                </div>
                <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
                  ID: <span style={{ fontFamily: 'monospace' }}>{op.id}</span>
                </div>
              </div>
              <span style={{
                fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 10,
                background: `${statusColor(op.status)}20`, color: statusColor(op.status),
              }}>{op.status}</span>
            </div>
            <button
              onClick={() => void toggleStatus(op)}
              style={{ ...secondaryBtnStyle, marginTop: 10, width: '100%', fontSize: 12 }}
            >
              {op.status === 'active' ? 'Suspend' : 'Reactivate'}
            </button>
          </div>
        ))
      )}
    </>
  );
}

// ============================================================
// P10-T5: PlatformAnalyticsSection — SUPER_ADMIN only
// ============================================================
function PlatformAnalyticsSection() {
  const [data, setData] = useState<PlatformAnalytics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    setLoading(true);
    setError('');
    api.getPlatformAnalytics()
      .then(setData)
      .catch((e: unknown) => setError(e instanceof ApiError ? e.message : 'Failed to load analytics'))
      .finally(() => setLoading(false));
  }, []);

  const statCard = (label: string, value: string | number, color = '#1e40af') => (
    <div style={{ ...cardStyle, cursor: 'default', textAlign: 'center' }}>
      <div style={{ fontSize: 22, fontWeight: 800, color }}>{value}</div>
      <div style={{ fontSize: 11, color: '#64748b', marginTop: 2 }}>{label}</div>
    </div>
  );

  if (loading) return <p style={{ color: '#94a3b8', textAlign: 'center', padding: 16 }}>Loading platform analytics…</p>;
  if (error) return <div style={{ padding: 12, background: '#fee2e2', borderRadius: 8, color: '#b91c1c', fontSize: 13, marginBottom: 16 }}>{error}</div>;
  if (!data) return null;

  return (
    <div style={{ padding: '0 0 16px' }}>
      <h3 style={{ margin: '0 0 12px', fontSize: 15, color: '#0f172a' }}>Platform Analytics</h3>
      <div style={{ fontSize: 11, color: '#64748b', marginBottom: 10 }}>
        Generated {new Date(data.generated_at).toLocaleString('en-NG', { timeZone: 'Africa/Lagos' })}
      </div>

      {/* KPI Grid */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
        {statCard('Operators', data.operators.total, '#7c3aed')}
        {statCard('Active Operators', data.operators.active, '#16a34a')}
        {statCard('Total Trips', data.trips.total, '#2563eb')}
        {statCard('Active Trips', (data.trips.boarding ?? 0) + (data.trips.in_transit ?? 0), '#d97706')}
        {statCard('Total Bookings', data.bookings.total, '#64748b')}
        {statCard('Confirmed Bookings', data.bookings.confirmed, '#16a34a')}
      </div>

      {/* Revenue */}
      <div style={{ ...cardStyle, cursor: 'default', marginBottom: 14 }}>
        <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Revenue</div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: '#16a34a' }}>{formatAmount(data.revenue.total_revenue_kobo)}</div>
            <div style={{ fontSize: 11, color: '#64748b' }}>All time</div>
          </div>
          <div>
            <div style={{ fontSize: 18, fontWeight: 800, color: '#2563eb' }}>{formatAmount(data.revenue.this_month_revenue_kobo)}</div>
            <div style={{ fontSize: 11, color: '#64748b' }}>This month</div>
          </div>
        </div>
      </div>

      {/* Top Routes */}
      {data.top_routes.length > 0 && (
        <div style={{ ...cardStyle, cursor: 'default', marginBottom: 14 }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Top Routes</div>
          {data.top_routes.map((r, i) => (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: i < data.top_routes.length - 1 ? '1px solid #f1f5f9' : 'none', fontSize: 13 }}>
              <span style={{ color: '#374151' }}>{r.origin} → {r.destination}</span>
              <span style={{ color: '#64748b', fontSize: 12 }}>{r.booking_count} bookings</span>
            </div>
          ))}
        </div>
      )}

      {/* Top Operators */}
      {data.top_operators.length > 0 && (
        <div style={{ ...cardStyle, cursor: 'default' }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 8 }}>Top Operators</div>
          {data.top_operators.map((o, i) => (
            <div key={o.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '5px 0', borderBottom: i < data.top_operators.length - 1 ? '1px solid #f1f5f9' : 'none', fontSize: 13 }}>
              <span style={{ color: '#374151' }}>{o.name}</span>
              <span style={{ color: '#16a34a', fontWeight: 600, fontSize: 12 }}>{formatAmount(o.revenue_kobo)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SuperAdminModule() {
  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
        <span style={{ fontSize: 22 }}>⚙️</span>
        <div>
          <div style={{ fontWeight: 800, fontSize: 17 }}>Platform Admin</div>
          <div style={{ fontSize: 11, color: '#64748b' }}>WebWaka OS — Super Admin Console</div>
        </div>
      </div>
      <OperatorsPanel />
    </div>
  );
}

const STAFF_ROLES: WakaRole[] = ['SUPER_ADMIN', 'TENANT_ADMIN', 'SUPERVISOR', 'STAFF'];
const ADMIN_ROLES: WakaRole[] = ['SUPER_ADMIN', 'TENANT_ADMIN'];
const CONFLICT_ROLES: WakaRole[] = ['SUPER_ADMIN', 'TENANT_ADMIN', 'SUPERVISOR', 'STAFF'];
const ANALYTICS_ROLES: WakaRole[] = ['SUPER_ADMIN'];

// ============================================================
// Main App — inner shell (requires AuthProvider above it)
// ============================================================
type Tab = 'search' | 'bookings' | 'agent' | 'operator' | 'admin' | 'driver' | 'analytics' | 'conflicts';

function AppContent() {
  const { user, isAuthenticated, isLoading, logout, hasRole } = useAuth();
  const [tab, setTab] = useState<Tab>('search');
  const [lang, setLang] = useState<Language>(getLanguage());
  const [currency, setCurrencyState] = useState<CurrencyCode>(getCurrency());
  const [conflictCount, setConflictCount] = useState(0);
  const [showConflicts, setShowConflicts] = useState(false);
  const online = useOnlineStatus();
  const { pendingCount: pendingSync, isSyncing } = useSyncQueue();

  // P13-T3: Auto-detect browser language on first visit (no stored preference)
  useEffect(() => { autoDetectLanguage(); }, []);

  // Auto-logout when JWT expires mid-session
  useEffect(() => {
    const handler = () => logout();
    window.addEventListener('waka:unauthorized', handler);
    return () => window.removeEventListener('waka:unauthorized', handler);
  }, [logout]);

  // C-001: Request push notification permission + subscribe after login
  useEffect(() => {
    if (!isAuthenticated || !user) return;
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    const vapidKey = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
    if (!vapidKey) return;
    void (async () => {
      try {
        const reg = await navigator.serviceWorker.ready;
        const existing = await reg.pushManager.getSubscription();
        if (existing) return; // already subscribed
        const permission = await Notification.requestPermission();
        if (permission !== 'granted') return;
        const sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: vapidKey,
        });
        const raw = sub.toJSON() as { endpoint: string; keys?: { p256dh?: string; auth?: string } };
        await api.subscribeForPush({
          endpoint: raw.endpoint,
          keys: {
            p256dh: raw.keys?.p256dh ?? '',
            auth: raw.keys?.auth ?? '',
          },
        });
      } catch {
        // non-fatal — push is a progressive enhancement
      }
    })();
  }, [isAuthenticated, user]);

  // C-003: Poll conflict count every 30 s when logged in
  useEffect(() => {
    if (!isAuthenticated || !hasRole(CONFLICT_ROLES)) return;
    const refresh = () => void getConflicts().then(cs => setConflictCount(cs.length)).catch(() => {});
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => clearInterval(id);
  }, [isAuthenticated, hasRole]);

  // P15-T6: White-label branding detection — fetch branding config for operator and apply CSS variables
  useEffect(() => {
    if (!isAuthenticated || !user?.operator_id) return;
    const fetchBranding = async () => {
      try {
        const token = localStorage.getItem('waka_token') ?? sessionStorage.getItem('waka_token') ?? '';
        const res = await fetch('/api/operator/branding', {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        if (!res.ok) return;
        const data = await res.json() as { primary_color?: string; secondary_color?: string; brand_name?: string; logo_url?: string };
        if (data.primary_color) {
          document.documentElement.style.setProperty('--waka-primary', data.primary_color);
        }
        if (data.secondary_color) {
          document.documentElement.style.setProperty('--waka-secondary', data.secondary_color);
        }
        if (data.brand_name && data.brand_name.trim()) {
          document.title = data.brand_name;
        }
        if (data.logo_url) {
          const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]') ?? document.createElement('link') as HTMLLinkElement;
          link.rel = 'icon';
          link.href = data.logo_url;
          document.head.appendChild(link);
        }
      } catch { /* branding is a progressive enhancement — silently ignore fetch failures */ }
    };
    void fetchBranding();
  }, [isAuthenticated, user?.operator_id]);

  // T013: Flush offline queue when coming back online
  useEffect(() => {
    if (!online) return;
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.ready.then(reg => {
        if (reg.active) reg.active.postMessage({ type: 'TRIGGER_SYNC' });
      }).catch(() => {});
    }
  }, [online]);

  const handleLangChange = (l: Language) => {
    setLanguage(l);
    setLang(l);
  };

  const handleCurrencyChange = (c: CurrencyCode) => {
    setCurrency(c);
    setCurrencyState(c);
  };

  if (isLoading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'system-ui, sans-serif' }}>
        <div style={{ textAlign: 'center', color: '#94a3b8' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🚌</div>
          <div>Loading…</div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <LoginScreen />;
  }

  // Driver role: show Driver view first
  const isDriverOnly = user?.role === 'DRIVER';

  // Build tabs based on role
  const tabs: Array<{ id: Tab; icon: string; label: string }> = isDriverOnly
    ? [{ id: 'driver' as Tab, icon: '🚐', label: 'My Trips' }]
    : [
        { id: 'search' as Tab, icon: '🔍', label: t('search_trips') },
        { id: 'bookings' as Tab, icon: '🎫', label: t('my_bookings') },
        ...(hasRole(STAFF_ROLES) ? [{ id: 'agent' as Tab, icon: '💰', label: t('agent_pos') }] : []),
        ...(hasRole(ANALYTICS_ROLES) ? [{ id: 'analytics' as Tab, icon: '📊', label: 'Analytics' }] : []),
        ...(hasRole(ADMIN_ROLES) ? [{ id: 'operator' as Tab, icon: '🚌', label: t('operator') }] : []),
        ...(hasRole(['SUPER_ADMIN']) ? [{ id: 'admin' as Tab, icon: '⚙️', label: 'Platform' }] : []),
      ];

  // Reset tab if current tab is no longer visible (e.g. after role change)
  const defaultTab = isDriverOnly ? 'driver' : 'search';
  const validTab = tabs.some(tb => tb.id === tab) ? tab : defaultTab;

  const roleLabel: Record<string, string> = {
    CUSTOMER: 'Customer', STAFF: 'Agent', SUPERVISOR: 'Supervisor',
    TENANT_ADMIN: 'Operator Admin', SUPER_ADMIN: 'Super Admin', DRIVER: 'Driver',
  };

  return (
    <div data-testid="transport-app" style={{ maxWidth: 430, margin: '0 auto', minHeight: '100vh', display: 'flex', flexDirection: 'column', fontFamily: 'system-ui, sans-serif', background: '#f8fafc' }}>
      <StatusBar online={online} pendingSync={pendingSync} syncing={isSyncing} lang={lang} onLangChange={handleLangChange} currency={currency} onCurrencyChange={handleCurrencyChange} />

      {/* C-003: Conflict resolution panel (slide-in on badge click) */}
      {showConflicts && hasRole(CONFLICT_ROLES) && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 200, background: 'rgba(0,0,0,0.45)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
        }}>
          <div style={{ background: '#fff', borderRadius: '16px 16px 0 0', maxHeight: '70vh', overflowY: 'auto', padding: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 12 }}>
              <span style={{ fontWeight: 700, fontSize: 16 }}>Sync Conflicts</span>
              <button onClick={() => setShowConflicts(false)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer' }}>✕</button>
            </div>
            <ErrorBoundary label="Conflict Log">
              <ConflictLog onClose={() => {
                void getConflicts().then(cs => setConflictCount(cs.length)).catch(() => {});
                setShowConflicts(false);
              }} />
            </ErrorBoundary>
          </div>
        </div>
      )}

      {/* App header with user strip */}
      <div style={{ background: '#1e40af', color: '#fff', padding: '10px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ fontWeight: 800, fontSize: 18 }}>🚌 {t('app_name')}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          {/* C-003: Conflict badge */}
          {conflictCount > 0 && hasRole(CONFLICT_ROLES) && (
            <button
              onClick={() => setShowConflicts(true)}
              title={`${conflictCount} unresolved sync conflict${conflictCount !== 1 ? 's' : ''}`}
              style={{
                background: '#dc2626', border: 'none', color: '#fff', borderRadius: 20,
                padding: '3px 10px', fontSize: 11, cursor: 'pointer', fontWeight: 700,
              }}
            >
              ⚠ {conflictCount}
            </button>
          )}
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 12, fontWeight: 700, opacity: 0.95 }}>
              {user?.name ?? user?.phone}
            </div>
            <div style={{ fontSize: 10, opacity: 0.7 }}>
              {roleLabel[user?.role ?? ''] ?? user?.role}
            </div>
          </div>
          <button
            onClick={logout}
            title="Sign out"
            style={{
              background: 'rgba(255,255,255,0.15)', border: 'none', color: '#fff',
              borderRadius: 8, padding: '5px 10px', fontSize: 12, cursor: 'pointer',
              fontWeight: 600,
            }}
          >
            Sign out
          </button>
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 70 }}>
        {/* C-004: Driver mobile view */}
        <ErrorBoundary label="Driver View">
          {validTab === 'driver' && <DriverView />}
        </ErrorBoundary>
        <ErrorBoundary label="Trip Search">
          {validTab === 'search' && <TripSearchModule />}
        </ErrorBoundary>
        <ErrorBoundary label="My Bookings">
          {validTab === 'bookings' && <MyBookingsModule />}
        </ErrorBoundary>
        <ErrorBoundary label="Agent POS">
          {validTab === 'agent' && <AgentPOSModule online={online} />}
        </ErrorBoundary>
        {/* P10-T5: Platform analytics (SUPER_ADMIN only) */}
        <ErrorBoundary label="Analytics">
          {validTab === 'analytics' && (
            <div style={{ padding: 16 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 20 }}>
                <span style={{ fontSize: 22 }}>📊</span>
                <div>
                  <div style={{ fontWeight: 800, fontSize: 17 }}>Platform Analytics</div>
                  <div style={{ fontSize: 11, color: '#64748b' }}>WebWaka OS — Cross-tenant KPIs</div>
                </div>
              </div>
              <PlatformAnalyticsSection />
            </div>
          )}
        </ErrorBoundary>
        <ErrorBoundary label="Operator Dashboard">
          {validTab === 'operator' && <OperatorDashboardModule />}
        </ErrorBoundary>
        <ErrorBoundary label="Platform Admin">
          {validTab === 'admin' && <SuperAdminModule />}
        </ErrorBoundary>
      </div>

      {/* Mobile-First bottom navigation */}
      <nav style={{
        position: 'fixed', bottom: 0, left: '50%', transform: 'translateX(-50%)',
        width: '100%', maxWidth: 430, background: '#fff',
        borderTop: '1px solid #e2e8f0', display: 'flex',
        paddingBottom: 'env(safe-area-inset-bottom)',
      }}>
        {tabs.map(({ id, icon, label }) => (
          <button key={id} onClick={() => setTab(id)} style={{
            flex: 1, padding: '10px 4px 8px', border: 'none', background: 'none', cursor: 'pointer',
            display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
            color: validTab === id ? '#1e40af' : '#94a3b8',
            borderTop: validTab === id ? '2px solid #1e40af' : '2px solid transparent',
          }}>
            <span style={{ fontSize: 20 }}>{icon}</span>
            <span style={{ fontSize: 10, fontWeight: validTab === id ? 700 : 400 }}>{label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}

// ============================================================
// Main export — AuthProvider wraps everything
// ============================================================
export function TransportApp() {
  // P03-T5: Route /b/:bookingId to the public e-ticket page
  const path = window.location.pathname;
  const ticketMatch = path.match(/^\/b\/([^/]+)$/);
  if (ticketMatch && ticketMatch[1]) {
    return <TicketPage bookingId={ticketMatch[1]} />;
  }

  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}

// ============================================================
// Shared Styles
// ============================================================
const inputStyle: React.CSSProperties = {
  width: '100%', padding: '12px 14px', borderRadius: 10, border: '1.5px solid #e2e8f0',
  fontSize: 15, background: '#fff', boxSizing: 'border-box',
};

const primaryBtnStyle: React.CSSProperties = {
  padding: '14px 20px', borderRadius: 10, border: 'none',
  background: '#1e40af', color: '#fff', fontWeight: 700, fontSize: 15,
  cursor: 'pointer', minHeight: 48,
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '12px 16px', borderRadius: 10, border: '1.5px solid #e2e8f0',
  background: '#fff', color: '#1e40af', fontWeight: 600, fontSize: 14,
  cursor: 'pointer', minHeight: 44,
};

const backBtnStyle: React.CSSProperties = {
  padding: '8px 14px', borderRadius: 8, border: '1.5px solid #e2e8f0',
  background: '#fff', color: '#475569', fontWeight: 600, fontSize: 13, cursor: 'pointer',
};

const cardStyle: React.CSSProperties = {
  background: '#fff', borderRadius: 12, padding: 14, marginBottom: 10,
  border: '1.5px solid #e2e8f0', cursor: 'pointer',
};

const navCardStyle: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
  padding: '20px 12px', borderRadius: 12, border: '1.5px solid #e2e8f0',
  background: '#fff', cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
  marginBottom: 0,
};
