import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TripStateMachine } from './index';

describe('TRN-4: Operator Management - Trip State Machine', () => {
  let stateMachine: TripStateMachine;

  const tripData = {
    tripId: 'trip_001',
    operatorId: 'op_001',
    routeId: 'route_001',
    vehicleId: 'vehicle_001',
    driverId: 'driver_001',
    departureTime: new Date(Date.now() + 3600000),
    estimatedArrivalTime: new Date(Date.now() + 7200000)
  };

  beforeEach(() => {
    stateMachine = new TripStateMachine();
  });

  describe('Trip Creation', () => {
    it('should create a trip in scheduled state', () => {
      const trip = stateMachine.createTrip(
        tripData.tripId,
        tripData.operatorId,
        tripData.routeId,
        tripData.vehicleId,
        tripData.driverId,
        tripData.departureTime,
        tripData.estimatedArrivalTime
      );

      expect(trip.id).toBe(tripData.tripId);
      expect(trip.state).toBe('scheduled');
      expect(trip.transitions.length).toBe(1);
    });

    it('should emit trip.created event', () => {
      const callback = vi.fn();
      stateMachine.on('trip.created', callback);

      stateMachine.createTrip(
        tripData.tripId,
        tripData.operatorId,
        tripData.routeId,
        tripData.vehicleId,
        tripData.driverId,
        tripData.departureTime,
        tripData.estimatedArrivalTime
      );

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0][0].state).toBe('scheduled');
    });
  });

  describe('State Transitions', () => {
    beforeEach(() => {
      stateMachine.createTrip(
        tripData.tripId,
        tripData.operatorId,
        tripData.routeId,
        tripData.vehicleId,
        tripData.driverId,
        tripData.departureTime,
        tripData.estimatedArrivalTime
      );
    });

    it('should transition from scheduled to boarding', () => {
      const result = stateMachine.startBoarding(tripData.tripId);

      expect(result.success).toBe(true);
      expect(result.newState).toBe('boarding');

      const trip = stateMachine.getTrip(tripData.tripId);
      expect(trip!.state).toBe('boarding');
    });

    it('should transition from boarding to in_transit', () => {
      stateMachine.startBoarding(tripData.tripId);

      const result = stateMachine.startTrip(tripData.tripId, {
        latitude: 6.5244,
        longitude: 3.3792
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe('in_transit');

      const trip = stateMachine.getTrip(tripData.tripId);
      expect(trip!.state).toBe('in_transit');
      expect(trip!.currentLocation).toBeDefined();
    });

    it('should transition from in_transit to completed', () => {
      stateMachine.startBoarding(tripData.tripId);
      stateMachine.startTrip(tripData.tripId);

      const result = stateMachine.completeTrip(tripData.tripId, {
        latitude: 6.5244,
        longitude: 3.3792
      });

      expect(result.success).toBe(true);
      expect(result.newState).toBe('completed');

      const trip = stateMachine.getTrip(tripData.tripId);
      expect(trip!.state).toBe('completed');
    });

    it('should not allow invalid state transitions', () => {
      const result = stateMachine.startTrip(tripData.tripId);

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot start trip');
    });

    it('should not allow transition from completed state', () => {
      stateMachine.startBoarding(tripData.tripId);
      stateMachine.startTrip(tripData.tripId);
      stateMachine.completeTrip(tripData.tripId);

      const result = stateMachine.startBoarding(tripData.tripId);

      expect(result.success).toBe(false);
    });
  });

  describe('Trip Cancellation', () => {
    beforeEach(() => {
      stateMachine.createTrip(
        tripData.tripId,
        tripData.operatorId,
        tripData.routeId,
        tripData.vehicleId,
        tripData.driverId,
        tripData.departureTime,
        tripData.estimatedArrivalTime
      );
    });

    it('should cancel a scheduled trip', () => {
      const result = stateMachine.cancelTrip(tripData.tripId, 'Operator requested');

      expect(result.success).toBe(true);
      expect(result.newState).toBe('cancelled');

      const trip = stateMachine.getTrip(tripData.tripId);
      expect(trip!.state).toBe('cancelled');
    });

    it('should cancel a boarding trip', () => {
      stateMachine.startBoarding(tripData.tripId);

      const result = stateMachine.cancelTrip(tripData.tripId, 'Vehicle breakdown');

      expect(result.success).toBe(true);

      const trip = stateMachine.getTrip(tripData.tripId);
      expect(trip!.state).toBe('cancelled');
    });

    it('should not cancel a completed trip', () => {
      stateMachine.startBoarding(tripData.tripId);
      stateMachine.startTrip(tripData.tripId);
      stateMachine.completeTrip(tripData.tripId);

      const result = stateMachine.cancelTrip(tripData.tripId, 'Reason');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot cancel a completed trip');
    });

    it('should not cancel an already cancelled trip', () => {
      stateMachine.cancelTrip(tripData.tripId, 'Reason 1');

      const result = stateMachine.cancelTrip(tripData.tripId, 'Reason 2');

      expect(result.success).toBe(false);
      expect(result.error).toContain('already cancelled');
    });
  });

  describe('Location Updates', () => {
    beforeEach(() => {
      stateMachine.createTrip(
        tripData.tripId,
        tripData.operatorId,
        tripData.routeId,
        tripData.vehicleId,
        tripData.driverId,
        tripData.departureTime,
        tripData.estimatedArrivalTime
      );
      stateMachine.startBoarding(tripData.tripId);
      stateMachine.startTrip(tripData.tripId);
    });

    it('should update location for in-transit trip', () => {
      const result = stateMachine.updateLocation(tripData.tripId, 6.5244, 3.3792);

      expect(result.success).toBe(true);

      const trip = stateMachine.getTrip(tripData.tripId);
      expect(trip!.currentLocation).toEqual({
        latitude: 6.5244,
        longitude: 3.3792
      });
    });

    it('should not update location for non-transit trip', () => {
      const tripId2 = 'trip_002';
      stateMachine.createTrip(
        tripId2,
        tripData.operatorId,
        tripData.routeId,
        tripData.vehicleId,
        tripData.driverId,
        tripData.departureTime,
        tripData.estimatedArrivalTime
      );

      const result = stateMachine.updateLocation(tripId2, 6.5244, 3.3792);

      expect(result.success).toBe(false);
      expect(result.error).toContain('in-transit');
    });

    it('should emit location_updated event', () => {
      const callback = vi.fn();
      stateMachine.on('trip.location_updated', callback);

      stateMachine.updateLocation(tripData.tripId, 6.5244, 3.3792);

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0][0].currentLocation).toEqual({
        latitude: 6.5244,
        longitude: 3.3792
      });
    });
  });

  describe('Trip Retrieval', () => {
    beforeEach(() => {
      stateMachine.createTrip(
        tripData.tripId,
        tripData.operatorId,
        tripData.routeId,
        tripData.vehicleId,
        tripData.driverId,
        tripData.departureTime,
        tripData.estimatedArrivalTime
      );
    });

    it('should get a trip by ID', () => {
      const trip = stateMachine.getTrip(tripData.tripId);

      expect(trip).toBeDefined();
      expect(trip!.id).toBe(tripData.tripId);
    });

    it('should return null for non-existent trip', () => {
      const trip = stateMachine.getTrip('non_existent');

      expect(trip).toBeNull();
    });

    it('should get operator trips', () => {
      const trip2Id = 'trip_002';
      stateMachine.createTrip(
        trip2Id,
        tripData.operatorId,
        tripData.routeId,
        tripData.vehicleId,
        tripData.driverId,
        tripData.departureTime,
        tripData.estimatedArrivalTime
      );

      const trips = stateMachine.getOperatorTrips(tripData.operatorId);

      expect(trips.length).toBe(2);
    });

    it('should filter operator trips by state', () => {
      const trip2Id = 'trip_002';
      stateMachine.createTrip(
        trip2Id,
        tripData.operatorId,
        tripData.routeId,
        tripData.vehicleId,
        tripData.driverId,
        tripData.departureTime,
        tripData.estimatedArrivalTime
      );

      stateMachine.startBoarding(tripData.tripId);

      const scheduledTrips = stateMachine.getOperatorTrips(
        tripData.operatorId,
        'scheduled'
      );
      const boardingTrips = stateMachine.getOperatorTrips(
        tripData.operatorId,
        'boarding'
      );

      expect(scheduledTrips.length).toBe(1);
      expect(boardingTrips.length).toBe(1);
    });
  });

  describe('Operator Statistics', () => {
    beforeEach(() => {
      // Create multiple trips in different states
      stateMachine.createTrip(
        'trip_001',
        tripData.operatorId,
        tripData.routeId,
        tripData.vehicleId,
        tripData.driverId,
        tripData.departureTime,
        tripData.estimatedArrivalTime
      );

      stateMachine.createTrip(
        'trip_002',
        tripData.operatorId,
        tripData.routeId,
        tripData.vehicleId,
        tripData.driverId,
        tripData.departureTime,
        tripData.estimatedArrivalTime
      );

      stateMachine.createTrip(
        'trip_003',
        tripData.operatorId,
        tripData.routeId,
        tripData.vehicleId,
        tripData.driverId,
        tripData.departureTime,
        tripData.estimatedArrivalTime
      );

      // Transition trips to different states
      stateMachine.startBoarding('trip_001');
      stateMachine.startBoarding('trip_002');
      stateMachine.startTrip('trip_002');
      stateMachine.startBoarding('trip_003');
      stateMachine.startTrip('trip_003');
      stateMachine.completeTrip('trip_003');
    });

    it('should calculate operator statistics', () => {
      const stats = stateMachine.getOperatorStats(tripData.operatorId);

      // trip_001: boarding
      // trip_002: in_transit
      // trip_003: completed
      expect(stats.totalTrips).toBe(3);
      expect(stats.scheduledTrips).toBe(0);
      expect(stats.boardingTrips).toBe(1);
      expect(stats.inTransitTrips).toBe(1);
      expect(stats.completedTrips).toBe(1);
      expect(stats.cancelledTrips).toBe(0);
    });
  });

  describe('Trip History', () => {
    beforeEach(() => {
      stateMachine.createTrip(
        tripData.tripId,
        tripData.operatorId,
        tripData.routeId,
        tripData.vehicleId,
        tripData.driverId,
        tripData.departureTime,
        tripData.estimatedArrivalTime
      );
    });

    it('should track trip state transitions', () => {
      stateMachine.startBoarding(tripData.tripId);
      stateMachine.startTrip(tripData.tripId);
      stateMachine.completeTrip(tripData.tripId);

      const history = stateMachine.getTripHistory(tripData.tripId);

      expect(history.length).toBe(4); // initial + 3 transitions
      expect(history[0].to).toBe('scheduled');
      expect(history[1].to).toBe('boarding');
      expect(history[2].to).toBe('in_transit');
      expect(history[3].to).toBe('completed');
    });

    it('should include cancellation reason in history', () => {
      stateMachine.cancelTrip(tripData.tripId, 'Vehicle breakdown');

      const history = stateMachine.getTripHistory(tripData.tripId);
      const cancellationTransition = history.find(t => t.to === 'cancelled');

      expect(cancellationTransition!.reason).toBe('Vehicle breakdown');
    });

    it('should return empty history for non-existent trip', () => {
      const history = stateMachine.getTripHistory('non_existent');

      expect(history).toEqual([]);
    });
  });

  describe('State Validation', () => {
    it('should validate allowed transitions', () => {
      expect(stateMachine.isValidTransition('scheduled', 'boarding')).toBe(true);
      expect(stateMachine.isValidTransition('boarding', 'in_transit')).toBe(true);
      expect(stateMachine.isValidTransition('in_transit', 'completed')).toBe(true);
    });

    it('should reject invalid transitions', () => {
      expect(stateMachine.isValidTransition('scheduled', 'in_transit')).toBe(false);
      expect(stateMachine.isValidTransition('completed', 'boarding')).toBe(false);
      expect(stateMachine.isValidTransition('in_transit', 'scheduled')).toBe(false);
    });

    it('should allow cancellation from most states', () => {
      expect(stateMachine.isValidTransition('scheduled', 'cancelled')).toBe(true);
      expect(stateMachine.isValidTransition('boarding', 'cancelled')).toBe(true);
      expect(stateMachine.isValidTransition('in_transit', 'cancelled')).toBe(true);
    });

    it('should not allow transitions from completed state', () => {
      expect(stateMachine.isValidTransition('completed', 'boarding')).toBe(false);
      expect(stateMachine.isValidTransition('completed', 'cancelled')).toBe(false);
    });
  });

  describe('Event Emissions', () => {
    beforeEach(() => {
      stateMachine.createTrip(
        tripData.tripId,
        tripData.operatorId,
        tripData.routeId,
        tripData.vehicleId,
        tripData.driverId,
        tripData.departureTime,
        tripData.estimatedArrivalTime
      );
    });

    it('should emit state-specific events', () => {
      const boardingCallback = vi.fn();
      const transitCallback = vi.fn();
      const completedCallback = vi.fn();

      stateMachine.on('trip.boarding', boardingCallback);
      stateMachine.on('trip.in_transit', transitCallback);
      stateMachine.on('trip.completed', completedCallback);

      stateMachine.startBoarding(tripData.tripId);
      stateMachine.startTrip(tripData.tripId);
      stateMachine.completeTrip(tripData.tripId);

      expect(boardingCallback).toHaveBeenCalled();
      expect(transitCallback).toHaveBeenCalled();
      expect(completedCallback).toHaveBeenCalled();
    });

    it('should emit generic state_changed event', () => {
      const callback = vi.fn();
      stateMachine.on('trip.state_changed', callback);

      stateMachine.startBoarding(tripData.tripId);

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0][0].from).toBe('scheduled');
      expect(callback.mock.calls[0][0].to).toBe('boarding');
    });
  });
});
