/**
 * TRN-2: Agent Sales Application (Offline-first bus park POS)
 * Blueprint Reference: Part 10.3 (Transportation & Mobility Suite)
 * 
 * Offline-first sales transaction management for bus park agents.
 * Supports queuing, conflict resolution, and automatic sync.
 */

export interface SalesTransaction {
  id: string;
  agentId: string;
  tripId: string;
  seatIds: string[];
  passengerNames: string[];
  totalAmount: number;
  paymentMethod: 'cash' | 'mobile_money' | 'card';
  paymentStatus: 'pending' | 'completed' | 'failed';
  syncStatus: 'pending' | 'synced' | 'failed';
  createdAt: Date;
  syncedAt?: Date;
  receiptId?: string;
  metadata?: Record<string, any>;
}

export interface Agent {
  id: string;
  name: string;
  phone: string;
  email: string;
  operatorId: string;
  busParks: string[];
  role: 'agent' | 'supervisor';
  status: 'active' | 'inactive';
  createdAt: Date;
}

export interface Receipt {
  id: string;
  transactionId: string;
  agentId: string;
  tripId: string;
  passengers: Array<{ name: string; seatNumber: string }>;
  totalAmount: number;
  paymentMethod: string;
  issuedAt: Date;
  printedAt?: Date;
}

export interface SalesResult {
  success: boolean;
  transactionId?: string;
  receiptId?: string;
  error?: string;
}

export class SalesTransactionManager {
  private transactions: Map<string, SalesTransaction> = new Map();
  private receipts: Map<string, Receipt> = new Map();
  private agents: Map<string, Agent> = new Map();
  private eventCallbacks: Map<string, Function[]> = new Map();

  /**
   * Registers an agent for the system.
   */
  registerAgent(agent: Agent): void {
    this.agents.set(agent.id, agent);
    this.emit('agent.registered', agent);
  }

  /**
   * Creates a new sales transaction.
   * Works offline - transaction is queued for sync.
   */
  createTransaction(
    agentId: string,
    tripId: string,
    seatIds: string[],
    passengerNames: string[],
    totalAmount: number,
    paymentMethod: 'cash' | 'mobile_money' | 'card'
  ): SalesResult {
    const agent = this.agents.get(agentId);
    if (!agent) {
      return { success: false, error: 'Agent not found' };
    }

    if (agent.status !== 'active') {
      return { success: false, error: 'Agent is not active' };
    }

    if (seatIds.length !== passengerNames.length) {
      return { success: false, error: 'Seat and passenger count mismatch' };
    }

    if (totalAmount <= 0) {
      return { success: false, error: 'Invalid amount' };
    }

    const transaction: SalesTransaction = {
      id: `txn_${crypto.randomUUID()}`,
      agentId,
      tripId,
      seatIds,
      passengerNames,
      totalAmount,
      paymentMethod,
      paymentStatus: 'pending',
      syncStatus: 'pending',
      createdAt: new Date()
    };

    this.transactions.set(transaction.id, transaction);

    // Generate receipt
    const receipt = this.generateReceipt(transaction);
    this.receipts.set(receipt.id, receipt);
    transaction.receiptId = receipt.id;

    this.emit('transaction.created', transaction);

    return {
      success: true,
      transactionId: transaction.id,
      receiptId: receipt.id
    };
  }

  /**
   * Completes payment for a transaction.
   */
  completePayment(transactionId: string, paymentReference: string): SalesResult {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      return { success: false, error: 'Transaction not found' };
    }

    transaction.paymentStatus = 'completed';
    transaction.metadata = {
      ...transaction.metadata,
      paymentReference
    };

    this.emit('transaction.payment_completed', transaction);

    return { success: true, transactionId };
  }

  /**
   * Fails a payment for a transaction.
   */
  failPayment(transactionId: string, reason: string): SalesResult {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      return { success: false, error: 'Transaction not found' };
    }

    transaction.paymentStatus = 'failed';
    transaction.metadata = {
      ...transaction.metadata,
      failureReason: reason
    };

    this.emit('transaction.payment_failed', transaction);

    return { success: true, transactionId };
  }

  /**
   * Marks a transaction as synced.
   */
  markAsSynced(transactionId: string): SalesResult {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      return { success: false, error: 'Transaction not found' };
    }

    transaction.syncStatus = 'synced';
    transaction.syncedAt = new Date();

    this.emit('transaction.synced', transaction);

    return { success: true, transactionId };
  }

  /**
   * Marks a transaction as failed to sync.
   */
  markSyncFailed(transactionId: string, reason: string): SalesResult {
    const transaction = this.transactions.get(transactionId);
    if (!transaction) {
      return { success: false, error: 'Transaction not found' };
    }

    transaction.syncStatus = 'failed';
    transaction.metadata = {
      ...transaction.metadata,
      syncFailureReason: reason
    };

    this.emit('transaction.sync_failed', transaction);

    return { success: true, transactionId };
  }

  /**
   * Gets pending transactions for sync.
   */
  getPendingTransactions(): SalesTransaction[] {
    return Array.from(this.transactions.values()).filter(
      t => t.syncStatus === 'pending'
    );
  }

  /**
   * Gets transactions for an agent.
   */
  getAgentTransactions(agentId: string, limit: number = 100): SalesTransaction[] {
    return Array.from(this.transactions.values())
      .filter(t => t.agentId === agentId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  /**
   * Gets a transaction by ID.
   */
  getTransaction(transactionId: string): SalesTransaction | null {
    return this.transactions.get(transactionId) || null;
  }

  /**
   * Gets a receipt by ID.
   */
  getReceipt(receiptId: string): Receipt | null {
    return this.receipts.get(receiptId) || null;
  }

  /**
   * Gets daily sales summary for an agent.
   */
  getDailySummary(agentId: string, date: Date = new Date()): {
    totalTransactions: number;
    totalAmount: number;
    completedAmount: number;
    pendingAmount: number;
    failedAmount: number;
    syncedCount: number;
    pendingCount: number;
  } {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const dayTransactions = Array.from(this.transactions.values()).filter(
      t =>
        t.agentId === agentId &&
        t.createdAt >= startOfDay &&
        t.createdAt <= endOfDay
    );

    return {
      totalTransactions: dayTransactions.length,
      totalAmount: dayTransactions.reduce((sum, t) => sum + t.totalAmount, 0),
      completedAmount: dayTransactions
        .filter(t => t.paymentStatus === 'completed')
        .reduce((sum, t) => sum + t.totalAmount, 0),
      pendingAmount: dayTransactions
        .filter(t => t.paymentStatus === 'pending')
        .reduce((sum, t) => sum + t.totalAmount, 0),
      failedAmount: dayTransactions
        .filter(t => t.paymentStatus === 'failed')
        .reduce((sum, t) => sum + t.totalAmount, 0),
      syncedCount: dayTransactions.filter(t => t.syncStatus === 'synced').length,
      pendingCount: dayTransactions.filter(t => t.syncStatus === 'pending').length
    };
  }

  /**
   * Generates a receipt for a transaction.
   */
  private generateReceipt(transaction: SalesTransaction): Receipt {
    const passengers = transaction.seatIds.map((seatId, index) => ({
      name: transaction.passengerNames[index] ?? 'Unknown',
      seatNumber: seatId.split('_').pop() ?? seatId
    }));

    return {
      id: `rcpt_${crypto.randomUUID()}`,
      transactionId: transaction.id,
      agentId: transaction.agentId,
      tripId: transaction.tripId,
      passengers,
      totalAmount: transaction.totalAmount,
      paymentMethod: transaction.paymentMethod,
      issuedAt: new Date()
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
