import { describe, expect, it, vi } from 'vitest'

import { getActivityLogSummary } from '@/lib/data/activity-logs'
import { createSupabaseAdminClient } from '@/lib/supabase/admin'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/admin', () => ({ createSupabaseAdminClient: vi.fn() }))
vi.mock('@/lib/supabase/data-error', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/supabase/data-error')>(),
  requireSupabaseConfigured: () => true,
}))

function mockCounts(counts: { today: number | null; auth: number | null; changes: number | null }) {
  const gte = vi.fn().mockResolvedValue({ count: counts.today })
  const eq = vi.fn().mockResolvedValue({ count: counts.auth })
  const neq = vi.fn().mockResolvedValue({ count: counts.changes })
  const select = vi.fn(() => ({ gte, eq, neq }))
  const from = vi.fn(() => ({ select }))
  vi.mocked(createSupabaseAdminClient).mockReturnValue({ from } as unknown as ReturnType<typeof createSupabaseAdminClient>)
  return { from, select, gte, eq, neq }
}

describe('activity log summary', () => {
  it('uses only the three filtered counts and derives total from category counts', async () => {
    const { from, select, gte, eq, neq } = mockCounts({ today: 3, auth: 8, changes: 11 })

    await expect(getActivityLogSummary()).resolves.toEqual({ total: 19, today: 3, auth: 8, changes: 11 })
    expect(from.mock.calls).toEqual([['activity_logs'], ['activity_logs'], ['activity_logs']])
    expect(select).toHaveBeenCalledTimes(3)
    expect(select).toHaveBeenCalledWith('*', { count: 'exact', head: true })
    expect(gte).toHaveBeenCalledExactlyOnceWith('occurred_at', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/))
    expect(eq).toHaveBeenCalledExactlyOnceWith('category', 'auth')
    expect(neq).toHaveBeenCalledExactlyOnceWith('category', 'auth')
  })
})
