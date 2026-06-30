import { useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { ArrowLeft, CircleNotch, PencilSimple, Trash } from '@phosphor-icons/react'
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
import { Textarea } from '@/components/ui/textarea'
import { addWishlistItem, deleteWishlistItem, getMyInvite, getMyWishlist, updateWishlistItem } from '@/lib/v2/api'
import type { Exchange, Invite, WishlistItem, WishlistPriority } from '@/lib/v2/types'

interface InviteContext {
  invite: Invite
  exchange: Partial<Exchange>
  participantId?: string
}

interface WishlistFormState {
  title: string
  url: string
  notes: string
  priority: WishlistPriority
}

const defaultFormState: WishlistFormState = {
  title: '',
  url: '',
  notes: '',
  priority: 'medium',
}

export function WishlistView() {
  const navigate = useNavigate()
  const { t } = useLanguage()
  const [searchParams] = useSearchParams()
  const token = searchParams.get('token') || ''

  const [inviteContext, setInviteContext] = useState<InviteContext | null>(null)
  const [items, setItems] = useState<WishlistItem[]>([])
  const [form, setForm] = useState<WishlistFormState>(defaultFormState)
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
  const [editingForm, setEditingForm] = useState<WishlistFormState>(defaultFormState)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const loadWishlist = async () => {
      if (!token) {
        setError(t('v2Error'))
        setIsLoading(false)
        return
      }

      setIsLoading(true)
      setError(null)

      try {
        const invite = await getMyInvite(token)
        setInviteContext(invite)

        if (invite.invite.status === 'accepted') {
          const wishlist = await getMyWishlist(token)
          setItems(wishlist.items)
        } else {
          setItems([])
        }
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : t('v2Error'))
      } finally {
        setIsLoading(false)
      }
    }

    void loadWishlist()
  }, [t, token])

  const isAccepted = inviteContext?.invite.status === 'accepted'
  const isFrozen = useMemo(() => {
    const status = inviteContext?.exchange.status
    return status === 'matched' || status === 'completed'
  }, [inviteContext])

  const updateFormState = <K extends keyof WishlistFormState>(
    setter: Dispatch<SetStateAction<WishlistFormState>>,
    key: K,
    value: WishlistFormState[K],
  ) => {
    setter((current) => ({ ...current, [key]: value }))
  }

  const handleAddItem = async () => {
    if (!token || !form.title.trim()) {
      return
    }

    setIsSaving(true)
    setError(null)

    try {
      const result = await addWishlistItem(token, {
        title: form.title.trim(),
        url: form.url.trim() || undefined,
        notes: form.notes.trim() || undefined,
        priority: form.priority,
      })
      setItems((current) => [...current, result.item])
      setForm(defaultFormState)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('v2Error'))
    } finally {
      setIsSaving(false)
    }
  }

  const handleStartEdit = (item: WishlistItem) => {
    setEditingItemId(item.id)
    setEditingForm({
      title: item.title,
      url: item.url || '',
      notes: item.notes || '',
      priority: item.priority,
    })
  }

  const handleSaveEdit = async () => {
    if (!token || !editingItemId || !editingForm.title.trim()) {
      return
    }

    setIsSaving(true)
    setError(null)

    try {
      const result = await updateWishlistItem(token, editingItemId, {
        title: editingForm.title.trim(),
        url: editingForm.url.trim() || null,
        notes: editingForm.notes.trim() || null,
        priority: editingForm.priority,
      })
      setItems((current) => current.map((item) => (item.id === editingItemId ? result.item : item)))
      setEditingItemId(null)
      setEditingForm(defaultFormState)
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : t('v2Error'))
    } finally {
      setIsSaving(false)
    }
  }

  const handleDelete = async (itemId: string) => {
    if (!token || !window.confirm(t('confirm'))) {
      return
    }

    setIsSaving(true)
    setError(null)

    try {
      await deleteWishlistItem(token, itemId)
      setItems((current) => current.filter((item) => item.id !== itemId))
      if (editingItemId === itemId) {
        setEditingItemId(null)
        setEditingForm(defaultFormState)
      }
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : t('v2Error'))
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b p-4">
        <Button variant="ghost" className="gap-2" onClick={() => navigate(`/rsvp?token=${encodeURIComponent(token)}`)}>
          <ArrowLeft size={20} />
          {t('back')}
        </Button>
        <LanguageToggle />
      </header>

      <div className="mx-auto max-w-3xl px-4 py-8">
        <Card className="border-2 shadow-lg">
          <CardHeader>
            <CardTitle className="text-2xl font-display text-primary">{t('v2WishlistTitle')}</CardTitle>
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

            {!isLoading && inviteContext && !isAccepted && (
              <div className="space-y-4 rounded-lg border border-primary/20 bg-primary/5 p-4">
                <p className="text-sm font-medium">Please accept your invitation first.</p>
                <Button variant="outline" onClick={() => navigate(`/rsvp?token=${encodeURIComponent(token)}`)}>
                  {t('v2RSVPTitle')}
                </Button>
              </div>
            )}

            {!isLoading && inviteContext && isAccepted && isFrozen && (
              <div className="rounded-lg border border-muted bg-muted/30 p-4 text-sm font-medium">
                {t('v2WishlistFrozen')}
              </div>
            )}

            {!isLoading && isAccepted && items.length === 0 && (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                {t('v2EmptyWishlist')}
              </div>
            )}

            {!isLoading && isAccepted && items.length > 0 && (
              <div className="space-y-4">
                {items.map((item) => {
                  const isEditing = editingItemId === item.id
                  return (
                    <div key={item.id} className="rounded-lg border p-4">
                      {isEditing ? (
                        <div className="space-y-3">
                          <Input
                            value={editingForm.title}
                            onChange={(event) => updateFormState(setEditingForm, 'title', event.target.value)}
                          />
                          <Input
                            value={editingForm.url}
                            onChange={(event) => updateFormState(setEditingForm, 'url', event.target.value)}
                            placeholder={t('v2WishlistItemUrl')}
                          />
                          <Textarea
                            value={editingForm.notes}
                            onChange={(event) => updateFormState(setEditingForm, 'notes', event.target.value)}
                            placeholder={t('v2WishlistItemNotes')}
                          />
                          <Select
                            value={editingForm.priority}
                            onValueChange={(value) => updateFormState(setEditingForm, 'priority', value as WishlistPriority)}
                          >
                            <SelectTrigger>
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="high">{t('v2PriorityHigh')}</SelectItem>
                              <SelectItem value="medium">{t('v2PriorityMedium')}</SelectItem>
                              <SelectItem value="low">{t('v2PriorityLow')}</SelectItem>
                            </SelectContent>
                          </Select>
                          <div className="flex justify-end gap-2">
                            <Button variant="outline" onClick={() => setEditingItemId(null)}>
                              {t('cancel')}
                            </Button>
                            <Button onClick={handleSaveEdit}>{t('v2SaveChanges')}</Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                          <div className="space-y-2">
                            <p className="font-medium">{item.title}</p>
                            <p className="text-sm text-muted-foreground">{item.priority}</p>
                            {item.url && (
                              <a className="text-sm text-primary underline" href={item.url} rel="noreferrer" target="_blank">
                                {item.url}
                              </a>
                            )}
                            {item.notes && <p className="text-sm text-muted-foreground">{item.notes}</p>}
                          </div>

                          {!isFrozen && (
                            <div className="flex gap-2">
                              <Button variant="outline" size="icon" onClick={() => handleStartEdit(item)}>
                                <PencilSimple size={18} />
                              </Button>
                              <Button variant="outline" size="icon" onClick={() => handleDelete(item.id)}>
                                <Trash size={18} />
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}

            {!isLoading && isAccepted && !isFrozen && (
              <div className="space-y-4 rounded-lg border p-4">
                <div className="space-y-2">
                  <Label htmlFor="wishlist-title">{t('v2WishlistItemTitle')}</Label>
                  <Input
                    id="wishlist-title"
                    value={form.title}
                    onChange={(event) => updateFormState(setForm, 'title', event.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label>{t('v2WishlistItemPriority')}</Label>
                  <Select value={form.priority} onValueChange={(value) => updateFormState(setForm, 'priority', value as WishlistPriority)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="high">{t('v2PriorityHigh')}</SelectItem>
                      <SelectItem value="medium">{t('v2PriorityMedium')}</SelectItem>
                      <SelectItem value="low">{t('v2PriorityLow')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="wishlist-url">{t('v2WishlistItemUrl')}</Label>
                  <Input
                    id="wishlist-url"
                    value={form.url}
                    onChange={(event) => updateFormState(setForm, 'url', event.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="wishlist-notes">{t('v2WishlistItemNotes')}</Label>
                  <Textarea
                    id="wishlist-notes"
                    value={form.notes}
                    onChange={(event) => updateFormState(setForm, 'notes', event.target.value)}
                  />
                </div>
              </div>
            )}
          </CardContent>

          <CardFooter className="justify-end gap-2 border-t pt-6">
            {isAccepted && !isFrozen && (
              <Button onClick={handleAddItem} disabled={isSaving || !form.title.trim()}>
                {t('v2AddWishlistItem')}
              </Button>
            )}
            {isAccepted && (
              <Button variant="outline" onClick={() => navigate(`/match?token=${encodeURIComponent(token)}`)}>
                {t('v2MatchRevealTitle')}
              </Button>
            )}
          </CardFooter>
        </Card>
      </div>
    </div>
  )
}
