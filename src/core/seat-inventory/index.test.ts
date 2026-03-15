import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SeatInventoryManager } from './index';

describe('TRN-1: Seat Inventory Synchronization & Atomic Validation', () => {
  let manager: SeatInventoryManager;
  const tripId = 'trip_001';
  const operatorId = 'op_001';
  const routeId = 'route_001';
  const departureTime = new Date(Date.now() + 3600000); // 1 hour from now

  beforeEach(() => {
    manager = new SeatInventoryManager();
  });

  describe('Trip Creation', () => {
    it('should create a trip with specified number of seats', () => {
      const trip = manager.createTrip(tripId, operatorId, routeId, departureTime, 50);

      expect(trip.id).toBe(tripId);
      expect(trip.operatorId).toBe(operatorId);
      expect(trip.totalSeats).toBe(50);
      expect(trip.seats.length).toBe(50);
      expect(trip.state).toBe('scheduled');
    });

    it('should initialize all seats as available', () => {
      const trip = manager.createTrip(tripId, operatorId, routeId, departureTime, 10);

      trip.seats.forEach(seat => {
        expect(seat.status).toBe('available');
        expect(seat.reservedBy).toBeUndefined();
      });
    });

    it('should emit trip.created event', () => {
      const callback = vi.fn();
      manager.on('trip.created', callback);

      manager.createTrip(tripId, operatorId, routeId, departureTime, 50);

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0][0].id).toBe(tripId);
    });
  });

  describe('Seat Reservation', () => {
    beforeEach(() => {
      manager.createTrip(tripId, operatorId, routeId, departureTime, 50);
    });

    it('should reserve an available seat', () => {
      const result = manager.reserveSeat(tripId, '1', 'user_001');

      expect(result.success).toBe(true);
      expect(result.seatId).toBeDefined();
      expect(result.token).toBeDefined();
      expect(result.expiresAt).toBeDefined();
    });

    it('should not reserve a seat that is already reserved', () => {
      manager.reserveSeat(tripId, '1', 'user_001');
      const result = manager.reserveSeat(tripId, '1', 'user_002');

      expect(result.success).toBe(false);
      expect(result.error).toContain('reserved');
    });

    it('should generate a unique reservation token', () => {
      const result1 = manager.reserveSeat(tripId, '1', 'user_001');
      const result2 = manager.reserveSeat(tripId, '2', 'user_002');

      expect(result1.token).not.toBe(result2.token);
    });

    it('should set token expiration to 30 seconds', () => {
      const beforeTime = new Date();
      const result = manager.reserveSeat(tripId, '1', 'user_001');
      const afterTime = new Date();

      expect(result.expiresAt).toBeDefined();
      const expirationTime = result.expiresAt!.getTime();
      const expectedMin = beforeTime.getTime() + 29000; // 29 seconds
      const expectedMax = afterTime.getTime() + 31000; // 31 seconds

      expect(expirationTime).toBeGreaterThanOrEqual(expectedMin);
      expect(expirationTime).toBeLessThanOrEqual(expectedMax);
    });

    it('should emit seat.reserved event', () => {
      const callback = vi.fn();
      manager.on('seat.reserved', callback);

      manager.reserveSeat(tripId, '1', 'user_001');

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0][0].seat.seatNumber).toBe('1');
      expect(callback.mock.calls[0][0].token).toBeDefined();
    });

    it('should not reserve a seat from non-existent trip', () => {
      const result = manager.reserveSeat('non_existent_trip', '1', 'user_001');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Trip not found');
    });

    it('should not reserve a non-existent seat', () => {
      const result = manager.reserveSeat(tripId, '999', 'user_001');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Seat not found');
    });
  });

  describe('Seat Confirmation (Atomic Validation)', () => {
    beforeEach(() => {
      manager.createTrip(tripId, operatorId, routeId, departureTime, 50);
    });

    it('should confirm a reserved seat with valid token', () => {
      const reservation = manager.reserveSeat(tripId, '1', 'user_001');
      const result = manager.confirmSeat(tripId, reservation.seatId!, reservation.token!, 'user_001');

      expect(result.success).toBe(true);
      expect(result.seatId).toBe(reservation.seatId);
    });

    it('should not confirm with invalid token', () => {
      const reservation = manager.reserveSeat(tripId, '1', 'user_001');
      const result = manager.confirmSeat(tripId, reservation.seatId!, 'invalid_token', 'user_001');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid');
    });

    it('should not confirm if token user does not match', () => {
      const reservation = manager.reserveSeat(tripId, '1', 'user_001');
      const result = manager.confirmSeat(tripId, reservation.seatId!, reservation.token!, 'user_002');

      expect(result.success).toBe(false);
      expect(result.error).toContain('does not match');
    });

    it('should emit seat.confirmed event', () => {
      const callback = vi.fn();
      manager.on('seat.confirmed', callback);

      const reservation = manager.reserveSeat(tripId, '1', 'user_001');
      manager.confirmSeat(tripId, reservation.seatId!, reservation.token!, 'user_001');

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0][0].seat.status).toBe('confirmed');
    });

    it('should update seat status to confirmed', () => {
      const reservation = manager.reserveSeat(tripId, '1', 'user_001');
      manager.confirmSeat(tripId, reservation.seatId!, reservation.token!, 'user_001');

      const trip = manager.getTrip(tripId);
      const seat = trip!.seats.find(s => s.seatNumber === '1');

      expect(seat!.status).toBe('confirmed');
      expect(seat!.confirmedBy).toBe('user_001');
      expect(seat!.confirmedAt).toBeDefined();
    });
  });

  describe('Seat Release', () => {
    beforeEach(() => {
      manager.createTrip(tripId, operatorId, routeId, departureTime, 50);
    });

    it('should release a reserved seat', () => {
      const reservation = manager.reserveSeat(tripId, '1', 'user_001');
      const result = manager.releaseSeat(tripId, reservation.seatId!);

      expect(result.success).toBe(true);
    });

    it('should release a confirmed seat', () => {
      const reservation = manager.reserveSeat(tripId, '1', 'user_001');
      manager.confirmSeat(tripId, reservation.seatId!, reservation.token!, 'user_001');

      const result = manager.releaseSeat(tripId, reservation.seatId!);

      expect(result.success).toBe(true);
    });

    it('should not release an already available seat', () => {
      const trip = manager.getTrip(tripId);
      const seatId = trip!.seats[0].id;

      const result = manager.releaseSeat(tripId, seatId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('already available');
    });

    it('should reset seat to available status', () => {
      const reservation = manager.reserveSeat(tripId, '1', 'user_001');
      manager.releaseSeat(tripId, reservation.seatId!);

      const trip = manager.getTrip(tripId);
      const seat = trip!.seats.find(s => s.seatNumber === '1');

      expect(seat!.status).toBe('available');
      expect(seat!.reservedBy).toBeUndefined();
      expect(seat!.confirmedBy).toBeUndefined();
    });

    it('should emit seat.released event', () => {
      const callback = vi.fn();
      manager.on('seat.released', callback);

      const reservation = manager.reserveSeat(tripId, '1', 'user_001');
      manager.releaseSeat(tripId, reservation.seatId!);

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0][0].previousStatus).toBe('reserved');
    });
  });

  describe('Availability Checking', () => {
    beforeEach(() => {
      manager.createTrip(tripId, operatorId, routeId, departureTime, 50);
    });

    it('should return correct availability for new trip', () => {
      const availability = manager.getAvailability(tripId);

      expect(availability!.totalSeats).toBe(50);
      expect(availability!.availableSeats).toBe(50);
      expect(availability!.reservedSeats).toBe(0);
      expect(availability!.confirmedSeats).toBe(0);
    });

    it('should update availability after reservation', () => {
      manager.reserveSeat(tripId, '1', 'user_001');
      manager.reserveSeat(tripId, '2', 'user_002');

      const availability = manager.getAvailability(tripId);

      expect(availability!.availableSeats).toBe(48);
      expect(availability!.reservedSeats).toBe(2);
    });

    it('should update availability after confirmation', () => {
      const res1 = manager.reserveSeat(tripId, '1', 'user_001');
      manager.confirmSeat(tripId, res1.seatId!, res1.token!, 'user_001');

      const availability = manager.getAvailability(tripId);

      expect(availability!.availableSeats).toBe(49);
      expect(availability!.reservedSeats).toBe(0);
      expect(availability!.confirmedSeats).toBe(1);
    });

    it('should return null for non-existent trip', () => {
      const availability = manager.getAvailability('non_existent');

      expect(availability).toBeNull();
    });
  });

  describe('Token Expiration & Cleanup', () => {
    beforeEach(() => {
      manager.createTrip(tripId, operatorId, routeId, departureTime, 50);
    });

    it('should allow re-reservation after token expires', () => {
      // Reserve seat
      const res1 = manager.reserveSeat(tripId, '1', 'user_001');
      expect(res1.success).toBe(true);

      // Try to reserve same seat (should fail)
      const res2 = manager.reserveSeat(tripId, '1', 'user_002');
      expect(res2.success).toBe(false);

      // Manually expire the token by modifying the seat
      const trip = manager.getTrip(tripId);
      const seat = trip!.seats.find(s => s.seatNumber === '1');
      if (seat) {
        // Set expiration to past
        seat.reservationExpiresAt = new Date(Date.now() - 1000);
      }

      // Now cleanup should free the seat
      manager.cleanupExpiredTokens();

      // Now should be able to reserve
      const res3 = manager.reserveSeat(tripId, '1', 'user_002');
      expect(res3.success).toBe(true);
    });

    it('should cleanup expired tokens', () => {
      manager.reserveSeat(tripId, '1', 'user_001');
      manager.reserveSeat(tripId, '2', 'user_002');

      const cleaned = manager.cleanupExpiredTokens();

      // In this test, tokens are not actually expired yet
      expect(cleaned).toBe(0);
    });
  });

  describe('Concurrency & Conflict Resolution', () => {
    beforeEach(() => {
      manager.createTrip(tripId, operatorId, routeId, departureTime, 50);
    });

    it('should handle multiple concurrent reservations on different seats', () => {
      const res1 = manager.reserveSeat(tripId, '1', 'user_001');
      const res2 = manager.reserveSeat(tripId, '2', 'user_002');
      const res3 = manager.reserveSeat(tripId, '3', 'user_003');

      expect(res1.success).toBe(true);
      expect(res2.success).toBe(true);
      expect(res3.success).toBe(true);
    });

    it('should prevent double-booking on same seat', () => {
      const res1 = manager.reserveSeat(tripId, '1', 'user_001');
      expect(res1.success).toBe(true);

      const res2 = manager.reserveSeat(tripId, '1', 'user_002');
      expect(res2.success).toBe(false);

      const res3 = manager.reserveSeat(tripId, '1', 'user_001');
      expect(res3.success).toBe(false);
    });

    it('should handle confirm-then-release-then-reserve sequence', () => {
      const res1 = manager.reserveSeat(tripId, '1', 'user_001');
      manager.confirmSeat(tripId, res1.seatId!, res1.token!, 'user_001');
      manager.releaseSeat(tripId, res1.seatId!);

      const res2 = manager.reserveSeat(tripId, '1', 'user_002');
      expect(res2.success).toBe(true);
    });
  });
});
