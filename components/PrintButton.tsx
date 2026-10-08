'use client'
export default function PrintButton() {
  return <button className="noprint" onClick={() => window.print()}>Download PDF</button>
}
