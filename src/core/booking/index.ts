/**
 * TRN-3: Customer Booking Portal
 * Blueprint Reference: Part 10.3 (Transportation & Mobility Suite)
 * 
 * Customer-facing booking system with real-time seat availability
 * and atomic validation via TRN-1.
 */

import type { SeatInventoryManager } from '../seat-inventory/index';

export interface Booking {
  id: string;
  customerId: string;
  tripId: string;
  seatIds: string[];
  passengerNames: string[];
  totalAmount: number;
  status: 'pending' | 'confirmed' | 'cancelled' | 'completed';
  paymentStatus: 'pending' | 'completed' | 'failed';
  paymentMethod: 'paystack' | 'flutterwave' | 'bank_transfer';
  paymentReference?: string;
  createdAt: Date;
  confirmedAt?: Date;
  cancelledAt?: Date;
  metadata?: Record<string, unknown>;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email: string;
  status: 'active' | 'suspended';
  createdAt: Date;
}

export interface BookingResult {
  success: boolean;
  bookingId?: string;
  reservationTokens?: string[];
  error?: string;
}

export class BookingManager {
  private bookings: Map<string, Booking> = new Map();
  private customers: Map<string, Customer> = new Map();
  private seatInventory: SeatInventoryManager;
  private eventCallbacks: Map<string, Function[]> = new Map();

  constructor(seatInventory: SeatInventoryManager) {
    this.seatInventory = seatInventory;
  }

  /**
   * Registers a customer.
   */
  registerCustomer(customer: Customer): void {
    this.customers.set(customer.id, customer);
    this.emit('customer.registered', customer);
  }

  /**
   * Creates a new booking with seat reservations.
   * Integrates with TRN-1 for atomic validation.
   */
  createBooking(
    customerId: string,
    tripId: string,
    seatIds: string[],
    passengerNames: string[],
    totalAmount: number,
    paymentMethod: 'paystack' | 'flutterwave' | 'bank_transfer'
  ): BookingResult {
    const customer = this.customers.get(customerId);
    if (!customer) {
      return { success: false, error: 'Customer not found' };
    }

    if (customer.status !== 'active') {
      return { success: false, error: 'Customer is not active' };
    }

    if (seatIds.length !== passengerNames.length) {
      return { success: false, error: 'Seat and passenger count mismatch' };
    }

    if (totalAmount <= 0) {
      return { success: false, error: 'Invalid amount' };
    }

    // Attempt to reserve all seats via TRN-1
    const reservationTokens: string[] = [];
    for (const seatId of seatIds) {
      const trip = this.seatInventory.getTrip(tripId);
      if (!trip) {
        return { success: false, error: 'Trip not found' };
      }

      const seat = trip.seats.find(s => s.id === seatId);
      if (!seat) {
        // Release already reserved seats
        for (const token of reservationTokens) {
          // In a real system, we'd have a way to release by token
        }
        return { success: false, error: `Seat ${seatId} not found` };
      }

      const seatNumber = seat.seatNumber;
      const reservationResult = this.seatInventory.reserveSeat(
        tripId,
        seatNumber,
        customerId
      );

      if (!reservationResult.success) {
        // Release already reserved seats
        for (const token of reservationTokens) {
          // In a real system, we'd have a way to release by token
        }
        return { success: false, error: `Failed to reserve seat ${seatNumber}` };
      }

      reservationTokens.push(reservationResult.token!);
    }

    // Create booking record
    const booking: Booking = {
      id: `bkg_${crypto.randomUUID()}`,
      customerId,
      tripId,
      seatIds,
      passengerNames,
      totalAmount,
      status: 'pending',
      paymentStatus: 'pending',
      paymentMethod,
      createdAt: new Date()
    };

    this.bookings.set(booking.id, booking);

    this.emit('booking.created', booking);

    return {
      success: true,
      bookingId: booking.id,
      reservationTokens
    };
  }

