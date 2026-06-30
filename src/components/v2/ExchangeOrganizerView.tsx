import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, CircleNotch } from '@phosphor-icons/react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'

import { LanguageToggle } from '@/components/LanguageToggle'
import { useLanguage } from '@/components/useLanguage'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Textarea } from '@/components/ui/textarea'
import { CURRENCIES } from '@/lib/currency-utils'
import { LANGUAGES, type Language } from '@/lib/types'
import { getExchange, patchExchange, publishExchange } from '@/lib/v2/api'
import type { Exchange } from '@/lib/v2/types'

import { InvitePanel } from './InvitePanel'
import { ParticipantsPanel } from './ParticipantsPanel'

interface OrganizerParticipantSummary {
  id: string
  displayName: string
  wishlistItemCount: number
}

interface ExchangeDetailsState {
  name: string
  description: string
  exchangeDate: string
  exchangeTime: string
  location: string
  generalNotes: string
  budgetCurrency: string
  budgetMin: string
  budgetMax: string
  rsvpDeadline: string
  wishlistDeadline: string
  revealAt: string
  organizerEmail: string
  organizerLanguage: Language
  maxParticipants: string
}

function badgeClassName(status: Exchange['status']) {
  switch (status) {
    case 'published':
      return 'bg-blue-100 text-blue-700 border-blue-200'
    case 'matching':
      return 'bg-yellow-100 text-yellow-800 border-yellow-200'
    case 'matched':
      return 'bg-green-100 text-green-700 border-green-200'
    case 'completed':
      return 'bg-teal-100 text-teal-700 border-teal-200'
    case 'cancelled':
      return 'bg-red-100 text-red-700 border-red-200'
    default:
      return 'bg-slate-100 text-slate-700 border-slate-200'
  }
}

function statusLabel(status: Exchange['status'], t: (key: string) => string) {
  switch (status) {
    case 'published':
      return t('v2StatusPublished')
    case 'matching':
      return t('v2StatusMatching')
    case 'matched':
      return t('v2StatusMatched')
    case 'completed':
      return t('v2StatusCompleted')
    case 'cancelled':
      return t('v2StatusCancelled')
    default:
      return t('v2StatusDraft')
  }
}

function toFormState(exchange: Exchange): ExchangeDetailsState {
  return {
    name: exchange.name,
    description: exchange.description || '',
    exchangeDate: exchange.exchangeDate,
    exchangeTime: exchange.exchangeTime || '',
    location: exchange.location || '',
    generalNotes: exchange.generalNotes || '',
    budgetCurrency: exchange.budget?.currency || 'USD',
    budgetMin: exchange.budget?.amountMin || '',
    budgetMax: exchange.budget?.amountMax || '',
    rsvpDeadline: exchange.rsvpDeadline || '',
    wishlistDeadline: exchange.wishlistDeadline || '',
    revealAt: exchange.revealAt || '',
    organizerEmail: exchange.organizerEmail || '',
    organizerLanguage: (exchange.organizerLanguage || 'en') as Language,
    maxParticipants: String(exchange.maxParticipants || 50),
  }
}

