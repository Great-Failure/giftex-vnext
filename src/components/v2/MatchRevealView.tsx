import { useEffect, useState } from 'react'
import { ArrowLeft, CircleNotch } from '@phosphor-icons/react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import { LanguageToggle } from '@/components/LanguageToggle'
import { useLanguage } from '@/components/useLanguage'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { getMyMatch } from '@/lib/v2/api'
import type { Match, Participant, WishlistItem } from '@/lib/v2/types'

interface MatchPayload {
  revealStatus?: 'pending' | 'revealed'
  revealAt?: string | null
  match: Match
  receiver: Participant
  wishlist: WishlistItem[]
}

function priorityLabel(priority: WishlistItem['priority'], t: (key: string) => string) {
  switch (priority) {
    case 'high':
      return t('v2PriorityHigh')
    case 'low':
      return t('v2PriorityLow')
    default:
      return t('v2PriorityMedium')
  }
}

export function MatchRevealView() {
  const navigate = useNavigate()
  const { t } = useLanguage()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''

  const [data, setData] = useState<MatchPayload | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadMatch = async () => {
      if (!token) {
        setError(t('v2Error'))
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      setError(null)

      try {
        const result = await getMyMatch(token)
        setData(result)
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : t('v2Error'))
      } finally {
        setIsLoading(false)
      }
    }

    void loadMatch()
  }, [t, token])

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b p-4">
        <Button variant="ghost" className="gap-2" onClick={() => navigate(`/wishlist?token=${encodeURIComponent(token)}`)}>
          <ArrowLeft size={20} />
          {t('back')}
        </Button>
        <LanguageToggle />
      </header>

      <div className="mx-auto max-w-3xl px-4 py-8">
        <Card className="border-2 shadow-lg">
          <CardHeader>
            <CardTitle className="text-2xl font-display text-primary">{t('v2MatchRevealTitle')}</CardTitle>
          </CardHeader>

          <CardContent className="space-y-6">
            {isLoading && (
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

            {!isLoading && data?.revealStatus === 'pending' && (
              <div className="rounded-lg border border-muted bg-muted/30 p-4 text-sm">
                {data.revealAt ? `${t('v2Loading')} ${data.revealAt}` : t('v2Loading')}
              </div>
            )}

            {!isLoading && data?.receiver && (
              <>
                <div className="rounded-lg border bg-primary/5 p-6 text-center">
                  <p className="text-sm uppercase tracking-wide text-muted-foreground">{t('v2YouGiveTo')}</p>
                  <h2 className="mt-2 text-3xl font-bold text-primary">{data.receiver.displayName}</h2>
                </div>

                <div className="space-y-4">
                  <h3 className="text-lg font-semibold">{t('v2TheirWishlist')}</h3>
                  {data.wishlist.length === 0 ? (
                    <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                      {t('v2NoWishlistItems')}
                    </div>
                  ) : (
                    data.wishlist.map((item) => (
                      <div key={item.id} className="rounded-lg border p-4">
                        <div className="flex items-start justify-between gap-3">
                          <div className="space-y-2">
                            <p className="font-medium">{item.title}</p>
                            {item.url && (
                              <a className="text-sm text-primary underline" href={item.url} rel="noreferrer" target="_blank">
                                {item.url}
                              </a>
                            )}
                            {item.notes && <p className="text-sm text-muted-foreground">{item.notes}</p>}
                          </div>
                          <Badge>{priorityLabel(item.priority, t)}</Badge>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </>
            )}
          </CardContent>

          <CardFooter className="justify-end border-t pt-6">
            <Button variant="outline" onClick={() => navigate(`/wishlist?token=${encodeURIComponent(token)}`)}>
              Back to Exchange
            </Button>
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
