import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createAccountAction, toggleAccountActiveAction, updateAccountAction } from '@/app/actions/accounts'
import { AccountDetailsPage } from '@/components/accounts/AccountDetailsPage'
import { AccountsPageClient } from '@/components/accounts/AccountsPageClient'
import { mockAccounts } from '@/lib/mock/accounts'
import type { Account } from '@/types/account'

const { router, searchParams } = vi.hoisted(() => ({
  router: { refresh: vi.fn(), push: vi.fn(), replace: vi.fn() },
  searchParams: new URLSearchParams(),
}))
vi.mock('next/navigation', () => ({
  useRouter: () => router,
  usePathname: () => '/accounts',
  useSearchParams: () => searchParams,
}))
vi.mock('@/app/actions/accounts', () => ({
  createAccountAction: vi.fn(), deleteAccountAction: vi.fn(), toggleAccountActiveAction: vi.fn(),
  updateAccountAction: vi.fn(), updateAccountSitesAction: vi.fn(),
}))
vi.mock('@/app/actions/sites', () => ({ createSiteAction: vi.fn(), updateSiteAction: vi.fn() }))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const account: Account = { ...mockAccounts[0], id: 'account-1', identifier: 'initial@example.com', sites: [], isActive: true }
const nextAccount: Account = { ...account, id: 'account-2', identifier: 'next@example.com' }

function page(items = [account], selectedPage = 1) {
  return (
    <AccountsPageClient
      initialFilters={{ keyword: '', emailProvider: 'all', site: 'all', isActive: 'all' }}
      paginatedAccounts={{ items, page: selectedPage, pageSize: 10, total: items.length, totalPages: 1 }}
      sites={[]}
      usedSites={[]}
      emailIdentifiers={[]}
    />
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })))
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('account forms', () => {
  it('only refreshes after a successful list save, not on cancel, and restores opener focus', async () => {
    const user = userEvent.setup()
    vi.mocked(createAccountAction).mockResolvedValue({ success: true, data: nextAccount })
    render(page())
    const opener = screen.getByRole('button', { name: '添加账号' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()

    await user.click(opener)
    const first = await screen.findByRole('dialog', { name: '添加账号' })
    await user.type(within(first).getByLabelText('账号标识'), 'abandoned@example.com')
    await user.click(within(first).getByRole('button', { name: '取消' }))
    await waitFor(() => expect(opener).toHaveFocus())
    expect(router.refresh).not.toHaveBeenCalled()

    await user.click(opener)
    const second = await screen.findByRole('dialog', { name: '添加账号' })
    const identifier = within(second).getByLabelText('账号标识')
    expect(identifier).toHaveValue('')
    await user.type(identifier, nextAccount.identifier)
    await user.click(within(second).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1))
    expect(createAccountAction).toHaveBeenCalledWith(expect.objectContaining({ identifier: nextAccount.identifier }))
  })

  it('prefills the first details edit and refreshes on save but not Escape', async () => {
    const user = userEvent.setup()
    vi.mocked(updateAccountAction).mockResolvedValue({ success: true, data: undefined })
    render(<AccountDetailsPage account={account} sites={[]} emailIdentifiers={[]} />)
    const opener = screen.getByRole('button', { name: '编辑' })

    await user.click(opener)
    const first = await screen.findByRole('dialog', { name: '编辑账号' })
    expect(within(first).getByLabelText('账号标识')).toHaveValue(account.identifier)
    await user.keyboard('{Escape}')
    await waitFor(() => expect(opener).toHaveFocus())
    expect(router.refresh).not.toHaveBeenCalled()

    await user.click(opener)
    const second = await screen.findByRole('dialog', { name: '编辑账号' })
    await user.click(within(second).getByRole('button', { name: '保存' }))
    await waitFor(() => expect(router.refresh).toHaveBeenCalledTimes(1))
    expect(updateAccountAction).toHaveBeenCalledWith(account.id, expect.objectContaining({ identifier: account.identifier }))
  })
})

describe('account list', () => {
  it('guards consecutive toggles and rolls back to the last displayed status on failure', async () => {
    const user = userEvent.setup()
    const request = Promise.withResolvers<void>()
    vi.mocked(toggleAccountActiveAction).mockResolvedValueOnce(undefined).mockReturnValueOnce(request.promise)
    const { rerender } = render(page())
    const toggle = screen.getByRole('switch')

    await user.click(toggle)
    await waitFor(() => expect(toggle).not.toBeDisabled())
    expect(toggle).not.toBeChecked()

    await user.click(toggle)
    expect(toggle).toBeChecked()
    expect(toggle).toBeDisabled()
    await user.click(toggle)
    expect(toggleAccountActiveAction).toHaveBeenCalledTimes(2)

    await act(async () => request.reject(new Error('write failed')))
    expect(toggle).not.toBeChecked()
    expect(toggle).not.toBeDisabled()

    rerender(page([{ ...account }]))
    expect(screen.getByRole('switch')).toBeChecked()
    rerender(page([nextAccount], 2))
    expect(screen.queryByText(account.identifier)).not.toBeInTheDocument()
    expect(screen.getByText(nextAccount.identifier)).toBeInTheDocument()
  })
})
