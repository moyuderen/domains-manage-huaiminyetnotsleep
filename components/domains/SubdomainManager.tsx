'use client'

import dynamic from 'next/dynamic'
import { useState } from 'react'

import { deleteSubdomainAction } from '@/app/actions/subdomains'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { toast } from 'sonner'
import { SubdomainCardList } from '@/components/domains/SubdomainCardList'
import { SubdomainsTable } from '@/components/domains/SubdomainsTable'
import type { Domain, Subdomain } from '@/types/domain'
import { useFormDialog } from '@/hooks/useFormDialog'

const SubdomainFormDialog = dynamic(() => import('@/components/domains/SubdomainFormDialog').then((module) => module.SubdomainFormDialog), { ssr: false })

export function SubdomainManager({ domain, addIcon }: { domain: Domain; addIcon?: React.ReactNode }) {
  const [editingSubdomain, setEditingSubdomain] = useState<Subdomain | null>(null)
  const [deletingSubdomain, setDeletingSubdomain] = useState<Subdomain | null>(null)
  const subdomainDialog = useFormDialog()
  const [loading, setLoading] = useState(false)

  return (
    <>
      <Card>
        <div className="flex items-center justify-between border-b px-6 py-4">
          <div>
            <h2 className="text-lg font-semibold text-foreground">子域名信息</h2>
            <p className="mt-1 text-sm text-muted-foreground">管理当前域名下的子域名、对应 IP、用途说明和备注。</p>
          </div>
          <Button onClick={() => { setEditingSubdomain(null); subdomainDialog.show() }}>{addIcon}新增子域名</Button>
        </div>
        <div className="p-6">
          <div className="hidden md:block">
            <SubdomainsTable
              domainName={domain.name}
              subdomains={domain.subdomains}
              onEdit={(subdomain) => { setEditingSubdomain(subdomain); subdomainDialog.show() }}
              onDelete={setDeletingSubdomain}
            />
          </div>
          <div className="md:hidden">
            <SubdomainCardList
              domainName={domain.name}
              subdomains={domain.subdomains}
              onEdit={(subdomain) => { setEditingSubdomain(subdomain); subdomainDialog.show() }}
              onDelete={setDeletingSubdomain}
            />
          </div>
        </div>
      </Card>

      {subdomainDialog.hasOpened && (
        <SubdomainFormDialog
          open={subdomainDialog.open}
          onCloseAutoFocus={subdomainDialog.onCloseAutoFocus}
          domainId={domain.id}
          initialValue={editingSubdomain}
          onClose={() => {
            subdomainDialog.hide()
            setEditingSubdomain(null)
          }}
        />
      )}

      <ConfirmDialog
        open={Boolean(deletingSubdomain)}
        title="删除子域名"
        description={`确认删除 ${deletingSubdomain?.subdomain ?? ''}.${domain.name} 吗？`}
        onClose={() => setDeletingSubdomain(null)}
        onConfirm={async () => {
          if (!deletingSubdomain) return
          setLoading(true)
          try {
            await deleteSubdomainAction(domain.id, deletingSubdomain.id)
            setDeletingSubdomain(null)
            toast.success('子域名删除成功')
          } catch (error) {
            toast.error(error instanceof Error ? error.message : '删除失败')
          } finally {
            setLoading(false)
          }
        }}
        loading={loading}
      />
    </>
  )
}
