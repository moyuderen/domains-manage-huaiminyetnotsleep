'use client'

import dynamic from 'next/dynamic'
import { zodResolver } from '@hookform/resolvers/zod'
import { PlusIcon, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Controller, useForm } from 'react-hook-form'

import { createAccountAction, updateAccountAction } from '@/app/actions/accounts'
import { SearchableSelect } from '@/components/searchable-select'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { dedupeById } from '@/lib/utils'
import { isEmail } from '@/lib/utils/email'
import { accountSchema, defaultAccountValues } from '@/schemas/accountSchemas'
import { EMAIL_PROVIDER_LABELS, type Account, type AccountFormValues, type EmailProvider, type SiteEntry } from '@/types/account'
import type { Site } from '@/types/site'
import { Badge } from '@/components/ui/badge'
import { toast } from 'sonner'
import { useFormDialog } from '@/hooks/useFormDialog'

const SiteFormDialog = dynamic(() => import('@/components/sites/SiteFormDialog').then((module) => module.SiteFormDialog), { ssr: false })

const EMAIL_PROVIDER_OPTIONS = Object.entries(EMAIL_PROVIDER_LABELS) as [EmailProvider, string][]

type AccountFormDialogProps = {
  open: boolean
  initialValue?: Account | null
  sites: Site[]
  emailIdentifiers: string[]
  nested?: boolean
  onCloseAutoFocus: (event: Event) => void
  onClose: (result?: { saved: true; createdAccount?: Account }) => void
}

function getAccountFormValues(initialValue?: Account | null): AccountFormValues {
  if (!initialValue) return defaultAccountValues

  return {
    identifier: initialValue.identifier,
    email: initialValue.email,
    emailProvider: initialValue.emailProvider,
    emailProviderDetail: initialValue.emailProviderDetail,
    sites: initialValue.sites,
    passwordHint: initialValue.passwordHint,
    vaultLocation: initialValue.vaultLocation,
    description: initialValue.description,
    isActive: initialValue.isActive,
  }
}

