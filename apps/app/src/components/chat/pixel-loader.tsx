import { cn } from "@/lib/utils"

/**
 * A 3×3 pixel grid with a chevron wavefront driving right. The 650ms cycle is
 * shorter than the sweep, so two fronts are always in flight. Cells use the
 * current text colour; reduced motion freezes the grid to its dim state.
 */
const DRIVE_DELAYS = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3)
  const column = index % 3
  return (column + Math.abs(row - 1)) * 90
})

export function PixelLoader({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn("grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]", className)}>
      {DRIVE_DELAYS.map((delay, index) => (
        <span
          key={index}
          className="ow-pixel-cell size-[4px] rounded-[1px] bg-current"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </span>
  )
}
