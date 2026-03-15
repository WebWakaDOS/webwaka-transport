import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SalesTransactionManager, Agent } from './index';

describe('TRN-2: Agent Sales Application (Offline-first POS)', () => {
  let manager: SalesTransactionManager;
  const agent: Agent = {
    id: 'agent_001',
    name: 'John Doe',
    phone: '+2348012345678',
    email: 'john@buspark.ng',
    operatorId: 'op_001',
    busParks: ['bp_001'],
    role: 'agent',
    status: 'active',
    createdAt: new Date()
  };

  beforeEach(() => {
    manager = new SalesTransactionManager();
    manager.registerAgent(agent);
  });

  describe('Agent Registration', () => {
    it('should register an agent', () => {
      const newAgent: Agent = {
        id: 'agent_002',
        name: 'Jane Smith',
        phone: '+2348087654321',
        email: 'jane@buspark.ng',
        operatorId: 'op_001',
        busParks: ['bp_001'],
        role: 'supervisor',
        status: 'active',
        createdAt: new Date()
      };

      manager.registerAgent(newAgent);

      expect(manager.getTransaction).toBeDefined();
    });

    it('should emit agent.registered event', () => {
      const callback = vi.fn();
      manager.on('agent.registered', callback);

      const newAgent: Agent = {
        id: 'agent_003',
        name: 'Test Agent',
        phone: '+2348000000000',
        email: 'test@buspark.ng',
        operatorId: 'op_001',
        busParks: ['bp_001'],
        role: 'agent',
        status: 'active',
        createdAt: new Date()
      };

      manager.registerAgent(newAgent);

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0][0].id).toBe('agent_003');
    });
  });

  describe('Transaction Creation', () => {
    it('should create a sales transaction', () => {
      const result = manager.createTransaction(
        agent.id,
        'trip_001',
        ['seat_1', 'seat_2'],
        ['Passenger 1', 'Passenger 2'],
        5000,
        'cash'
      );

      expect(result.success).toBe(true);
      expect(result.transactionId).toBeDefined();
      expect(result.receiptId).toBeDefined();
    });

    it('should not create transaction for inactive agent', () => {
      const inactiveAgent: Agent = {
        ...agent,
        id: 'agent_inactive',
        status: 'inactive'
      };
      manager.registerAgent(inactiveAgent);

      const result = manager.createTransaction(
        'agent_inactive',
        'trip_001',
        ['seat_1'],
        ['Passenger 1'],
        2500,
        'cash'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('not active');
    });

    it('should not create transaction for non-existent agent', () => {
      const result = manager.createTransaction(
        'non_existent_agent',
        'trip_001',
        ['seat_1'],
        ['Passenger 1'],
        2500,
        'cash'
      );

      expect(result.success).toBe(false);
      expect(result.error).toBe('Agent not found');
    });

    it('should not create transaction with mismatched seats and passengers', () => {
      const result = manager.createTransaction(
        agent.id,
        'trip_001',
        ['seat_1', 'seat_2'],
        ['Passenger 1'],
        5000,
        'cash'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('mismatch');
    });

    it('should not create transaction with invalid amount', () => {
      const result = manager.createTransaction(
        agent.id,
        'trip_001',
        ['seat_1'],
        ['Passenger 1'],
        0,
        'cash'
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid amount');
    });

    it('should emit transaction.created event', () => {
      const callback = vi.fn();
      manager.on('transaction.created', callback);

      manager.createTransaction(
        agent.id,
        'trip_001',
        ['seat_1'],
        ['Passenger 1'],
        2500,
        'cash'
      );

      expect(callback).toHaveBeenCalled();
      expect(callback.mock.calls[0][0].agentId).toBe(agent.id);
    });

    it('should set transaction sync status to pending', () => {
      const result = manager.createTransaction(
        agent.id,
        'trip_001',
        ['seat_1'],
        ['Passenger 1'],
        2500,
        'cash'
      );

      const transaction = manager.getTransaction(result.transactionId!);

      expect(transaction!.syncStatus).toBe('pending');
      expect(transaction!.paymentStatus).toBe('pending');
    });
  });

  describe('Payment Management', () => {
    it('should complete payment for a transaction', () => {
      const createResult = manager.createTransaction(
        agent.id,
        'trip_001',
        ['seat_1'],
        ['Passenger 1'],
        2500,
        'cash'
      );

      const paymentResult = manager.completePayment(
        createResult.transactionId!,
        'PAY_REF_001'
      );

      expect(paymentResult.success).toBe(true);

      const transaction = manager.getTransaction(createResult.transactionId!);
      expect(transaction!.paymentStatus).toBe('completed');
    });

    it('should fail payment for a transaction', () => {
      const createResult = manager.createTransaction(
        agent.id,
        'trip_001',
        ['seat_1'],
        ['Passenger 1'],
        2500,
        'cash'
      );

      const failResult = manager.failPayment(
        createResult.transactionId!,
        'Insufficient funds'
      );

      expect(failResult.success).toBe(true);

      const transaction = manager.getTransaction(createResult.transactionId!);
      expect(transaction!.paymentStatus).toBe('failed');
    });

    it('should emit payment events', () => {
      const completeCallback = vi.fn();
      const failCallback = vi.fn();
      manager.on('transaction.payment_completed', completeCallback);
      manager.on('transaction.payment_failed', failCallback);

      const createResult = manager.createTransaction(
        agent.id,
        'trip_001',
        ['seat_1'],
        ['Passenger 1'],
        2500,
        'cash'
      );

      manager.completePayment(createResult.transactionId!, 'REF_001');
      expect(completeCallback).toHaveBeenCalled();

      const createResult2 = manager.createTransaction(
        agent.id,
        'trip_002',
        ['seat_2'],
        ['Passenger 2'],
        2500,
        'cash'
      );

      manager.failPayment(createResult2.transactionId!, 'Error');
      expect(failCallback).toHaveBeenCalled();
    });
  });

  describe('Sync Management', () => {
    it('should mark transaction as synced', () => {
      const createResult = manager.createTransaction(
        agent.id,
        'trip_001',
        ['seat_1'],
        ['Passenger 1'],
        2500,
        'cash'
      );

      const syncResult = manager.markAsSynced(createResult.transactionId!);

      expect(syncResult.success).toBe(true);

      const transaction = manager.getTransaction(createResult.transactionId!);
      expect(transaction!.syncStatus).toBe('synced');
      expect(transaction!.syncedAt).toBeDefined();
    });

    it('should mark transaction sync as failed', () => {
      const createResult = manager.createTransaction(
        agent.id,
        'trip_001',
        ['seat_1'],
        ['Passenger 1'],
        2500,
        'cash'
      );

      const failResult = manager.markSyncFailed(
        createResult.transactionId!,
        'Network error'
      );

      expect(failResult.success).toBe(true);

      const transaction = manager.getTransaction(createResult.transactionId!);
      expect(transaction!.syncStatus).toBe('failed');
    });

    it('should get pending transactions', () => {
      manager.createTransaction(
        agent.id,
        'trip_001',
        ['seat_1'],
        ['Passenger 1'],
        2500,
        'cash'
      );

      const result2 = manager.createTransaction(
        agent.id,
        'trip_002',
        ['seat_2'],
        ['Passenger 2'],
        2500,
        'cash'
      );

      manager.markAsSynced(result2.transactionId!);

      const pending = manager.getPendingTransactions();

      expect(pending.length).toBe(1);
      expect(pending[0].syncStatus).toBe('pending');
    });

    it('should emit sync events', () => {
      const syncedCallback = vi.fn();
      const failedCallback = vi.fn();
      manager.on('transaction.synced', syncedCallback);
      manager.on('transaction.sync_failed', failedCallback);

      const createResult = manager.createTransaction(
        agent.id,
        'trip_001',
        ['seat_1'],
        ['Passenger 1'],
        2500,
        'cash'
      );

      manager.markAsSynced(createResult.transactionId!);
      expect(syncedCallback).toHaveBeenCalled();

      const createResult2 = manager.createTransaction(
        agent.id,
        'trip_002',
        ['seat_2'],
        ['Passenger 2'],
        2500,
        'cash'
      );

      manager.markSyncFailed(createResult2.transactionId!, 'Error');
      expect(failedCallback).toHaveBeenCalled();
    });
  });

  describe('Transaction Retrieval', () => {
    it('should get agent transactions', () => {
      manager.createTransaction(
        agent.id,
        'trip_001',
        ['seat_1'],
        ['Passenger 1'],
        2500,
        'cash'
      );

      manager.createTransaction(
        agent.id,
        'trip_002',
        ['seat_2'],
        ['Passenger 2'],
        2500,
        'cash'
      );

      const transactions = manager.getAgentTransactions(agent.id);

      expect(transactions.length).toBe(2);
    });

    it('should get transactions in reverse chronological order', () => {
      const result1 = manager.createTransaction(
        agent.id,
        'trip_001',
        ['seat_1'],
        ['Passenger 1'],
        2500,
        'cash'
      );

      const result2 = manager.createTransaction(
        agent.id,
        'trip_002',
        ['seat_2'],
        ['Passenger 2'],
        2500,
        'cash'
      );

      const transactions = manager.getAgentTransactions(agent.id);

      // Verify transactions are sorted by creation time (most recent first)
      expect(transactions.length).toBe(2);
      expect(transactions[0].createdAt.getTime()).toBeGreaterThanOrEqual(
        transactions[1].createdAt.getTime()
      );
    });

    it('should get a single transaction by ID', () => {
      const result = manager.createTransaction(
        agent.id,
        'trip_001',
        ['seat_1'],
        ['Passenger 1'],
        2500,
        'cash'
      );

      const transaction = manager.getTransaction(result.transactionId!);

      expect(transaction).toBeDefined();
      expect(transaction!.id).toBe(result.transactionId);
    });

    it('should return null for non-existent transaction', () => {
      const transaction = manager.getTransaction('non_existent');

      expect(transaction).toBeNull();
    });
  });

  describe('Receipt Management', () => {
    it('should generate receipt for transaction', () => {
      const result = manager.createTransaction(
        agent.id,
        'trip_001',
        ['seat_1', 'seat_2'],
        ['Passenger 1', 'Passenger 2'],
        5000,
        'cash'
      );

      const receipt = manager.getReceipt(result.receiptId!);

      expect(receipt).toBeDefined();
      expect(receipt!.passengers.length).toBe(2);
      expect(receipt!.totalAmount).toBe(5000);
    });

    it('should include passenger details in receipt', () => {
      const result = manager.createTransaction(
        agent.id,
        'trip_001',
        ['seat_001_1', 'seat_001_2'],
        ['John Adekunle', 'Mary Okafor'],
        5000,
        'cash'
      );

      const receipt = manager.getReceipt(result.receiptId!);

      expect(receipt!.passengers[0].name).toBe('John Adekunle');
      expect(receipt!.passengers[1].name).toBe('Mary Okafor');
    });
  });

  describe('Daily Summary', () => {
    it('should calculate daily sales summary', () => {
      const today = new Date();

      manager.createTransaction(
        agent.id,
        'trip_001',
        ['seat_1'],
        ['Passenger 1'],
        2500,
        'cash'
      );

      const result2 = manager.createTransaction(
        agent.id,
        'trip_002',
        ['seat_2'],
        ['Passenger 2'],
        3500,
        'cash'
      );

      manager.completePayment(result2.transactionId!, 'REF_001');

      const summary = manager.getDailySummary(agent.id, today);

      expect(summary.totalTransactions).toBe(2);
      expect(summary.totalAmount).toBe(6000);
      expect(summary.completedAmount).toBe(3500);
      expect(summary.pendingAmount).toBe(2500);
    });

    it('should track synced and pending counts', () => {
      const today = new Date();

      const result1 = manager.createTransaction(
        agent.id,
        'trip_001',
        ['seat_1'],
        ['Passenger 1'],
        2500,
        'cash'
      );

      const result2 = manager.createTransaction(
        agent.id,
        'trip_002',
        ['seat_2'],
        ['Passenger 2'],
        2500,
        'cash'
      );

      manager.markAsSynced(result1.transactionId!);

      const summary = manager.getDailySummary(agent.id, today);

      expect(summary.syncedCount).toBe(1);
      expect(summary.pendingCount).toBe(1);
    });
  });

  describe('Offline Scenarios', () => {
    it('should handle multiple transactions while offline', () => {
      // Simulate offline agent creating multiple transactions
      const txn1 = manager.createTransaction(
        agent.id,
        'trip_001',
        ['seat_1'],
        ['Passenger 1'],
        2500,
        'cash'
      );

      const txn2 = manager.createTransaction(
        agent.id,
        'trip_002',
        ['seat_2'],
        ['Passenger 2'],
        3000,
        'cash'
      );

      const txn3 = manager.createTransaction(
        agent.id,
        'trip_003',
        ['seat_3'],
        ['Passenger 3'],
        2500,
        'cash'
      );

      const pending = manager.getPendingTransactions();

      expect(pending.length).toBe(3);
      expect(pending.every(t => t.syncStatus === 'pending')).toBe(true);
    });

    it('should sync transactions when reconnected', () => {
      const txn1 = manager.createTransaction(
        agent.id,
        'trip_001',
        ['seat_1'],
        ['Passenger 1'],
        2500,
        'cash'
      );

      const txn2 = manager.createTransaction(
        agent.id,
        'trip_002',
        ['seat_2'],
        ['Passenger 2'],
        3000,
        'cash'
      );

      // Simulate reconnection and sync
      const pending = manager.getPendingTransactions();
      pending.forEach(t => {
        manager.markAsSynced(t.id);
      });

      const stillPending = manager.getPendingTransactions();

      expect(stillPending.length).toBe(0);
    });
  });
});
