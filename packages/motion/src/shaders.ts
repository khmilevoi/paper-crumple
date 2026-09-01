/**
 * The 3D sheet program (§3.1). `motion` owns its shader because the pack carries oct-encoded
 * normals, one AO byte per vertex and a per-frame `alphaFloor`, and the fragment shader is
 * written against exactly those attributes.
 *
 * Task 2 fills in `ATTR`, `SHEET_VS` and `SHEET_FS`.
 */

/** The six debug views (`material.js:14`). Knob *values*, so the space in 'sheet alpha' is legal. */
export const DEBUG_VIEWS = ['composite', 'normals', 'ao', 'uv', 'sheet alpha', 'facing'] as const
