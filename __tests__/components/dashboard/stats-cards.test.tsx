import { cleanup, render, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { DomainStatsCards } from '@/components/dashboard/StatsCards'

afterEach(() => {
  cleanup()
})

const STATISTICS = { total: 12, expiring: 3, expired: 1, newThisWeek: 2 }

function getCard(container: HTMLElement, label: string) {
  return within(container).getByText(label).closest('[data-slot="card"]') as HTMLElement
}

function renderCards() {
  const utils = render(<DomainStatsCards statistics={STATISTICS} />)

  return { ...utils, card: (label: string) => getCard(utils.container, label) }
}

describe('DomainStatsCards', () => {
  it('links the expiring and expired cards to the domain list filtered by status', () => {
    const { card } = renderCards()

    expect(card('即将到期').closest('a')).toHaveAttribute('href', '/domains?status=expiring')
    expect(card('已过期').closest('a')).toHaveAttribute('href', '/domains?status=expired')
  })

  it('keeps the other cards as plain cards', () => {
    const { card } = renderCards()

    expect(card('总域名数').closest('a')).toBeNull()
    expect(card('本周新增').closest('a')).toBeNull()
  })
})
