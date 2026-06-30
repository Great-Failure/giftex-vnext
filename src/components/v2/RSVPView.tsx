import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, CircleNotch } from '@phosphor-icons/react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { LanguageToggle } from '@/components/LanguageToggle'
import { useLanguage } from '@/components/useLanguage'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CURRENCIES, formatAmount } from '@/lib/currency-utils'
import { LANGUAGES, type Language } from '@/lib/types'
import { acceptInvite, declineInvite, getMyInvite } from '@/lib/v2/api'
import type { Exchange, Invite } from '@/lib/v2/types'

interface InviteContext {
  invite: Invite
  exchange: Partial<Exchange>
  participantId?: string
}

export function RSVPView() {
  const navigate = useNavigate()
  const { t, language } = useLanguage()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''

  const [data, setData] = useState<InviteContext | null>(null)
  const [displayName, setDisplayName] = useState('')
  const [preferredLanguage, setPreferredLanguage] = useState<Language>(language)
  const [isLoading, setIsLoading] = useState(true)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [declined, setDeclined] = useState(false)

  useEffect(() => {
    const loadInvite = async () => {
      if (!token) {
        setError(t('v2Error'))
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      setError(null)

      try {
        const result = await getMyInvite(token)
        setData(result)
        setDisplayName(result.invite.suggestedName || '')
        setPreferredLanguage((result.invite.preferredLanguage || language) as Language)
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : t('v2Error'))
      } finally {
        setIsLoading(false)
      }
    }

    void loadInvite()
  }, [language, t, token])

  const budgetText = useMemo(() => {
    const budget = data?.exchange.budget
    if (!budget) {
      return null
    }

    const currency = CURRENCIES.find((item) => item.code === budget.currency)
    const min = formatAmount(budget.amountMin || '', budget.currency, '')
    const max = formatAmount(budget.amountMax || '', budget.currency, '')

    if (budget.amountMin && budget.amountMax) {
      return `${currency?.flag ? `${currency.flag} ` : ''}${min} - ${max}`
    }
    if (budget.amountMin) {
      return min
    }
    if (budget.amountMax) {
      return max
    }

    return budget.currency
  }, [data])

  const goHome = () => navigate('/')
  const goToWishlist = () => navigate(`/wishlist?token=${encodeURIComponent(token)}`)

  const handleAccept = async () => {
    if (!token || !displayName.trim()) {
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      await acceptInvite(token, displayName.trim(), preferredLanguage)
      navigate(`/wishlist?token=${encodeURIComponent(token)}`)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t('v2Error'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleDecline = async () => {
    if (!token) {
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      const result = await declineInvite(token)
      setData((current) => (current ? { ...current, invite: result.invite } : current))
      setDeclined(true)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t('v2Error'))
    } finally {
      setIsSubmitting(false)
    }
  }

  const inviteStatus = data?.invite.status

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b p-4">
        <Button variant="ghost" className="gap-2" onClick={goHome}>
          <ArrowLeft size={20} />
          {t('back')}
        </Button>
        <LanguageToggle />
      </header>

      <div className="mx-auto max-w-2xl px-4 py-8">
        <Card className="border-2 shadow-lg">
          <CardHeader>
            <CardTitle className="text-2xl font-display text-primary">{t('v2RSVPTitle')}</CardTitle>
          </CardHeader>

          <CardContent className="space-y-6">
            {(isLoading || isSubmitting) && (
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

            {data && (
              <>
                <div className="space-y-2 rounded-lg border bg-muted/30 p-4">
                  <h2 className="text-xl font-semibold">{data.exchange.name}</h2>
                  {data.exchange.description && (
                    <p className="text-sm text-muted-foreground">{data.exchange.description}</p>
                  )}
                  <div className="grid gap-2 text-sm sm:grid-cols-2">
                    {data.exchange.exchangeDate && (
                      <p><span className="font-medium">{t('v2ExchangeDate')}:</span> {data.exchange.exchangeDate}</p>
                    )}
                    {budgetText && (
                      <p><span className="font-medium">{t('v2BudgetCurrency')}:</span> {budgetText}</p>
                    )}
                  </div>
                </div>

                {inviteStatus === 'accepted' && (
                  <div className="space-y-4 rounded-lg border border-primary/20 bg-primary/5 p-4">
                    <p className="font-medium text-primary">{t('v2AlreadyAccepted')}</p>
                    <Button onClick={goToWishlist}>{t('v2GoToWishlist')}</Button>
                  </div>
                )}

                {(inviteStatus === 'declined' || declined) && (
                  <div className="rounded-lg border border-muted bg-muted/30 p-4 text-sm font-medium">
                    {t('v2AlreadyDeclined')}
                  </div>
                )}

                {inviteStatus === 'expired' && (
                  <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm font-medium text-destructive">
                    {t('v2InviteExpired')}
                  </div>
                )}

                {inviteStatus === 'sent' && !declined && (
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="display-name">{t('v2YourName')}</Label>
                      <Input
                        id="display-name"
                        value={displayName}
                        onChange={(event) => setDisplayName(event.target.value)}
                      />
                    </div>

                    <div className="space-y-2">
                      <Label>{t('v2OrganizerLanguage')}</Label>
                      <Select value={preferredLanguage} onValueChange={(value) => setPreferredLanguage(value as Language)}>
                        <SelectTrigger>
                          <SelectValue placeholder={t('v2OrganizerLanguage')} />
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
                  </div>
                )}
              </>
            )}
          </CardContent>

          <CardFooter className="justify-end gap-2 border-t pt-6">
            {inviteStatus === 'sent' && !declined && (
              <>
                <Button variant="outline" onClick={handleDecline} disabled={isSubmitting}>
                  {t('v2DeclineInvite')}
                </Button>
                <Button onClick={handleAccept} disabled={isSubmitting || !displayName.trim()}>
                  {t('v2AcceptInvite')}
                </Button>
              </>
            )}

            {(inviteStatus === 'accepted' || inviteStatus === 'declined' || inviteStatus === 'expired' || declined) && (
              <Button variant="outline" onClick={goHome}>
                {t('goHome')}
              </Button>
            )}
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
