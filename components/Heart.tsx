import { isFavorite } from '../lib/favorites.ts'
import type { FavKind } from '../lib/favorites.ts'
import { getUser } from '../lib/session.ts'
import { toggleFav } from '../app/favorites/actions.ts'

// Favorite toggle. Works with no JS (plain form post); guests are sent to log in by the action.
export default async function Heart({ kind, id, label }: { kind: FavKind; id: number; label: string }) {
  const user = await getUser()
  const on = !!user && isFavorite(user.id, kind, id)
  return (
    <form action={toggleFav} className="heart">
      <input type="hidden" name="kind" value={kind} />
      <input type="hidden" name="ref" value={id} />
      <button aria-pressed={on} aria-label={`${on ? 'Remove' : 'Add'} ${label} ${on ? 'from' : 'to'} favorites`} title={on ? 'Favorited' : 'Favorite'}>{on ? '♥' : '♡'}</button>
    </form>
  )
}
