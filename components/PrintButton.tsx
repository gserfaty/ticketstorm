'use client'
export default function PrintButton({ label = 'Download PDF' }: { label?: string }) {
  return <button className="noprint" onClick={() => window.print()}>{label}</button>
}
