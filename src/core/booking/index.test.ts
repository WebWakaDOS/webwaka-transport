import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BookingManager } from './index';
import type { Customer } from './index';
import { SeatInventoryManager } from '../seat-inventory/index';

describe('TRN-3: Customer Booking Portal', () => {
  let bookingManager: BookingManager;
  let seatInventory: SeatInventoryManager;

  const customer: Customer = {
    id: 'cust_001',
    name: 'Adekunle Okafor',
    phone: '+2348012345678',
    email: 'adekunle@email.com',
    status: 'active',
    createdAt: new Date()
  };

  const tripId = 'trip_001';
  const departureTime = new Date(Date.now() + 3600000);

  beforeEach(() => {
    seatInventory = new SeatInventoryManager();
    bookingManager = new BookingManager(seatInventory);

    // Setup trip and customer
    seatInventory.createTrip(tripId, 'op_001', 'route_001', departureTime, 50);
    bookingManager.registerCustomer(customer);
  });

  describe('Customer Registration', () => {
    it('should register a customer', () => {
      const newCustomer: Customer = {
        id: 'cust_002',
        name: 'Mary Okafor',
        phone: '+2348087654321',
        email: 'mary@email.com',
        status: 'active',
        createdAt: new Date()
      };

      bookingManager.registerCustomer(newCustomer);
      expect(bookingManager.getBooking).toBeDefined();
    });

    it('should emit customer.registered event', () => {
      const callback = vi.fn();
      bookingManager.on('customer.registered', callback);

      const newCustomer: Customer = {
        id: 'cust_003',
        name: 'Test Customer',
        phone: '+2348000000000',
        email: 'test@email.com',
        status: 'active',
        createdAt: new Date()
      };

      bookingManager.registerCustomer(newCustomer);

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0]![0].id).toBe('cust_003');
    });
  });

  describe('Booking Creation', () => {
    it('should create a booking with seat reservations', () => {
      const result = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1', 'seat_trip_001_2'],
        ['Passenger 1', 'Passenger 2'],
        5000,
        'paystack'
      );

      expect(result.success).toBe(true);
      expect(result.bookingId).toBeDefined();
      expect(result.reservationTokens).toHaveLength(2);
    });

    it('should not create booking for inactive customer', () => {
      const inactiveCustomer: Customer = {
        ...customer,
        id: 'cust_inactive',
        status: 'suspended'
      };
      bookingManager.registerCustomer(inactiveCustomer);

      const result = bookingManager.createBooking(
        'cust_inactive',
        tripId,
        ['seat_001_1'],
        ['Passenger 1'],
        2500,
        'paystack'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not active');
    });

    it('should not create booking for non-existent customer', () => {
      const result = bookingManager.createBooking(
        'non_existent',
        tripId,
        ['seat_001_1'],
        ['Passenger 1'],
        2500,
        'paystack'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Customer not found');
    });

    it('should not create booking with mismatched trns_seats and passengers', () => {
      const result = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1', 'seat_trip_001_2'],
        ['Passenger 1'],
        5000,
        'paystack'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('mismatch');
    });

    it('should not create booking with invalid amount', () => {
      const result = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_001_1'],
        ['Passenger 1'],
        0,
        'paystack'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid amount');
    });

    it('should emit booking.created event', () => {
      const callback = vi.fn();
      bookingManager.on('booking.created', callback);

      bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1'],
        ['Passenger 1'],
        2500,
        'paystack'
      );

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0]![0].customerId).toBe(customer.id);
    });

    it('should set booking status to pending', () => {
      const result = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1'],
        ['Passenger 1'],
        2500,
        'paystack'
      );

      const booking = bookingManager.getBooking(result.bookingId!);

      expect(booking!.status).toBe('pending');
      expect(booking!.paymentStatus).toBe('pending');
    });
  });

  describe('Booking Confirmation', () => {
    it('should confirm a booking after payment', () => {
      const bookingResult = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1'],
        ['Passenger 1'],
        2500,
        'paystack'
      );

      const confirmResult = bookingManager.confirmBooking(
        bookingResult.bookingId!,
        'PAY_REF_001'
      );

      expect(confirmResult.success).toBe(true);

      const booking = bookingManager.getBooking(bookingResult.bookingId!);
      expect(booking!.status).toBe('confirmed');
      expect(booking!.paymentStatus).toBe('completed');
    });

    it('should not confirm non-existent booking', () => {
      const result = bookingManager.confirmBooking('non_existent', 'PAY_REF_001');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Booking not found');
    });

    it('should emit booking.confirmed event', () => {
      const callback = vi.fn();
      bookingManager.on('booking.confirmed', callback);

      const bookingResult = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1'],
        ['Passenger 1'],
        2500,
        'paystack'
      );

      bookingManager.confirmBooking(bookingResult.bookingId!, 'PAY_REF_001');

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0]![0].status).toBe('confirmed');
    });
  });

  describe('Booking Cancellation', () => {
    it('should cancel a booking', () => {
      const bookingResult = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1'],
        ['Passenger 1'],
        2500,
        'paystack'
      );

      const cancelResult = bookingManager.cancelBooking(
        bookingResult.bookingId!,
        'Customer requested cancellation'
      );

      expect(cancelResult.success).toBe(true);

      const booking = bookingManager.getBooking(bookingResult.bookingId!);
      expect(booking!.status).toBe('cancelled');
    });

    it('should not cancel already cancelled booking', () => {
      const bookingResult = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1'],
        ['Passenger 1'],
        2500,
        'paystack'
      );

      bookingManager.cancelBooking(bookingResult.bookingId!, 'Reason 1');
      const result = bookingManager.cancelBooking(
        bookingResult.bookingId!,
        'Reason 2'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('already cancelled');
    });

    it('should emit booking.cancelled event', () => {
      const callback = vi.fn();
      bookingManager.on('booking.cancelled', callback);

      const bookingResult = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1'],
        ['Passenger 1'],
        2500,
        'paystack'
      );

      bookingManager.cancelBooking(bookingResult.bookingId!, 'Test cancellation');

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0]![0].status).toBe('cancelled');
    });
  });

  describe('Payment Management', () => {
    it('should complete payment', () => {
      const bookingResult = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1'],
        ['Passenger 1'],
        2500,
        'paystack'
      );

      const paymentResult = bookingManager.completePayment(
        bookingResult.bookingId!,
        'PAY_REF_001'
      );

      expect(paymentResult.success).toBe(true);

      const booking = bookingManager.getBooking(bookingResult.bookingId!);
      expect(booking!.paymentStatus).toBe('completed');
    });

    it('should fail payment', () => {
      const bookingResult = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1'],
        ['Passenger 1'],
        2500,
        'paystack'
      );

      const failResult = bookingManager.failPayment(
        bookingResult.bookingId!,
        'Insufficient funds'
      );

      expect(failResult.success).toBe(true);

      const booking = bookingManager.getBooking(bookingResult.bookingId!);
      expect(booking!.paymentStatus).toBe('failed');
    });

    it('should emit payment events', () => {
      
      const failCallback = vi.fn();
      bookingManager.on('booking.payment_failed', failCallback);

      const bookingResult = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1'],
        ['Passenger 1'],
        2500,
        'paystack'
      );

      bookingManager.failPayment(bookingResult.bookingId!, 'Error');
      expect(failCallback).toHaveBeenCalled();
    });
  });

  describe('Booking Retrieval', () => {
    it('should get a booking by ID', () => {
      const bookingResult = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1'],
        ['Passenger 1'],
        2500,
        'paystack'
      );

      const booking = bookingManager.getBooking(bookingResult.bookingId!);

      expect(booking).toBeDefined();
      expect(booking!.id).toBe(bookingResult.bookingId);
    });

    it('should get customer trns_bookings', () => {
      bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1'],
        ['Passenger 1'],
        2500,
        'paystack'
      );

      bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_2'],
        ['Passenger 2'],
        2500,
        'flutterwave'
      );

      const trns_bookings = bookingManager.getCustomerBookings(customer.id);

      expect(trns_bookings.length).toBe(2);
    });

    it('should get trip trns_bookings', () => {
      const result1 = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1'],
        ['Passenger 1'],
        2500,
        'paystack'
      );

      const result2 = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_2'],
        ['Passenger 2'],
        2500,
        'paystack'
      );

      // Confirm one booking
      bookingManager.confirmBooking(result1.bookingId!, 'REF_001');

      const tripBookings = bookingManager.getTripBookings(tripId);

      // Only confirmed trns_bookings are returned
      expect(tripBookings.length).toBe(1);
      expect(tripBookings[0]!.id).toBe(result1.bookingId);
    });

    it('should return null for non-existent booking', () => {
      const booking = bookingManager.getBooking('non_existent');

      expect(booking).toBeNull();
    });
  });

  describe('Trip Statistics', () => {
    it('should calculate trip statistics', () => {
      const result1 = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1', 'seat_trip_001_2'],
        ['Passenger 1', 'Passenger 2'],
        5000,
        'paystack'
      );

      const result2 = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_3'],
        ['Passenger 3'],
        2500,
        'paystack'
      );

      // Confirm first booking
      bookingManager.confirmBooking(result1.bookingId!, 'REF_001');

      const stats = bookingManager.getTripStats(tripId);

      expect(stats.totalBookings).toBe(2);
      expect(stats.confirmedBookings).toBe(1);
      expect(stats.pendingBookings).toBe(1);
      expect(stats.totalSeatsBooked).toBe(3);
      expect(stats.totalRevenue).toBe(5000);
    });
  });

  describe('Integration with TRN-1', () => {
    it('should reserve trns_seats via TRN-1', () => {
      const bookingResult = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1'],
        ['Passenger 1'],
        2500,
        'paystack'
      );

      expect(bookingResult.success).toBe(true);
      expect(bookingResult.reservationTokens).toHaveLength(1);

      // Verify seat is reserved in TRN-1
      const availability = seatInventory.getAvailability(tripId);
      expect(availability!.reservedSeats).toBe(1);
      expect(availability!.availableSeats).toBe(49);
    });

    it('should confirm trns_seats via TRN-1', () => {
      const bookingResult = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1'],
        ['Passenger 1'],
        2500,
        'paystack'
      );

      bookingManager.confirmBooking(bookingResult.bookingId!, 'REF_001');

      // Verify seat is confirmed in TRN-1
      const availability = seatInventory.getAvailability(tripId);
      expect(availability!.confirmedSeats).toBe(1);
      expect(availability!.reservedSeats).toBe(0);
    });

    it('should release trns_seats via TRN-1 on cancellation', () => {
      const bookingResult = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1'],
        ['Passenger 1'],
        2500,
        'paystack'
      );

      bookingManager.cancelBooking(bookingResult.bookingId!, 'Test');

      // Verify seat is released in TRN-1
      const availability = seatInventory.getAvailability(tripId);
      expect(availability!.availableSeats).toBe(50);
      expect(availability!.reservedSeats).toBe(0);
    });
  });

  describe('Multiple Bookings', () => {
    it('should handle multiple concurrent trns_bookings', () => {
      const result1 = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1'],
        ['Passenger 1'],
        2500,
        'paystack'
      );

      const result2 = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_2'],
        ['Passenger 2'],
        2500,
        'paystack'
      );

      const result3 = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_3'],
        ['Passenger 3'],
        2500,
        'paystack'
      );

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);
      expect(result3.success).toBe(true);

      const availability = seatInventory.getAvailability(tripId);
      expect(availability!.reservedSeats).toBe(3);
    });

    it('should prevent double-booking', () => {
      const result1 = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1'],
        ['Passenger 1'],
        2500,
        'paystack'
      );

      const result2 = bookingManager.createBooking(
        customer.id,
        tripId,
        ['seat_trip_001_1'],
        ['Passenger 2'],
        2500,
        'paystack'
      );

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(false);
    });
  });
});
