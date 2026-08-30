/**
 * Accepted wherever a pose is (§10.1, amendment 21). The member order is the documentation a
 * hover shows first, which is why the named forms come before the index: raw indices at call
 * sites are the likeliest runtime error in the API, `poseCount` is per-pack, and `play(0, 5)` is
 * correct for the built-in packs and silently wrong for an eight-pose custom one.
 *
 * **`PoseRef` is an input type only.** `'flat'` and `'ball'` resolve to indices on the way in,
 * and everything the library *reports* carries the resolved number: `start.from`, `start.to`,
 * `start.via`, `step.pose` and the `view.pose` accessor are all `number`. That direction rule is
 * what keeps §7.1's `via?: number` correct as written and keeps an event handler from having to
 * switch on `'flat' | 'ball' | number` to learn which pose was drawn.
 */
export type PoseRef = 'flat' | 'ball' | number