export function ExchangeOrganizerView() {
  const navigate = useNavigate()
  const { exchangeId = '' } = useParams()
  const [searchParams] = useSearchParams()
  const organizerToken = searchParams.get('token') || ''
  const { t } = useLanguage()

  const [exchange, setExchange] = useState<Exchange | null>(null)
  const [details, setDetails] = useState<ExchangeDetailsState | null>(null)
  const [participants, setParticipants] = useState<OrganizerParticipantSummary[]>([])
  const [counts, setCounts] = useState({ invites: 0, acceptedInvites: 0, participants: 0, wishlistItems: 0, matches: 0 })
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadExchange = async () => {
    if (!exchangeId || !organizerToken) {
      setError(t('v2Error'))
      setIsLoading(false)
      return
    }

    setIsLoading(true)
    setError(null)

    try {
      const result = await getExchange(exchangeId, organizerToken)
      setExchange(result.exchange)
      setDetails(toFormState(result.exchange))
      setParticipants(result.participants || [])
      setCounts(result.counts)
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('v2Error'))
    } finally {
      setIsLoading(false)
    }
  }

  useEffect(() => {
    void loadExchange()
  }, [exchangeId, organizerToken])

  const isDraft = exchange?.status === 'draft'
  const canInvite = exchange?.status === 'published' || exchange?.status === 'matching' || exchange?.status === 'matched'

  const maxParticipants = useMemo(() => Number.parseInt(details?.maxParticipants || '50', 10) || 50, [details])

  const updateDetails = <K extends keyof ExchangeDetailsState>(key: K, value: ExchangeDetailsState[K]) => {
    setDetails((current) => (current ? { ...current, [key]: value } : current))
  }

  const handleSave = async () => {
    if (!exchange || !details) {
      return
    }

    setIsSaving(true)
    setError(null)

    try {
      const result = await patchExchange(exchange.id, organizerToken, {
        name: details.name.trim(),
        description: details.description.trim() || undefined,
        exchangeDate: details.exchangeDate,
        exchangeTime: details.exchangeTime || undefined,
        location: details.location.trim() || undefined,
        generalNotes: details.generalNotes.trim() || undefined,
        budget: {
          currency: details.budgetCurrency,
          amountMin: details.budgetMin.trim() || undefined,
          amountMax: details.budgetMax.trim() || undefined,
        },
        rsvpDeadline: details.rsvpDeadline || undefined,
        wishlistDeadline: details.wishlistDeadline || undefined,
        revealAt: details.revealAt || undefined,
        organizerEmail: details.organizerEmail.trim() || undefined,
        organizerLanguage: details.organizerLanguage,
        maxParticipants: Number.parseInt(details.maxParticipants || '50', 10),
      })
      setExchange(result.exchange)
      setDetails(toFormState(result.exchange))
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('v2Error'))
    } finally {
      setIsSaving(false)
    }
  }

  const handlePublish = async () => {
    if (!exchange) {
      return
    }

    setIsSaving(true)
    setError(null)

    try {
      const result = await publishExchange(exchange.id, organizerToken)
      setExchange(result.exchange)
      setDetails(toFormState(result.exchange))
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : t('v2Error'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b p-4">
        <Button variant="ghost" className="gap-2" onClick={() => navigate('/')}>
          <ArrowLeft size={20} />
          {t('back')}
        </Button>
        <LanguageToggle />
      </header>

      <div className="mx-auto max-w-5xl px-4 py-8">
        <Card className="border-2 shadow-lg">
          <CardHeader className="gap-4 sm:flex sm:flex-row sm:items-center sm:justify-between">
            <div>
              <CardTitle className="text-2xl font-display text-primary">{exchange?.name || t('v2OrganizerPanel')}</CardTitle>
              <p className="mt-2 text-sm text-muted-foreground">{t('v2ExchangeCode')}: {exchange?.code || '—'}</p>
            </div>
            {exchange && <Badge className={badgeClassName(exchange.status)}>{statusLabel(exchange.status, t)}</Badge>}
          </CardHeader>

          <CardContent className="space-y-6">
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

            {exchange && details && (
              <Tabs defaultValue="details" className="space-y-6">
                <TabsList>
                  <TabsTrigger value="details">{t('v2TabDetails')}</TabsTrigger>
                  <TabsTrigger value="invites">{t('v2TabInvites')}</TabsTrigger>
                  <TabsTrigger value="participants">{t('v2TabParticipants')}</TabsTrigger>
                </TabsList>

                <TabsContent value="details" className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2 sm:col-span-2">
                      <Label htmlFor="org-name">{t('v2ExchangeName')}</Label>
                      <Input id="org-name" value={details.name} disabled={!isDraft} onChange={(event) => updateDetails('name', event.target.value)} />
                    </div>
                    <div className="space-y-2 sm:col-span-2">
                      <Label htmlFor="org-description">{t('v2ExchangeDescription')}</Label>
                      <Textarea id="org-description" value={details.description} disabled={!isDraft} onChange={(event) => updateDetails('description', event.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="org-date">{t('v2ExchangeDate')}</Label>
                      <Input id="org-date" type="date" value={details.exchangeDate} disabled={!isDraft} onChange={(event) => updateDetails('exchangeDate', event.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="org-time">{t('v2ExchangeTime')}</Label>
                      <Input id="org-time" type="time" value={details.exchangeTime} disabled={!isDraft} onChange={(event) => updateDetails('exchangeTime', event.target.value)} />
                    </div>
                    <div className="space-y-2 sm:col-span-2">
                      <Label htmlFor="org-location">{t('v2ExchangeLocation')}</Label>
                      <Input id="org-location" value={details.location} disabled={!isDraft} onChange={(event) => updateDetails('location', event.target.value)} />
                    </div>
                    <div className="space-y-2 sm:col-span-2">
                      <Label htmlFor="org-notes">{t('v2ExchangeGeneralNotes')}</Label>
                      <Textarea id="org-notes" value={details.generalNotes} disabled={!isDraft} onChange={(event) => updateDetails('generalNotes', event.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>{t('v2BudgetCurrency')}</Label>
                      <Select value={details.budgetCurrency} disabled={!isDraft} onValueChange={(value) => updateDetails('budgetCurrency', value)}>
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CURRENCIES.map((currency) => (
                            <SelectItem key={currency.code} value={currency.code}>
                              {currency.flag} {currency.code} · {currency.symbol}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="org-min">{t('v2BudgetMin')}</Label>
                      <Input id="org-min" value={details.budgetMin} disabled={!isDraft} onChange={(event) => updateDetails('budgetMin', event.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="org-max">{t('v2BudgetMax')}</Label>
                      <Input id="org-max" value={details.budgetMax} disabled={!isDraft} onChange={(event) => updateDetails('budgetMax', event.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="org-rsvp">{t('v2RsvpDeadline')}</Label>
                      <Input id="org-rsvp" type="datetime-local" value={details.rsvpDeadline} disabled={!isDraft} onChange={(event) => updateDetails('rsvpDeadline', event.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="org-wishlist">{t('v2WishlistDeadline')}</Label>
                      <Input id="org-wishlist" type="datetime-local" value={details.wishlistDeadline} disabled={!isDraft} onChange={(event) => updateDetails('wishlistDeadline', event.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="org-max-participants">{t('v2MaxParticipants')}</Label>
                      <Input id="org-max-participants" type="number" min={3} max={50} value={details.maxParticipants} disabled={!isDraft} onChange={(event) => updateDetails('maxParticipants', event.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="org-email">{t('organizerEmail')}</Label>
                      <Input id="org-email" type="email" value={details.organizerEmail} disabled={!isDraft} onChange={(event) => updateDetails('organizerEmail', event.target.value)} />
                    </div>
                    <div className="space-y-2">
                      <Label>{t('v2OrganizerLanguage')}</Label>
                      <Select value={details.organizerLanguage} disabled={!isDraft} onValueChange={(value) => updateDetails('organizerLanguage', value as Language)}>
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
                  </div>

                  <div className="flex flex-wrap gap-2">
                    {isDraft && (
                      <Button onClick={handleSave} disabled={isSaving}>
                        {t('v2SaveChanges')}
                      </Button>
                    )}
                    {isDraft && (
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="outline">{t('v2PublishExchange')}</Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>{t('v2ConfirmPublish')}</AlertDialogTitle>
                            <AlertDialogDescription>{t('v2ConfirmPublishDesc')}</AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
                            <AlertDialogAction onClick={handlePublish}>{t('v2PublishExchange')}</AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    )}
                  </div>
                </TabsContent>

                <TabsContent value="invites">
                  {canInvite ? (
                    <InvitePanel
                      exchangeId={exchange.id}
                      organizerToken={organizerToken}
                      maxParticipants={maxParticipants}
                      participantCount={counts.participants}
                    />
                  ) : (
                    <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                      {t('v2PublishExchange')}
                    </div>
                  )}
                </TabsContent>

                <TabsContent value="participants">
                  <ParticipantsPanel participants={participants} />
                </TabsContent>
              </Tabs>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