export function AccountFormDialog({ open, initialValue, sites, emailIdentifiers, nested, onClose, onCloseAutoFocus }: AccountFormDialogProps) {
  const [loading, setLoading] = useState(false)
  const siteDialog = useFormDialog()
  const [createdSites, setCreatedSites] = useState<Site[]>([])
  const emailDialog = useFormDialog()
  const [createdEmailIdentifiers, setCreatedEmailIdentifiers] = useState<string[]>([])
  const form = useForm<AccountFormValues>({
    resolver: zodResolver(accountSchema),
    defaultValues: getAccountFormValues(initialValue),
  })

  useEffect(() => {
    if (!open) return

    setCreatedSites([])
    setCreatedEmailIdentifiers([])

    form.reset(getAccountFormValues(initialValue))
  }, [form, initialValue, open])

  const { register, handleSubmit, control, watch, formState: { errors } } = form
  const identifier = watch('identifier') ?? ''
  const emailProvider = watch('emailProvider')
  const accountSites = watch('sites') ?? []
  const identifierIsEmail = identifier.length > 0 && isEmail(identifier)

  const allSites = useMemo(
    () => dedupeById([...sites, ...createdSites]).sort((a, b) => a.name.localeCompare(b.name)),
    [sites, createdSites],
  )
  const allEmailIdentifiers = useMemo(
    () => [...new Set([...emailIdentifiers, ...createdEmailIdentifiers])].sort(),
    [emailIdentifiers, createdEmailIdentifiers],
  )
  const siteIds = accountSites.map((s) => s.site)
  const siteNamesById = useMemo(() => new Map(allSites.map((site) => [site.id, site.name])), [allSites])

  const addSite = (siteId: string) => {
    const trimmed = siteId.trim()
    if (!trimmed || siteIds.includes(trimmed)) return
    const entry: SiteEntry = { site: trimmed, note: '', isActive: true }
    form.setValue('sites', [...accountSites, entry], { shouldValidate: true })
  }

  const removeSite = (siteId: string) => {
    form.setValue('sites', accountSites.filter((s) => s.site !== siteId), { shouldValidate: true })
  }

  const submit = async (values: AccountFormValues) => {
    setLoading(true)
    const email = isEmail(values.identifier) ? values.identifier : values.email
    const finalValues = { ...values, email }

    if (initialValue) {
      const result = await updateAccountAction(initialValue.id, finalValues)
      if (result.success) {
        toast.success('账号更新成功')
        onClose({ saved: true })
      } else {
        toast.error(result.error)
      }
    } else {
      const result = await createAccountAction(finalValues)
      if (result.success) {
        toast.success('账号添加成功')
        onClose({ saved: true, createdAccount: result.data })
      } else {
        toast.error(result.error)
      }
    }

    setLoading(false)
  }

  return (
    <>
    <Dialog open={open} onOpenChange={(nextOpen) => { if (!nextOpen) onClose() }}>
      <DialogContent disableOutsideClose onCloseAutoFocus={onCloseAutoFocus} className="flex max-h-[calc(100vh-2rem)] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{initialValue ? '编辑账号' : '添加账号'}</DialogTitle>
          <DialogDescription>维护可复用账号的基础信息和密码辅助信息。</DialogDescription>
        </DialogHeader>
        <form className="mt-2 flex min-h-0 flex-1 flex-col gap-6 overflow-hidden" onSubmit={handleSubmit(submit)}>
          <FieldGroup className="form-scrollbar min-h-0 flex-1 gap-4 overflow-y-auto px-1">
            <Field data-invalid={Boolean(errors.identifier) || undefined}>
              <FieldLabel htmlFor="account-identifier">账号标识</FieldLabel>
              <Input id="account-identifier" {...register('identifier')} placeholder="ops@gmail.com 或用户名" aria-invalid={Boolean(errors.identifier)} />
              <FieldError>{errors.identifier?.message}</FieldError>
            </Field>

            {identifierIsEmail ? (
              <Field>
                <FieldLabel>绑定邮箱</FieldLabel>
                <p className="text-sm text-muted-foreground">邮箱类型账号默认使用账号标识作为邮箱</p>
              </Field>
            ) : (
              <Field data-invalid={Boolean(errors.email) || undefined}>
                <FieldLabel>绑定邮箱（可选）</FieldLabel>
                <div className="flex">
                  <div className="flex-1">
                    <Controller
                      control={control}
                      name="email"
                      render={({ field }) => (
                        <SearchableSelect
                          value={field.value}
                          onValueChange={field.onChange}
                          placeholder="选择关联的邮箱账号"
                          searchPlaceholder="搜索邮箱账号..."
                          className={nested ? 'w-full' : 'w-full rounded-r-none'}
                          aria-invalid={Boolean(errors.email)}
                          options={allEmailIdentifiers.map((emailId) => ({ label: emailId, value: emailId }))}
                        />
                      )}
                    />
                  </div>
                  {!nested && (
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="shrink-0 rounded-l-none border-l-0"
                      aria-label="快速新建邮箱账号"
                      title="快速新建邮箱账号"
                      onClick={() => emailDialog.show()}
                    >
                      <PlusIcon />
                    </Button>
                  )}
                </div>
                <FieldError>{errors.email?.message}</FieldError>
              </Field>
            )}

            <Field data-invalid={Boolean(errors.emailProvider) || undefined}>
              <FieldLabel htmlFor="account-email-provider">账号类型</FieldLabel>
              <Controller
                control={control}
                name="emailProvider"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger id="account-email-provider" className="w-full" aria-invalid={Boolean(errors.emailProvider)}>
                      <SelectValue placeholder="请选择账号类型" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {EMAIL_PROVIDER_OPTIONS.map(([value, label]) => (
                          <SelectItem key={value} value={value}>{label}</SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                )}
              />
              <FieldError>{errors.emailProvider?.message}</FieldError>
            </Field>

            {emailProvider === 'other' ? (
              <Field data-invalid={Boolean(errors.emailProviderDetail) || undefined}>
                <FieldLabel htmlFor="account-email-provider-detail">其他账号类型说明</FieldLabel>
                <Input
                  id="account-email-provider-detail"
                  {...register('emailProviderDetail')}
                  placeholder="Zoho / Fastmail"
                  aria-invalid={Boolean(errors.emailProviderDetail)}
                />
                <FieldError>{errors.emailProviderDetail?.message}</FieldError>
              </Field>
            ) : null}

            <Controller
              control={control}
              name="sites"
              render={() => (
                <Field>
                  <FieldLabel>注册站点（可选）</FieldLabel>
                  <div className="flex">
                    <div className="flex-1">
                      <SearchableSelect
                        value=""
                        onValueChange={(siteName) => {
                          addSite(siteName)
                        }}
                        placeholder="选择站点添加"
                        searchPlaceholder="搜索站点..."
                        className="w-full rounded-r-none"
                        options={allSites
                          .filter((s) => !siteIds.includes(s.id))
                          .map((site) => ({ label: site.name, value: site.id }))}
                      />
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      size="icon"
                      className="shrink-0 rounded-l-none border-l-0"
                      aria-label="快速新建站点"
                      title="快速新建站点"
                      onClick={() => siteDialog.show()}
                    >
                      <PlusIcon />
                    </Button>
                  </div>
                  {accountSites.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {accountSites.map((entry) => (
                        <Badge key={entry.site} variant="secondary" className="gap-1 pr-1">
                          {siteNamesById.get(entry.site) ?? entry.site}
                          <button type="button" className="rounded-full hover:bg-muted" onClick={() => removeSite(entry.site)}>
                            <X className="size-3" />
                          </button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </Field>
              )}
            />

            <Field data-invalid={Boolean(errors.passwordHint) || undefined}>
              <FieldLabel htmlFor="account-password-hint">密码提示</FieldLabel>
              <Input
                id="account-password-hint"
                {...register('passwordHint')}
                placeholder="仅填写非敏感提示，不要填写真实密码"
                aria-invalid={Boolean(errors.passwordHint)}
              />
              <FieldError>{errors.passwordHint?.message}</FieldError>
            </Field>

            <Field data-invalid={Boolean(errors.vaultLocation) || undefined}>
              <FieldLabel htmlFor="account-vault-location">密码库位置</FieldLabel>
              <Input
                id="account-vault-location"
                {...register('vaultLocation')}
                placeholder="1Password / Infra / Cloudflare 主账号"
                aria-invalid={Boolean(errors.vaultLocation)}
              />
              <FieldError>{errors.vaultLocation?.message}</FieldError>
            </Field>

            <Field data-invalid={Boolean(errors.description) || undefined}>
              <FieldLabel htmlFor="account-description">备注</FieldLabel>
              <Textarea id="account-description" {...register('description')} placeholder="账号用途说明（可选）" aria-invalid={Boolean(errors.description)} />
              <FieldError>{errors.description?.message}</FieldError>
            </Field>
          </FieldGroup>

          <div className="flex items-center justify-between gap-3 border-t pt-4">
            <Field orientation="horizontal" className="w-auto gap-2">
              <Controller
                control={control}
                name="isActive"
                render={({ field }) => (
                  <Checkbox id="account-is-active" checked={field.value} onCheckedChange={(checked) => field.onChange(checked === true)} />
                )}
              />
              <FieldLabel htmlFor="account-is-active">启用账号</FieldLabel>
            </Field>
            <div className="flex gap-3">
              <Button type="button" variant="outline" onClick={() => onClose()}>取消</Button>
              <Button type="submit" disabled={loading}>{loading ? '保存中...' : '保存'}</Button>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
    {siteDialog.hasOpened && (
      <SiteFormDialog
        open={siteDialog.open}
        onCloseAutoFocus={siteDialog.onCloseAutoFocus}
        onClose={(createdSite) => {
          siteDialog.hide()

          if (createdSite) {
            setCreatedSites((prev) => (prev.some((site) => site.id === createdSite.id) ? prev : [...prev, createdSite]))
            addSite(createdSite.id)
          }
        }}
      />
    )}
    {!nested && emailDialog.hasOpened && (
      <AccountFormDialog
        open={emailDialog.open}
        onCloseAutoFocus={emailDialog.onCloseAutoFocus}
        sites={allSites}
        emailIdentifiers={allEmailIdentifiers}
        nested
        onClose={(result) => {
          emailDialog.hide()
          const createdAccount = result?.createdAccount

          if (createdAccount && isEmail(createdAccount.identifier)) {
            setCreatedEmailIdentifiers((prev) => (prev.includes(createdAccount.identifier) ? prev : [...prev, createdAccount.identifier]))
            form.setValue('email', createdAccount.identifier, { shouldValidate: true })
          }
        }}
      />
    )}
    </>
  )
}
