/**
 * TRN-4: Operator Management - Trip State Machine
 * Blueprint Reference: Part 10.3 (Transportation & Mobility Suite)
 * 
 * State machine for trip lifecycle management.
 * States: Scheduled → Boarding → In Transit → Completed
 */

export type TripState = 'scheduled' | 'boarding' | 'in_transit' | 'completed' | 'cancelled';

export interface TripStateTransition {
  from: TripState;
  to: TripState;
  timestamp: Date;
  reason?: string;
}

export interface Trip {
  id: string;
  operatorId: string;
  routeId: string;
  vehicleId: string;
  driverId: string;
  departureTime: Date;
  estimatedArrivalTime: Date;
  state: TripState;
  currentLocation?: { latitude: number; longitude: number };
  transitions: TripStateTransition[];
  createdAt: Date;
}

export interface StateTransitionResult {
  success: boolean;
  newState?: TripState;
  error?: string;
}

export class TripStateMachine {
  private trips: Map<string, Trip> = new Map();
  private eventCallbacks: Map<string, Function[]> = new Map();

  // Valid state transitions
  private readonly validTransitions: Map<TripState, TripState[]> = new Map([
    ['scheduled', ['boarding', 'cancelled']],
    ['boarding', ['in_transit', 'cancelled']],
    ['in_transit', ['completed', 'cancelled']],
    ['completed', []],
    ['cancelled', []]
  ]);

  /**
   * Creates a new trip in scheduled state.
   */
  createTrip(
    tripId: string,
    operatorId: string,
    routeId: string,
    vehicleId: string,
    driverId: string,
    departureTime: Date,
    estimatedArrivalTime: Date
  ): Trip {
    const trip: Trip = {
      id: tripId,
      operatorId,
      routeId,
      vehicleId,
      driverId,
      departureTime,
      estimatedArrivalTime,
      state: 'scheduled',
      transitions: [
        {
          from: 'scheduled' as TripState,
          to: 'scheduled',
          timestamp: new Date()
        }
      ],
      createdAt: new Date()
    };

    this.trips.set(tripId, trip);
    this.emit('trip.created', trip);

    return trip;
  }

  /**
   * Transitions a trip to boarding state.
   */
  startBoarding(tripId: string): StateTransitionResult {
    return this.transitionState(tripId, 'boarding', 'Boarding started');
  }

  /**
   * Transitions a trip to in_transit state.
   */
  startTrip(tripId: string, currentLocation?: { latitude: number; longitude: number }): StateTransitionResult {
    const trip = this.trips.get(tripId);
    if (!trip) {
      return { success: false, error: 'Trip not found' };
    }

    if (trip.state !== 'boarding') {
      return { success: false, error: `Cannot start trip from ${trip.state} state` };
    }

    if (currentLocation !== undefined) {
      trip.currentLocation = currentLocation;
    }
    return this.transitionState(tripId, 'in_transit', 'Trip started');
  }

  /**
   * Transitions a trip to completed state.
   */
  completeTrip(tripId: string, finalLocation?: { latitude: number; longitude: number }): StateTransitionResult {
    const trip = this.trips.get(tripId);
    if (!trip) {
      return { success: false, error: 'Trip not found' };
    }

    if (trip.state !== 'in_transit') {
      return { success: false, error: `Cannot complete trip from ${trip.state} state` };
    }

    if (finalLocation) {
      trip.currentLocation = finalLocation;
    }

    return this.transitionState(tripId, 'completed', 'Trip completed');
  }

  /**
   * Cancels a trip.
   */
  cancelTrip(tripId: string, reason: string): StateTransitionResult {
    const trip = this.trips.get(tripId);
    if (!trip) {
      return { success: false, error: 'Trip not found' };
    }

    if (trip.state === 'completed') {
      return { success: false, error: 'Cannot cancel a completed trip' };
    }

    if (trip.state === 'cancelled') {
      return { success: false, error: 'Trip is already cancelled' };
    }

    return this.transitionState(tripId, 'cancelled', reason);
  }

  /**
   * Updates trip location.
   */
  updateLocation(
    tripId: string,
    latitude: number,
    longitude: number
  ): StateTransitionResult {
    const trip = this.trips.get(tripId);
    if (!trip) {
      return { success: false, error: 'Trip not found' };
    }

    if (trip.state !== 'in_transit') {
      return { success: false, error: 'Can only update location for in-transit trips' };
    }

    trip.currentLocation = { latitude, longitude };
    this.emit('trip.location_updated', trip);

    return { success: true, newState: trip.state };
  }

  /**
   * Gets a trip by ID.
   */
  getTrip(tripId: string): Trip | null {
    return this.trips.get(tripId) || null;
  }

  /**
   * Gets all trips for an operator.
   */
  getOperatorTrips(operatorId: string, state?: TripState): Trip[] {
    return Array.from(this.trips.values()).filter(
      trip =>
        trip.operatorId === operatorId &&
        (!state || trip.state === state)
    );
  }

  /**
   * Gets trip statistics for an operator.
   */
  getOperatorStats(operatorId: string): {
    totalTrips: number;
    scheduledTrips: number;
    boardingTrips: number;
    inTransitTrips: number;
    completedTrips: number;
    cancelledTrips: number;
  } {
    const trips = this.getOperatorTrips(operatorId);

    return {
      totalTrips: trips.length,
      scheduledTrips: trips.filter(t => t.state === 'scheduled').length,
      boardingTrips: trips.filter(t => t.state === 'boarding').length,
      inTransitTrips: trips.filter(t => t.state === 'in_transit').length,
      completedTrips: trips.filter(t => t.state === 'completed').length,
      cancelledTrips: trips.filter(t => t.state === 'cancelled').length
    };
  }

  /**
   * Gets trip history (state transitions).
   */
  getTripHistory(tripId: string): TripStateTransition[] {
    const trip = this.trips.get(tripId);
    return trip ? trip.transitions : [];
  }

  /**
   * Validates if a state transition is allowed.
   */
  isValidTransition(from: TripState, to: TripState): boolean {
    const allowedTransitions = this.validTransitions.get(from) || [];
    return allowedTransitions.includes(to);
  }

  /**
   * Internal method to perform state transition.
   */
  private transitionState(
    tripId: string,
    newState: TripState,
    reason?: string
  ): StateTransitionResult {
    const trip = this.trips.get(tripId);
    if (!trip) {
      return { success: false, error: 'Trip not found' };
    }

    if (!this.isValidTransition(trip.state, newState)) {
      return {
        success: false,
        error: `Cannot transition from ${trip.state} to ${newState}`
      };
    }

    const oldState = trip.state;
    trip.state = newState;

    const transition: TripStateTransition = { from: oldState, to: newState, timestamp: new Date() };
    if (reason !== undefined) transition.reason = reason;
    trip.transitions.push(transition);

    this.emit(`trip.${newState}`, trip);
    this.emit('trip.state_changed', {
      tripId,
      from: oldState,
      to: newState,
      timestamp: new Date(),
      reason
    });

    return { success: true, newState };
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
