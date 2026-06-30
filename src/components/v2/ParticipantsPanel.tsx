import { useLanguage } from '@/components/useLanguage'

interface ParticipantSummary {
  id: string
  displayName: string
  wishlistItemCount: number
}

interface ParticipantsPanelProps {
  participants: ParticipantSummary[]
}

export function ParticipantsPanel({ participants }: ParticipantsPanelProps) {
  const { t } = useLanguage()

  return (
    <div className="space-y-3">
      {participants.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t('v2ParticipantList')}
        </div>
      ) : (
        participants.map((participant) => (
          <div key={participant.id} className="flex items-center justify-between rounded-lg border p-4">
            <div>
              <p className="font-medium">{participant.displayName}</p>
              <p className="text-sm text-muted-foreground">
                {participant.wishlistItemCount} wishlist item(s)
              </p>
            </div>
          </div>
        ))
      )}
    </div>
  )
}
