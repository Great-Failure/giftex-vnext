import { useEffect, useMemo, useState } from 'react'
import { CircleNotch } from '@phosphor-icons/react'

import { useLanguage } from '@/components/useLanguage'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { LANGUAGES, type Language } from '@/lib/types'
import { createInvites, listInvites } from '@/lib/v2/api'
import type { Invite } from '@/lib/v2/types'

interface InvitePanelProps {
  exchangeId: string
  organizerToken: string
  maxParticipants: number
  participantCount: number
}

interface InviteFormState {
  email: string
  suggestedName: string
  preferredLanguage: Language
}

const defaultFormState: InviteFormState = {
  email: '',
  suggestedName: '',
  preferredLanguage: 'en',
}

function statusLabel(status: Invite['status'], t: (key: string) => string) {
  switch (status) {
    case 'accepted':
      return t('v2StatusAccepted')
    case 'declined':
      return t('v2StatusDeclined')
    case 'expired':
      return t('v2StatusExpired')
    default:
      return t('v2StatusSent')
  }
}

function statusVariant(status: Invite['status']) {
  switch (status) {
    case 'accepted':
      return 'default' as const
    case 'declined':
      return 'secondary' as const
    case 'expired':
      return 'outline' as const
    default:
      return 'outline' as const
  }
}

export function InvitePanel({ exchangeId, organizerToken, maxParticipants, participantCount }: InvitePanelProps) {
  const { t } = useLanguage()
  const [invites, setInvites] = useState<Invite[]>([])
  const [form, setForm] = useState<InviteFormState>(defaultFormState)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadInvites = async () => {
      setIsLoading(true)
      setError(null)

      try {
        const result = await listInvites(exchangeId, organizerToken)
        setInvites(result.invites)
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : t('v2Error'))
      } finally {
        setIsLoading(false)
      }
    }

    void loadInvites()
  }, [exchangeId, organizerToken, t])

  const activeInviteCount = useMemo(
    () => invites.filter((invite) => invite.status === 'sent').length,
    [invites],
  )
  const projectedCount = participantCount + activeInviteCount
  const remainingSlots = maxParticipants - projectedCount
  const isNearLimit = remainingSlots <= 5
  const cannotAddInvite = remainingSlots <= 0

  const updateForm = <K extends keyof InviteFormState>(key: K, value: InviteFormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const handleAddInvite = async () => {
    if (!form.email.trim() || cannotAddInvite) {
      return
    }

    setIsSaving(true)
    setError(null)

    try {
      const result = await createInvites(exchangeId, organizerToken, [
        {
          email: form.email.trim(),
          suggestedName: form.suggestedName.trim() || undefined,
          preferredLanguage: form.preferredLanguage,
        },
      ])
      setInvites((current) => [...current, ...result.invites])
      setForm(defaultFormState)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('v2Error'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-2 rounded-lg border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="font-medium">{t('v2InviteList')}</p>
          <p className="text-sm text-muted-foreground">{participantCount} / {maxParticipants}</p>
        </div>
        {isNearLimit && (
          <p className="text-sm text-amber-600">
            {cannotAddInvite ? t('v2ParticipantLimitReached') : t('v2SlotsRemaining').replace('{count}', String(remainingSlots))}
          </p>
        )}
      </div>

      {(isLoading || isSaving) && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <CircleNotch size={18} className="animate-spin" />
          {t('v2Loading')}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {error}
        </div>
      )}

      <div className="space-y-3">
        {invites.length === 0 ? (
          <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
            {t('v2InviteList')}
          </div>
        ) : (
          invites.map((invite) => (
            <div key={invite.id} className="flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="font-medium">{invite.suggestedName || invite.email}</p>
                <p className="text-sm text-muted-foreground">{invite.email}</p>
              </div>
              <Badge variant={statusVariant(invite.status)}>{statusLabel(invite.status, t)}</Badge>
            </div>
          ))
        )}
      </div>

      <div className="space-y-4 rounded-lg border p-4">
        <div className="space-y-2">
          <Label htmlFor="invite-email">{t('v2InviteEmail')}</Label>
          <Input
            id="invite-email"
            type="email"
            value={form.email}
            onChange={(event) => updateForm('email', event.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="invite-name">{t('v2InviteName')}</Label>
          <Input
            id="invite-name"
            value={form.suggestedName}
            onChange={(event) => updateForm('suggestedName', event.target.value)}
          />
        </div>

        <div className="space-y-2">
          <Label>{t('v2OrganizerLanguage')}</Label>
          <Select value={form.preferredLanguage} onValueChange={(value) => updateForm('preferredLanguage', value as Language)}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LANGUAGES.map((option) => (
                <SelectItem key={option.code} value={option.code}>
                  {option.flag} {option.nativeName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex justify-end">
          <Button onClick={handleAddInvite} disabled={isSaving || cannotAddInvite || !form.email.trim()}>
            {t('v2AddInvite')}
          </Button>
        </div>
      </div>
    </div>
  )
}
