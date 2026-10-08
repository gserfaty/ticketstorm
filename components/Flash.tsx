export default function Flash({ error, notice }: { error?: string; notice?: string }) {
  return (
    <>
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="status">{notice}</p>}
    </>
  )
}