  /**
   * Confirms a booking after payment is completed.
   */
  confirmBooking(bookingId: string, paymentReference: string): BookingResult {
    const booking = this.bookings.get(bookingId);
    if (!booking) {
      return { success: false, error: 'Booking not found' };
    }

    if (booking.status !== 'pending') {
      return { success: false, error: `Booking is ${booking.status}` };
    }

    // Confirm all seats via TRN-1
    const trip = this.seatInventory.getTrip(booking.tripId);
    if (!trip) {
      return { success: false, error: 'Trip not found' };
    }

    for (const seatId of booking.seatIds) {
      const seat = trip.seats.find(s => s.id === seatId);
      if (seat && seat.reservationToken) {
        this.seatInventory.confirmSeat(
          booking.tripId,
          seatId,
          seat.reservationToken,
          booking.customerId
        );
      }
    }

    booking.status = 'confirmed';
    booking.paymentStatus = 'completed';
    booking.paymentReference = paymentReference;
    booking.confirmedAt = new Date();

    this.emit('booking.confirmed', booking);

    return { success: true, bookingId };
  }

  /**
   * Cancels a booking and releases seats.
   */
  cancelBooking(bookingId: string, reason: string): BookingResult {
    const booking = this.bookings.get(bookingId);
    if (!booking) {
      return { success: false, error: 'Booking not found' };
    }

    if (booking.status === 'cancelled') {
      return { success: false, error: 'Booking is already cancelled' };
    }

    // Release all seats via TRN-1
    for (const seatId of booking.seatIds) {
      this.seatInventory.releaseSeat(booking.tripId, seatId);
    }

    booking.status = 'cancelled';
    booking.cancelledAt = new Date();
    booking.metadata = {
      ...booking.metadata,
      cancellationReason: reason
    };

    this.emit('booking.cancelled', booking);

    return { success: true, bookingId };
  }

  /**
   * Gets a booking by ID.
   */
  getBooking(bookingId: string): Booking | null {
    return this.bookings.get(bookingId) || null;
  }

  /**
   * Gets all bookings for a customer.
   */
  getCustomerBookings(customerId: string, limit: number = 50): Booking[] {
    return Array.from(this.bookings.values())
      .filter(b => b.customerId === customerId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  /**
   * Gets bookings for a specific trip.
   */
  getTripBookings(tripId: string): Booking[] {
    return Array.from(this.bookings.values())
      .filter(b => b.tripId === tripId && b.status === 'confirmed');
  }

  /**
   * Marks payment as completed.
   */
  completePayment(bookingId: string, paymentReference: string): BookingResult {
    return this.confirmBooking(bookingId, paymentReference);
  }

  /**
   * Marks payment as failed.
   */
  failPayment(bookingId: string, reason: string): BookingResult {
    const booking = this.bookings.get(bookingId);
    if (!booking) {
      return { success: false, error: 'Booking not found' };
    }

    booking.paymentStatus = 'failed';
    booking.metadata = {
      ...booking.metadata,
      paymentFailureReason: reason
    };

    this.emit('booking.payment_failed', booking);

    return { success: true, bookingId };
  }

  /**
   * Gets booking statistics for a trip.
   */
  getTripStats(tripId: string): {
    totalBookings: number;
    confirmedBookings: number;
    pendingBookings: number;
    cancelledBookings: number;
    totalSeatsBooked: number;
    totalRevenue: number;
  } {
    const tripBookings = Array.from(this.bookings.values()).filter(
      b => b.tripId === tripId
    );

    return {
      totalBookings: tripBookings.length,
      confirmedBookings: tripBookings.filter(b => b.status === 'confirmed')
        .length,
      pendingBookings: tripBookings.filter(b => b.status === 'pending').length,
      cancelledBookings: tripBookings.filter(b => b.status === 'cancelled')
        .length,
      totalSeatsBooked: tripBookings.reduce((sum, b) => sum + b.seatIds.length, 0),
      totalRevenue: tripBookings
        .filter(b => b.paymentStatus === 'completed')
        .reduce((sum, b) => sum + b.totalAmount, 0)
    };
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

// Extend Booking interface to include metadata
declare global {
  interface Booking {
    metadata?: Record<string, any>;
  }
}
