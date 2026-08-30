/**
 * A width and a height in whatever pixel space the member documents. Field names are `w` / `h`
 * so that §7.4.1's normative reference — `identityResample(source, srcRect, A.w, A.h)`, with the
 * identity condition `A.w === srcRect.w && A.h === srcRect.h` — compiles as written.
 */
export interface Size {
  readonly w: number
  readonly h: number
}

/** An axis-aligned box. Origin conventions are stated by whoever declares the member. */
export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}
