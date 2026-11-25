import { isEmail } from '@/lib/utils/email'
import type { Account } from '@/types/account'

export type AccountLookup = {
  nonEmailAccountIds: Set<string>
  accountEmailsById: Map<string, string>
  accountIdentifierById: Map<string, string>
}

export function buildAccountLookup(accounts: Account[]): AccountLookup {
  const nonEmailAccountIds = new Set<string>()
  const accountEmailsById = new Map<string, string>()
  const accountIdentifierById = new Map<string, string>()

  for (const a of accounts) {
    accountIdentifierById.set(a.id, a.identifier)
    if (!isEmail(a.identifier)) {
      nonEmailAccountIds.add(a.id)
      if (a.email) accountEmailsById.set(a.id, a.email)
    }
  }

  return { nonEmailAccountIds, accountEmailsById, accountIdentifierById }
}

export function resolveAccountDisplay(accountId: string | null, lookup: AccountLookup) {
  if (!accountId) return { name: '未设置', highlight: false, tooltip: undefined }
  const { nonEmailAccountIds, accountEmailsById, accountIdentifierById } = lookup
  const name = accountIdentifierById.get(accountId) ?? '未知账号'
  const highlight = nonEmailAccountIds.has(accountId)
  const email = accountEmailsById.get(accountId)
  const tooltip = email ? `绑定邮箱：${email}` : undefined
  return { name, highlight, tooltip }
}
