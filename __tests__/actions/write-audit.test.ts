import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { revalidatePath } from 'next/cache'

import { deleteAccountAction, updateAccountAction } from '@/app/actions/accounts'
import { deleteDomainAction, deleteDomainsAction, updateDomainAction } from '@/app/actions/domains'
import { getActivityLogChanges } from '@/lib/activity-log-detail'
import { deleteAccount, ensureAccountSiteRelations, getAccountById, getAccountsByIds, updateAccount } from '@/lib/data/accounts'
import { deleteDomain, deleteDomains, getDomainById, getDomainsByIds, updateDomain } from '@/lib/data/domains'
import { getSitesByIds } from '@/lib/data/sites'
import { tryEmitEvent } from '@/lib/events'
import { mockAccounts } from '@/lib/mock/accounts'
import { mockDomains } from '@/lib/mock/domains'
import { mockSites } from '@/lib/mock/sites'
import { defaultAccountValues } from '@/schemas/accountSchemas'
import { defaultDomainValues } from '@/schemas/domainSchemas'

const { deferred } = vi.hoisted(() => ({ deferred: [] as (() => unknown)[] }))

vi.mock('server-only', () => ({}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn(), updateTag: vi.fn() }))
vi.mock('next/headers', () => ({ headers: async () => new Headers() }))
vi.mock('next/server', () => ({ after: (callback: () => unknown) => { deferred.push(callback) } }))
vi.mock('@/lib/auth/access-server', () => ({ requireAccess: vi.fn() }))
vi.mock('@/lib/data/accounts', () => ({
  deleteAccount: vi.fn(), ensureAccountSiteRelations: vi.fn(), getAccountById: vi.fn(),
  getAccountsByIds: vi.fn(), updateAccount: vi.fn(),
}))
vi.mock('@/lib/data/domains', () => ({
  deleteDomain: vi.fn(), deleteDomains: vi.fn(), getDomainById: vi.fn(),
  getDomainsByIds: vi.fn(), updateDomain: vi.fn(),
}))
vi.mock('@/lib/data/sites', () => ({ getSitesByIds: vi.fn() }))
vi.mock('@/lib/events', () => ({ tryEmitEvent: vi.fn() }))

const oldDomain = {
  ...mockDomains[0],
  name: 'previous.example.com',
  registrarAccountId: 'account-previous',
  registrarSiteId: 'site-previous',
  dnsAccountId: null,
  dnsSiteId: null,
}
const oldAccount = {
  ...mockAccounts[0],
  id: 'account-previous',
  identifier: 'previous@example.com',
  sites: [{ site: 'site-previous', note: '', isActive: true }],
}
const newSite = { ...mockSites[0], id: 'site-next', name: 'Next Site' }

async function flushAudit() {
  expect(deferred).toHaveLength(1)
  await deferred.shift()?.()
  const event = vi.mocked(tryEmitEvent).mock.lastCall?.[0]
  expect(event).toBeDefined()
  return event
}

describe('deferred write audit', () => {
  beforeEach(() => {
    deferred.length = 0
    vi.resetAllMocks()
    vi.mocked(getDomainById).mockResolvedValue(oldDomain)
    vi.mocked(getDomainsByIds).mockResolvedValue([oldDomain])
    vi.mocked(getAccountById).mockResolvedValue(oldAccount)
    vi.mocked(getSitesByIds).mockResolvedValue([newSite])
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('keeps the domain snapshot, relationship update and revalidation before deferred lookups', async () => {
    const error = new Error('account lookup unavailable')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(getAccountsByIds).mockRejectedValue(error)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T23:59:59Z'))

    await updateDomainAction(oldDomain.id, {
      ...defaultDomainValues,
      name: 'NEXT.EXAMPLE.COM',
      registrarAccountId: 'account-next',
      registrarSiteId: newSite.id,
    })

    expect(getDomainById).toHaveBeenCalledBefore(vi.mocked(updateDomain))
    expect(updateDomain).toHaveBeenCalledBefore(vi.mocked(ensureAccountSiteRelations))
    expect(ensureAccountSiteRelations).toHaveBeenCalledWith(expect.arrayContaining([{ accountId: 'account-next', siteId: newSite.id }]))
    expect(revalidatePath).toHaveBeenCalledWith('/accounts/account-previous')
    expect(revalidatePath).toHaveBeenCalledWith('/accounts/account-next')
    expect(getAccountsByIds).not.toHaveBeenCalled()
    expect(getSitesByIds).not.toHaveBeenCalled()
    expect(tryEmitEvent).not.toHaveBeenCalled()

    vi.setSystemTime(new Date('2026-01-02T00:00:01Z'))
    const event = await flushAudit()
    expect(event).toMatchObject({ action: 'update', resourceName: 'next.example.com', occurredAt: '2026-01-01T23:59:59.000Z' })
    expect(getActivityLogChanges(event?.detail ?? {})).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'name', before: 'previous.example.com', after: 'next.example.com' }),
      expect.objectContaining({ field: 'registrarAccountId', displayBefore: 'account-previous', displayAfter: 'account-next' }),
      expect.objectContaining({ field: 'registrarSiteId', displayBefore: 'site-previous', displayAfter: 'Next Site' }),
    ]))
    expect(log).toHaveBeenCalledWith(expect.any(String), error)
  })

  it('saves the account and emits old/new site IDs even when name lookup fails', async () => {
    const error = new Error('site lookup unavailable')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(getSitesByIds).mockRejectedValue(error)

    const response = await updateAccountAction(oldAccount.id, {
      ...defaultAccountValues,
      identifier: 'next@example.com',
      sites: [{ site: newSite.id, note: '', isActive: true }],
    })

    expect(response.success).toBe(true)
    expect(getAccountById).toHaveBeenCalledBefore(vi.mocked(updateAccount))
    expect(getSitesByIds).not.toHaveBeenCalled()
    const event = await flushAudit()
    expect(getSitesByIds).toHaveBeenCalledWith([newSite.id, 'site-previous'])
    expect(getActivityLogChanges(event?.detail ?? {})).toEqual(expect.arrayContaining([
      expect.objectContaining({ field: 'sites', displayBefore: 'site-previous', displayAfter: newSite.id }),
    ]))
    expect(log).toHaveBeenCalledWith(expect.any(String), error)
  })

  it('retains the pre-delete account name instead of looking it up after deletion', async () => {
    await deleteAccountAction(oldAccount.id)
    expect(getAccountById).toHaveBeenCalledExactlyOnceWith(oldAccount.id)
    expect(getAccountById).toHaveBeenCalledBefore(vi.mocked(deleteAccount))
    expect(await flushAudit()).toMatchObject({ action: 'delete', resourceName: oldAccount.identifier })
  })

  it.each([false, true])('uses domain pre-delete snapshots for audit and revalidation (batch=%s)', async (batch) => {
    if (batch) {
      await deleteDomainsAction([oldDomain.id])
      expect(getDomainsByIds).toHaveBeenCalledBefore(vi.mocked(deleteDomains))
    } else {
      await deleteDomainAction(oldDomain.id)
      expect(getDomainById).toHaveBeenCalledBefore(vi.mocked(deleteDomain))
    }
    expect(revalidatePath).toHaveBeenCalledWith('/accounts/account-previous')
    expect(await flushAudit()).toMatchObject({ action: 'delete', resourceName: oldDomain.name })
  })
})
