import { LoaderIcon } from "lucide-react"

/** Shown while a route segment's server work is in flight. */
export default function Loading() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="flex items-center gap-2 font-mono text-sm text-muted-foreground">
        <LoaderIcon className="size-4 animate-spin text-primary" />
        <span>Đang tải…</span>
      </div>
    </div>
  )
}
