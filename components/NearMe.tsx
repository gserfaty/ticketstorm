'use client'
import { useRouter } from 'next/navigation'
import { setCityByCoords } from '../app/actions.ts'

export default function NearMe() {
  const router = useRouter()
  return (
    <button type="button" onClick={() =>
      navigator.geolocation?.getCurrentPosition(async (p) => {
        await setCityByCoords(p.coords.latitude, p.coords.longitude)
        router.refresh()
      })}>Use my location</button>
  )
}
