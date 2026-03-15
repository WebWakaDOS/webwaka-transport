/**
 * TRN-1: Seat Inventory Synchronization & Atomic Validation
 * Blueprint Reference: Part 10.3 (Transportation & Mobility Suite)
 * 
 * Event-driven seat inventory system with optimistic concurrency control
 * and 30-second reservation tokens for Nigeria bus park use case.
 */

export interface Seat {
  id: string;
  tripId: string;
  seatNumber: string;
  status: 'available' | 'reserved' | 'confirmed' | 'blocked';
  reservedBy?: string;
  reservationToken?: string;
  reservationExpiresAt?: Date;
  confirmedBy?: string;
  confirmedAt?: Date;
}

export interface Trip {
  id: string;
  operatorId: string;
  routeId: string;
  departureTime: Date;
  totalSeats: number;
  seats: Seat[];
  state: 'scheduled' | 'boarding' | 'in_transit' | 'completed';
  createdAt: Date;
}

export interface ReservationToken {
  id: string;
  seatId: string;
  userId: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface ReservationResult {
  success: boolean;
  seatId?: string;
  token?: string;
  expiresAt?: Date;
  error?: string;
}

export interface AvailabilityResult {
  tripId: string;
  totalSeats: number;
  availableSeats: number;
  reservedSeats: number;
  confirmedSeats: number;
  blockedSeats: number;
  seats: Seat[];
}

const RESERVATION_TOKEN_TTL_SECONDS = 30;

export class SeatInventoryManager {
  private trips: Map<string, Trip> = new Map();
  private reservationTokens: Map<string, ReservationToken> = new Map();
  private eventCallbacks: Map<string, Function[]> = new Map();

  /**
   * Creates a new trip with specified number of seats.
   */
  createTrip(
    tripId: string,
    operatorId: string,
    routeId: string,
    departureTime: Date,
    totalSeats: number
  ): Trip {
    const seats: Seat[] = [];
    for (let i = 1; i <= totalSeats; i++) {
      seats.push({
        id: `seat_${tripId}_${i}`,
        tripId,
        seatNumber: `${i}`,
        status: 'available'
      });
    }

    const trip: Trip = {
      id: tripId,
      operatorId,
      routeId,
      departureTime,
      totalSeats,
      seats,
      state: 'scheduled',
      createdAt: new Date()
    };

    this.trips.set(tripId, trip);
    this.emit('trip.created', trip);

    return trip;
  }

  /**
   * Reserves a seat with a 30-second token.
   * Uses optimistic concurrency control.
   */
  reserveSeat(tripId: string, seatNumber: string, userId: string): ReservationResult {
    const trip = this.trips.get(tripId);
    if (!trip) {
      return { success: false, error: 'Trip not found' };
    }

    const seat = trip.seats.find(s => s.seatNumber === seatNumber);
    if (!seat) {
      return { success: false, error: 'Seat not found' };
    }

    // Check if reservation token has expired
    if (seat.reservationToken && seat.reservationExpiresAt) {
      if (new Date() < seat.reservationExpiresAt) {
        return { success: false, error: 'Seat is already reserved' };
      }
      // Token expired, clean up
      this.reservationTokens.delete(seat.reservationToken);
      seat.status = 'available';
      seat.reservedBy = undefined;
      seat.reservationToken = undefined;
      seat.reservationExpiresAt = undefined;
    }

    // Check if seat is available
    if (seat.status !== 'available') {
      return { success: false, error: `Seat is ${seat.status}` };
    }

    // Generate reservation token
    const token = `token_${crypto.randomUUID()}`;
    const expiresAt = new Date(Date.now() + RESERVATION_TOKEN_TTL_SECONDS * 1000);

    // Update seat status
    seat.status = 'reserved';
    seat.reservedBy = userId;
    seat.reservationToken = token;
    seat.reservationExpiresAt = expiresAt;

    // Store token
    const reservationToken: ReservationToken = {
      id: token,
      seatId: seat.id,
      userId,
      expiresAt,
      createdAt: new Date()
    };
    this.reservationTokens.set(token, reservationToken);

    this.emit('seat.reserved', { seat, token, expiresAt });

    return {
      success: true,
      seatId: seat.id,
      token,
      expiresAt
    };
  }

