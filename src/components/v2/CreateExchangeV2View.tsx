import { useMemo, useState } from 'react'
import { ArrowLeft, ArrowRight, CircleNotch, Gift } from '@phosphor-icons/react'
import { useNavigate } from 'react-router-dom'

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
import { Textarea } from '@/components/ui/textarea'
import { CURRENCIES } from '@/lib/currency-utils'
import { LANGUAGES, type Language } from '@/lib/types'
import { createExchange } from '@/lib/v2/api'

interface FormState {
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
  maxParticipants: string
  organizerEmail: string
  organizerLanguage: Language
}

const DEFAULT_MAX_PARTICIPANTS = '50'

export function CreateExchangeV2View() {
  const navigate = useNavigate()
  const { t, language } = useLanguage()
  const [step, setStep] = useState(1)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>({
    name: '',
    description: '',
    exchangeDate: '',
    exchangeTime: '',
    location: '',
    generalNotes: '',
    budgetCurrency: 'USD',
    budgetMin: '',
    budgetMax: '',
    rsvpDeadline: '',
    wishlistDeadline: '',
    maxParticipants: DEFAULT_MAX_PARTICIPANTS,
    organizerEmail: '',
    organizerLanguage: language,
  })

  const canContinue = form.name.trim().length > 0 && form.exchangeDate.trim().length > 0
  const maxParticipantsNumber = Number.parseInt(form.maxParticipants || DEFAULT_MAX_PARTICIPANTS, 10)
  const maxParticipantsValid = Number.isInteger(maxParticipantsNumber) && maxParticipantsNumber >= 3 && maxParticipantsNumber <= 50

  const progressLabels = useMemo(
    () => [t('v2StepEventDetails'), t('v2StepConfiguration')],
    [t],
  )

  const updateForm = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const handleSubmit = async () => {
    if (!canContinue || !maxParticipantsValid) {
      return
    }

    setIsSubmitting(true)
    setError(null)

    try {
      const budget = {
        currency: form.budgetCurrency,
        ...(form.budgetMin.trim() ? { amountMin: form.budgetMin.trim() } : {}),
        ...(form.budgetMax.trim() ? { amountMax: form.budgetMax.trim() } : {}),
      }

      const payload = {
        name: form.name.trim(),
        description: form.description.trim() || undefined,
        exchangeDate: form.exchangeDate,
        exchangeTime: form.exchangeTime || undefined,
        location: form.location.trim() || undefined,
        generalNotes: form.generalNotes.trim() || undefined,
        budget,
        rsvpDeadline: form.rsvpDeadline || undefined,
        wishlistDeadline: form.wishlistDeadline || undefined,
        organizerEmail: form.organizerEmail.trim() || undefined,
        organizerLanguage: form.organizerLanguage,
        maxParticipants: maxParticipantsNumber,
      }

      const { exchange, organizerToken } = await createExchange(payload)
      navigate(`/exchanges/${exchange.id}/organizer?token=${encodeURIComponent(organizerToken)}`)
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : t('v2Error'))
    } finally {
      setIsSubmitting(false)
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

      <div className="mx-auto max-w-2xl px-4 py-8">
        <div className="mb-8">
          <h1 className="text-3xl font-display font-bold text-primary">{t('v2CreateExchange')}</h1>
          <div className="mt-4 flex items-center gap-2">
            {progressLabels.map((label, index) => (
              <div key={label} className="flex flex-1 items-center gap-2">
                <div className={`h-2 flex-1 rounded-full transition-colors ${index + 1 <= step ? 'bg-primary' : 'bg-muted'}`} />
                <span className={`hidden text-sm font-medium sm:inline ${index + 1 === step ? 'text-primary' : 'text-muted-foreground'}`}>
                  {label}
                </span>
              </div>
            ))}
          </div>
        </div>

        <Card className="border-2 shadow-lg">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-2xl">
              <Gift size={28} className="text-primary" weight="duotone" />
              {step === 1 ? t('v2StepEventDetails') : t('v2StepConfiguration')}
            </CardTitle>
          </CardHeader>

          <CardContent className="space-y-6">
            {error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {error}
              </div>
            )}

            {step === 1 ? (
              <div className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="exchange-name">{t('v2ExchangeName')}</Label>
                  <Input
                    id="exchange-name"
                    placeholder={t('v2ExchangeNamePlaceholder')}
                    value={form.name}
                    onChange={(event) => updateForm('name', event.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="exchange-description">{t('v2ExchangeDescription')}</Label>
                  <Textarea
                    id="exchange-description"
                    placeholder={t('v2ExchangeDescriptionPlaceholder')}
                    value={form.description}
                    onChange={(event) => updateForm('description', event.target.value)}
                  />
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="exchange-date">{t('v2ExchangeDate')}</Label>
                    <Input
                      id="exchange-date"
                      type="date"
                      value={form.exchangeDate}
                      onChange={(event) => updateForm('exchangeDate', event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="exchange-time">{t('v2ExchangeTime')}</Label>
                    <Input
                      id="exchange-time"
                      type="time"
                      value={form.exchangeTime}
                      onChange={(event) => updateForm('exchangeTime', event.target.value)}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="exchange-location">{t('v2ExchangeLocation')}</Label>
                  <Input
                    id="exchange-location"
                    value={form.location}
                    onChange={(event) => updateForm('location', event.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="exchange-notes">{t('v2ExchangeGeneralNotes')}</Label>
                  <Textarea
                    id="exchange-notes"
                    value={form.generalNotes}
                    onChange={(event) => updateForm('generalNotes', event.target.value)}
                  />
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-3">
                  <div className="space-y-2 sm:col-span-1">
                    <Label>{t('v2BudgetCurrency')}</Label>
                    <Select value={form.budgetCurrency} onValueChange={(value) => updateForm('budgetCurrency', value)}>
                      <SelectTrigger>
                        <SelectValue placeholder={t('currency')} />
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
                    <Label htmlFor="budget-min">{t('v2BudgetMin')}</Label>
                    <Input
                      id="budget-min"
                      inputMode="decimal"
                      value={form.budgetMin}
                      onChange={(event) => updateForm('budgetMin', event.target.value)}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="budget-max">{t('v2BudgetMax')}</Label>
                    <Input
                      id="budget-max"
                      inputMode="decimal"
                      value={form.budgetMax}
                      onChange={(event) => updateForm('budgetMax', event.target.value)}
                    />
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="rsvp-deadline">{t('v2RsvpDeadline')}</Label>
                    <Input
                      id="rsvp-deadline"
                      type="datetime-local"
                      value={form.rsvpDeadline}
                      onChange={(event) => updateForm('rsvpDeadline', event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="wishlist-deadline">{t('v2WishlistDeadline')}</Label>
                    <Input
                      id="wishlist-deadline"
                      type="datetime-local"
                      value={form.wishlistDeadline}
                      onChange={(event) => updateForm('wishlistDeadline', event.target.value)}
                    />
                  </div>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="max-participants">{t('v2MaxParticipants')}</Label>
                    <Input
                      id="max-participants"
                      type="number"
                      min={3}
                      max={50}
                      value={form.maxParticipants}
                      onChange={(event) => updateForm('maxParticipants', event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="organizer-email">{t('organizerEmail')}</Label>
                    <Input
                      id="organizer-email"
                      type="email"
                      value={form.organizerEmail}
                      onChange={(event) => updateForm('organizerEmail', event.target.value)}
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <Label>{t('v2OrganizerLanguage')}</Label>
                  <Select
                    value={form.organizerLanguage}
                    onValueChange={(value) => updateForm('organizerLanguage', value as Language)}
                  >
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

                {!maxParticipantsValid && (
                  <p className="text-sm text-destructive">{t('v2MaxParticipants')}</p>
                )}
              </div>
            )}
          </CardContent>

          <CardFooter className="justify-between border-t pt-6">
            {step === 1 ? (
              <Button variant="outline" onClick={() => navigate('/')}>
                {t('cancel')}
              </Button>
            ) : (
              <Button variant="outline" onClick={() => setStep(1)}>
                {t('back')}
              </Button>
            )}

            {step === 1 ? (
              <Button onClick={() => setStep(2)} disabled={!canContinue} className="gap-2">
                {t('next')}
                <ArrowRight size={18} />
              </Button>
            ) : (
              <Button onClick={handleSubmit} disabled={isSubmitting || !maxParticipantsValid} className="gap-2">
                {isSubmitting && <CircleNotch size={18} className="animate-spin" />}
                {isSubmitting ? t('creating') : t('v2SaveDraft')}
              </Button>
            )}
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
