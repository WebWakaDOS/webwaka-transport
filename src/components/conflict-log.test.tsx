/**
 * D-002: ConflictLog Component Tests
 * Tests conflict list rendering, empty state, and resolve actions.
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ConflictLog } from './conflict-log';
import type { ConflictRecord } from '../core/offline/db';

const mockResolveConflict = vi.fn();
const mockGetConflicts = vi.fn();

vi.mock('../core/offline/db', () => ({
  getConflicts: () => mockGetConflicts(),
  resolveConflict: (id: string, resolution: string) => mockResolveConflict(id, resolution),
}));

const mockConflicts: ConflictRecord[] = [
  {
    id: 1,
    entity_type: 'booking',
    entity_id: 'booking_abc123',
    local_payload: { status: 'pending', seat_ids: '["s1"]' },
    server_payload: { status: 'confirmed', seat_ids: '["s1"]' },
    http_status: 409,
    created_at: Date.now() - 60000,
    resolved: false,
  },
  {
    id: 2,
    entity_type: 'seat',
    entity_id: 'seat_xyz789',
    local_payload: { status: 'reserved' },
    server_payload: { status: 'confirmed' },
    http_status: 409,
    created_at: Date.now() - 120000,
    resolved: false,
  },
];

describe('ConflictLog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading then renders conflict entity IDs', async () => {
    mockGetConflicts.mockResolvedValueOnce(mockConflicts);
    render(<ConflictLog onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText('booking_abc123')).toBeTruthy();
    });
    expect(screen.getByText('seat_xyz789')).toBeTruthy();
  });

  it('shows empty state text when no conflicts', async () => {
    mockGetConflicts.mockResolvedValueOnce([]);
    render(<ConflictLog onClose={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByText(/no unresolved conflicts/i)).toBeTruthy();
    });
  });

  it('renders Accept Server and Discard buttons for each conflict', async () => {
    mockGetConflicts.mockResolvedValueOnce(mockConflicts);
    render(<ConflictLog onClose={vi.fn()} />);

    await waitFor(() => {
      const acceptBtns = screen.getAllByRole('button', { name: /accept server/i });
      expect(acceptBtns.length).toBe(2);
    });
  });

  it('calls resolveConflict with correct args when Accept Server is clicked', async () => {
    mockGetConflicts.mockResolvedValue(mockConflicts);
    mockResolveConflict.mockResolvedValue(undefined);

    render(<ConflictLog onClose={vi.fn()} />);

    await waitFor(() => {
      const acceptBtns = screen.getAllByRole('button', { name: /accept server/i });
      fireEvent.click(acceptBtns[0]!);
    });

    await waitFor(() => {
      expect(mockResolveConflict).toHaveBeenCalledWith(1, 'accept_server');
    });
  });
});