  /**
   * Confirms a reserved seat with its token.
   * Atomic operation - either succeeds or fails completely.
   */
  confirmSeat(tripId: string, seatId: string, token: string, userId: string): ReservationResult {
    const trip = this.trips.get(tripId);
    if (!trip) {
      return { success: false, error: 'Trip not found' };
    }

    const seat = trip.seats.find(s => s.id === seatId);
    if (!seat) {
      return { success: false, error: 'Seat not found' };
    }

    // Validate token
    const reservationToken = this.reservationTokens.get(token);
    if (!reservationToken) {
      return { success: false, error: 'Invalid or expired token' };
    }

    // Check token expiration
    if (new Date() > reservationToken.expiresAt) {
      this.reservationTokens.delete(token);
      seat.status = 'available';
      seat.reservedBy = undefined;
      seat.reservationToken = undefined;
      seat.reservationExpiresAt = undefined;
      return { success: false, error: 'Reservation token expired' };
    }

    // Verify token matches seat and user
    if (reservationToken.seatId !== seatId || reservationToken.userId !== userId) {
      return { success: false, error: 'Token does not match seat or user' };
    }

    // Verify seat is still reserved
    if (seat.status !== 'reserved') {
      return { success: false, error: 'Seat is not in reserved state' };
    }

    // Atomic confirmation
    seat.status = 'confirmed';
    seat.confirmedBy = userId;
    seat.confirmedAt = new Date();
    seat.reservationToken = undefined;
    seat.reservationExpiresAt = undefined;

    this.reservationTokens.delete(token);

    this.emit('seat.confirmed', { seat });

    return {
      success: true,
      seatId: seat.id
    };
  }

  /**
   * Releases a reserved or confirmed seat.
   */
  releaseSeat(tripId: string, seatId: string): ReservationResult {
    const trip = this.trips.get(tripId);
    if (!trip) {
      return { success: false, error: 'Trip not found' };
    }

    const seat = trip.seats.find(s => s.id === seatId);
    if (!seat) {
      return { success: false, error: 'Seat not found' };
    }

    if (seat.status === 'available') {
      return { success: false, error: 'Seat is already available' };
    }

    // Clean up reservation token if exists
    if (seat.reservationToken) {
      this.reservationTokens.delete(seat.reservationToken);
    }

    // Reset seat to available
    const previousStatus = seat.status;
    seat.status = 'available';
    seat.reservedBy = undefined;
    seat.reservationToken = undefined;
    seat.reservationExpiresAt = undefined;
    seat.confirmedBy = undefined;
    seat.confirmedAt = undefined;

    this.emit('seat.released', { seat, previousStatus });

    return { success: true, seatId: seat.id };
  }

  /**
   * Gets availability for a trip.
   */
  getAvailability(tripId: string): AvailabilityResult | null {
    const trip = this.trips.get(tripId);
    if (!trip) return null;

    const availableSeats = trip.seats.filter(s => s.status === 'available').length;
    const reservedSeats = trip.seats.filter(s => s.status === 'reserved').length;
    const confirmedSeats = trip.seats.filter(s => s.status === 'confirmed').length;
    const blockedSeats = trip.seats.filter(s => s.status === 'blocked').length;

    return {
      tripId,
      totalSeats: trip.totalSeats,
      availableSeats,
      reservedSeats,
      confirmedSeats,
      blockedSeats,
      seats: trip.seats
    };
  }

  /**
   * Gets trip details.
   */
  getTrip(tripId: string): Trip | null {
    return this.trips.get(tripId) || null;
  }

  /**
   * Cleans up expired reservation tokens.
   */
  cleanupExpiredTokens(): number {
    let cleaned = 0;
    const now = new Date();

    for (const [token, reservation] of this.reservationTokens.entries()) {
      if (now > reservation.expiresAt) {
        const trip = this.trips.get(reservation.seatId.split('_')[1]);
        if (trip) {
          const seat = trip.seats.find(s => s.id === reservation.seatId);
          if (seat && seat.reservationToken === token) {
            seat.status = 'available';
            seat.reservedBy = undefined;
            seat.reservationToken = undefined;
            seat.reservationExpiresAt = undefined;
          }
        }
        this.reservationTokens.delete(token);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Event system for pub/sub.
   */
  on(eventType: string, callback: Function): void {
    if (!this.eventCallbacks.has(eventType)) {
      this.eventCallbacks.set(eventType, []);
    }
    this.eventCallbacks.get(eventType)!.push(callback);
  }

  private emit(eventType: string, data: any): void {
    const callbacks = this.eventCallbacks.get(eventType) || [];
    callbacks.forEach(cb => cb(data));
  }
}
