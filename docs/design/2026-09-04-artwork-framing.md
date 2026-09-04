# Artwork framing in the playground — design consultation

- **Date:** 2026-09-04
- **Subject:** how the playground's hero canvas should be framed so that the *artwork* holds
  still on screen for every knob while the paper is allowed to overflow past it; whether the
  reconstruction in `examples/playground/src/framing.ts` is the right shape; the un-frozen
  overscan reserve in `packages/paper/src/sheet.ts`.
- **Status:** accepted, being implemented (steps 1–3 below, in that order).
- **Resolution recorded after the consultation:** the reserve is frozen under reading (i) —
  the factory's defaults plus `overscanHeadroom`, scaled by the sprite's aspect — which is what
  `build()`'s `checkReserve` already compared against. See the "Reserve" section of the
  implementation notes at the end of this file.

The consultation below is reproduced verbatim (it was written in Russian, per the session's
chat-language rule; identifiers and `file:line` citations are as they were).

---

## Вердикт

**Гипотеза пользователя верна по форме и неверна по букве.** Строго «без вычислений» недостижимо по конструкции: `<canvas>` рисует только внутри собственного бокса, поэтому «бумага за пределами картинки» означает канвас *больше* картинки на величину, которую знает только библиотека. Нижняя граница — один прямоугольник, прочитанный у библиотеки, и четыре умножения (ровно так позиционируют любой `<img>`‑оверлей). Но «без реконструкции» — да, достижимо, и именно реконструкция и есть неправильная форма текущего дизайна.

## Где текущий дизайн неверен по форме

Всё в `framing.ts` восстанавливает в потребителе значение, которое библиотека уже вычислила и выбросила:

1. Что реально показывает канвас — не «front» и не `sheetCover`. Это окно `sheetW × sheetH` текселей фронта, **центрированное на центре `SheetFront.rect`** (paper box) и растянутое в `dest` одним масштабом `k = min(dest.w/front.w, dest.h/front.h)` — `packages/motion/src/source.ts:579-590`, `:641-647`. Артворк внутри лежит в `placement = artworkPlacement(size, handle.artwork)` — `packages/paper/src/sheet.ts:316-323`, `:1180`. Эмпирическая модель из брифа («бокс `frontSize·k`, центрированный на центре `Sprite.rect`») — это в точности эта формула. Оба числа библиотека знает; ни одно не публично.
2. `sheetCover` воспроизводит `fitSheet` (`packages/motion/src/buckets.ts:208-242`) от `Sprite.rect`, но `rect` — живой геттер `handle.rect` (`packages/core/src/stage.ts:1295`), а `fit` заморожен на `add()` и не трогается в `resource()` (`stage.ts:556-559`: «The record's fit and clip stay»). `held`‑size — костыль под дрейфующий вход.
3. `surfaceCover` (`framing.ts:89-95`) — второй дубликат правила размещения из motion, для `direct`.
4. `measureSource` — второй декод ради `srcW/srcH`, которые лежат в `PaperSheetHandle.srcW/srcH` (`packages/paper/src/handle.ts:43-44`).
5. `k = srcW / artwork.w` — единственный масштаб, и он константа *только* пока резерв заморожен (см. Q3). Текущий дизайн молча на это опирается.

Пункты 2–5 исчезают целиком при одном аксессоре. Пункт 1 говорит, какой именно.

## Q1. Библиотечная «computation‑free» рамка

Три кандидата:
- **View‑режим / fit `'artwork'`** — невозможен без того, чтобы библиотека владела layout'ом. Под `managed` она пишет только backing store из `getBoundingClientRect()` (`packages/core/src/blit.ts:75-113`), элемент — потребителя (§4.6, `view.ts:76-78`). Канвас нужно *увеличить и сдвинуть* CSS'ом — это layout, и это правильно оставить потребителю.
- **Центрировать mesh на артворке, а не на paper box** (изменить `fcx/fcy` в `source.ts:588-589`). Убрало бы трансляцию при hull‑tier, но не масштаб (`k`) и не размер канваса (меняется при edge‑mode/bucket/sample); это изменение семантики рендера ради демо. Не сейчас.
- **Аксессор** — единственная формулировка, которую я бы выбрал.

## Q2. Одна формулировка: `View.frame`

`Sprite.rect` и `Sprite.frontSize` не «неправильные», они отвечают на другие вопросы (`rect` — коробка бумаги для hit‑testing/раскладки *вокруг бумаги*; `frontSize` — для `size: 'manual'`, amend. 13). Просто ни один не говорит, где артворк. Недостающее значение — **прямоугольник артворка в боксе, куда view рисует**:

```ts
/** View: бокс, в который рисуется лист, и где в нём лежит неподбитый артворк — в пикселях бокса. null без резидентного фронта. */
readonly frame: { box: Size; artwork: Rect } | null
```

Производится в core, в `createViewObject` рядом с `idealSize` (`stage.ts:1283-1285`), из уже существующего:
- `dest = targetFor({w: front.width, h: front.height}).dest` — для blit это бокс фронта (`stage.ts:757-769`), для `{ rect }` — сам rect (`stage.ts:737-739`). Это закрывает `direct` без отдельной ветки.
- `front.rect` — центр окна (`sheet.ts:1383-1388`).
- **новое** `SheetFront.artwork: Rect` — `placement` из `build()` (`sheet.ts:1180`), sibling к `SheetFront.rect` в `packages/core/src/sheet.ts:26-33`.

```
k   = min(dest.w / front.width, dest.h / front.height)
fcx = front.rect.x + front.rect.w / 2      (fcy аналогично)
artwork = { x: dest.w/2 + (front.artwork.x − fcx)·k,
            y: dest.h/2 + (front.artwork.y − fcy)·k,
            w: front.artwork.w·k, h: front.artwork.h·k }
box = { w: dest.w, h: dest.h }
```

Потребитель — весь `frameHero`:

```
s      = cssPx / max(a.w, a.h)
slot   = a.w·s × a.h·s
canvas = box.w·s × box.h·s ;  left = −a.x·s ;  top = −a.y·s
```

Никаких пространств координат, `present`, декода, held‑size. Триггеры остаются ровно ваши: mount, `step` (swap), а после hull‑tier — `await stage.prepare(key)` → прочитать → `refresh()`. Это правильно: `prepare` — единственный demand, который ждёт in‑flight re‑source (`stage.ts:1458-1470`), а `resource()` сам обновляет idle view (`stage.ts:615-617`).

Стоимость: одно поле в контракте `SheetFront`, одна строка в paper, ~15 строк геттера + тесты. Единственная честная оговорка — core дублирует правило размещения из `source.ts:579-590`; но core *уже* зависит от него (комментарий `stage.ts:757-766`), так что это не новая связь. Чистая по слоям альтернатива — motion возвращает `placed: Rect` в `DrawResult` (`packages/core/src/forward.ts:45-50`) — требует draw и больше проводки; не для первого шага.

Почему `View`, а не `Sprite`: под blit `k = 1` и это функция `SheetFront`, но под `{ rect }` — нет; §4.2 определяет View как «a place on the screen».

«Front's box in source px» как альтернативу отклоняю: канвас центрирован на paper box, а не на фронте. Асимметрия реальна — на camel‑coat центр `Sprite.rect` по x = 425.5 при центре картинки 460, и он не меняется при `minDist`, а по y плывёт 694.5 → 711. С таким геттером `recentre` по `Sprite.rect` останется.

## Q3. Резерв — настоящий баг

Да. `source()` берёт `values = valuesFor(o.knobs)` — живой hull‑tier, **включая `maxDist`** — `edgeParams = edgeParamsFrom(edgeMode, values)` (`sheet.ts:812-813`) и скармливает это `freezeOverscan(edgeParams, overscanHeadroom, srcH/srcW)` (`sheet.ts:823`). `maxDist` одновременно член hull‑tier (`packages/paper/src/paper-knobs.ts:209-215`) и главный член `r_hull` (`packages/core/src/overscan.ts:75`). Док‑комментарий `valuesFor` («Nothing else in source() may follow the live knobs. The reserve … frozen at add()») это отрицает; комментарий step 4 в `build()` (`sheet.ts:1130-1135`, «the same freezeOverscan(...) that source() freezes onto every handle») ложен дважды — живые значения и h/w‑масштаб. Спека — `docs/superpowers/specs/2026-08-26-paper-crumple-packages-design.md:2166-2167`. Отсюда 107 → 71 → 33.

**Фикс** — одна строка в `:823`: `freezeOverscan(edgeParamsFrom(edgeMode, defaultsFor(edgeMode)), overscanHeadroom, srcH / srcW)`; живые `edgeParams` оставить для трассировки/`reach`/`beyond`. Тогда `p`, `artwork`, `k` — функция (mode, defaults, headroom, aspect), и `maxDist` ведёт себя как `minDist`: двигается только `frontRect`.

**Про «checkReserve не может сработать» — вы неправы.** `sheet.ts:1153` сравнивает *фабричный* резерв (radius = (72+12)·1.25 = 105 для hull) с живыми `knobValues`, и `rebuildFront` вызывает `build()` до всякого re‑source (`stage.ts:513-522`; step 4 раньше step 6 `hullChanged` на `:1237`). При `maxDist > 93` «re‑add required» уже сейчас уходит в `p.policy.orphan` (`stage.ts:493-494`) → в плейграунде это `observed('stage error event')`. Если вы наблюдали re‑source при 140 — перепроверьте измерение; по коду это недостижимо. Фикс не трогает ни этот порог, ни `add()` (там тот же step 4, `stage.ts:1272-1279`).

**Что ломается.** Сейчас в диапазоне ≤ 93 re‑source молча выкупает место, сжимая артворк — это «silent clamp» из §8.6 в другом костюме. После фикса запас честно фиксирован headroom'ом, и второй потолок — guard band (`overscan.ts:36-39`, 0.482; `source()` step 9) — на замороженном x‑margin ≈ 105 ref px для портретных сэмплов, скорее всего, сработает *раньше* 93 (по моей оценке в районе 80–93; нужно измерить). `overscanHeadroom: 0.25` диапазон 0..140 **не покрывает**: для 140 нужен radius 152 → headroom ≥ 0.81, ценой разрешения `A = maxSize/1.84` вместо `/1.46` на 2:3‑сэмплах. Выбор для демо: поднять headroom, сузить слайдер, или показывать «re‑add required» в пилюле как демонстрацию контракта §8.6. Последнее честнее всего.

## Q4. Порядок

1. **`paper`: фикс резерва** (`sheet.ts:823` + тест «два `source()` при разных `maxDist` дают одинаковые `artwork`/`overscan`»). Первым и отдельно — это spec‑conformance баг, независимый от демо, и без него *никакая* рамка, включая вашу текущую, не пришпилит `maxDist`.
2. **`core` + `paper`: `SheetFront.artwork` и `View.frame`** с тестами на blit и `{ rect }`.
3. **Демо**: удалить `sheetCover`, `surfaceCover`, `recentre`, `measureSource`, `held`, `coverFor`, refs `coverRef/sourceRef/pendingRef`; `frameHero` — пять строк над `view.frame`; три триггера оставить.

Не делать: менять центрирование в motion; оставлять арифметику в демо как постоянное состояние; добавлять layout‑owning режим. Если демо нужно отгрузить раньше шага 2 — текущий дизайн допустим как временная мера *только* вместе с шагом 1 и с пометкой «реконструкция, удалить».

Файлы: `C:\Users\Khmil\JsProjects\paper-crumple\examples\playground\src\framing.ts`, `…\examples\playground\src\stage.ts`, `…\examples\playground\src\useStage.ts`, `…\packages\core\src\stage.ts`, `…\packages\core\src\sheet.ts`, `…\packages\core\src\blit.ts`, `…\packages\core\src\overscan.ts`, `…\packages\paper\src\sheet.ts`, `…\packages\paper\src\handle.ts`, `…\packages\motion\src\source.ts`, `…\packages\motion\src\buckets.ts`.

---

## Implementation notes (2026-09-04, after the consultation)

### Reserve: reading (i), and why

Spec 8.6's sentence — "overscan is derived per sprite from its edge parameters and frozen at
`add()`" — admits two readings:

- **(i)** the reserve is the factory's defaults plus `overscanHeadroom`, scaled by the sprite's
  aspect. This is what `build()`'s step-4 `checkReserve` already compared against.
- **(ii)** the reserve is the sprite's own knob values at its first `add()`, remembered and re-used
  on every re-source. This is the literal reading, and what the old prose at `PaperSheet.overscan`
  described.

**(i) is implemented.** (ii) is not implementable by `source()` as the contract stands: a hull-tier
write re-runs `source()` (spec 6.3), `source()` has no memory of an earlier handle, and its sprite
key is minted per bitmap object — a re-supplied bitmap is a new object. Carrying the first reserve
across would need a new `SourceOptions` field, a `radius` on the handle, and `checkReserve`
re-pointed at the handle; none of that buys the playground or a consumer anything the headroom
does not, and spec 8.6's own consequences list names `overscanHeadroom` as the mechanism for live
slider room. Under (i) `source()` and `build()` finally agree, the radius is deterministic in
(mode, defaults, headroom), and the only per-sprite term is the `h / w` scale on the fraction `p`.

The change is `packages/paper/src/sheet.ts`: `reserveParams` hoisted next to the factory `reserve`,
`source()`'s step 1 takes `freezeOverscan(reserveParams, overscanHeadroom, srcH / srcW)` instead of
the live `edgeParams` (which still drives the trace, `reach` and `beyond`). The prose that became
false was rewritten: `PaperSheet.overscan`'s doc comment, `valuesFor`'s, and `build()`'s step-4
comment. GL test: "freezes the reserve at the factory defaults: a re-source at another maxDist keeps
p and A" in `sheet.gl.test.ts`.

Consequence, measured: in `hull` at headroom 0.25 the reserve radius is `(72 + 12) × 1.25 = 105`
reference px, so `maxDist ≤ 93` is accepted and 94+ is "re-add required"; in `both` the same
headroom over the larger default radius accepts up to about 117. Both refusals now reach the
status pill (see below).

### Public API added

- `SheetFront.artwork: Rect` (`packages/core/src/sheet.ts`) — the unpadded artwork's box in the
  built front. `paperSheet().build()` reports its `placement`. Required on the contract; every
  slot and test fake in the family reports it. Recorded in `.changeset/artwork-frame.md`.
- `View.frame: ViewFrame | null` (`packages/core/src/view.ts`, `stage.ts`) — `{ box, artwork }`
  in the drawn box's pixels, artwork measured from the box's top-left, y down; `null` without a
  resident front. Derived from `targetFor(front).dest`, `front.rect` and `front.artwork` by the
  motion slot's placement rule. Tests in `view.test.ts`: null before show, blit box, off-centre
  paper (`fakeSheet({ paperRect })`), `{ rect }` scaling.
- `ViewFrame` exported from `@paper-crumple/core`; `docs/USAGE.md` gained the paragraph.

### Playground

`framing.ts` is `frameArtwork(frame, cssPx)` — four multiplications — with four unit tests.
`stage.ts`'s `frameHero({ view, slot, canvas, cssPx })` reads `view.frame`; `measureSource`,
`coverFor`, `sheetCover`, `surfaceCover`, `recentre`, the held size and the `MountedHero.cover /
source` fields are gone. `useStage.ts` keeps the three triggers (mount; a swap's `step`; `await
stage.prepare(key)` after a hull-tier write) and drops `coverRef / sourceRef / pendingRef` and
`prepareFrame`; `reframe()` takes no URL. `App.tsx` follows.

**The silent refusal is fixed.** A front-class `stage.set()` on an idle view rebuilds synchronously
inside the call (`stage.ts` `invalidateSprite`, §8.8 demand 3); a refused rebuild is an orphan
(§10.6) that reaches the pill through `stage.on('error')` _before_ `set()` returns `undefined`, and
`setKnob` then wrote "`key` set" over it. `useStage` now counts observed errors across the call and
leaves the error line standing (and skips the pointless `prepare` join) when one arrived.

### Live verification (`http://localhost:5180`, Chrome, dpr 1.5)

Method: the canvas's pixels read back, a saturation mask `S = (max − min) / max > 0.18` on pixels
with alpha ≥ 8, the bbox converted to CSS px and quoted **relative to the `.stage-frame` slot's
top-left**. Sample `photo — camel wool coat` (920×1380), `cssPx` 360, `overscanHeadroom` 0.25,
`present: blit`. Each write was followed by a wait for the pixels to settle.

**`hull`** — slot `240 × 360` throughout; canvas `323.1 × 439` throughout (the fit is frozen at
`add()`), its offset moving with the paper (between −35.9…−44.1 across, −29.7…−47.2 down):

| knob         | values                   | artwork bbox (w × h @ +x,+y)                                                                                                                                                              |
| ------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `minDist`    | 22 / 0 / 50 / 80 / 22    | `123.1 × 331.3 @ +63.6,+12.3` on all five                                                                                                                                                 |
| `maxDist`    | 72 / 40 / 100 / 130 / 72 | 72, 40, 72: same; 100 and 130 **refused**, pill reads "edge knobs need 112.0 / 142.0 reference px of margin but this sprite reserved 105.0 at add() — re-add required…", bbox unchanged |
| `angularity` | 0.7 / 0.1 / 1 / 0.7      | same on all four                                                                                                                                                                          |
| `seed`       | 3 / 11 / 42 / 3          | same on all four                                                                                                                                                                          |

**`both`** — slot `239.3 × 360`, canvas `699.9 × 809.4` throughout:

| knob         | values                   | artwork bbox                                                                        |
| ------------ | ------------------------ | ----------------------------------------------------------------------------------- |
| `minDist`    | 22 / 0 / 50 / 80 / 22    | `120.7 × 333.2 @ +64.9,+11.2` on all five                                           |
| `maxDist`    | 72 / 40 / 100 / 130 / 72 | 72, 40, 100, 72: same; 130 **refused** ("need 241.2 reference px…"), bbox unchanged |
| `angularity` | 0.7 / 0.1 / 1 / 0.7      | same                                                                                |
| `seed`       | 3 / 11 / 42 / 3          | same                                                                                |

The 0.7 px slot difference and the ~2 px bbox difference between the two modes come from the
artwork being resampled at a different `A` per mode (a different frozen `p`), i.e. from the front,
not from the framing. A long error line on the pill wraps and pushes the whole stage down; the
slot-relative numbers are unaffected.

**Samples** (in `both`): slot against `cssPx × source aspect`:

| sample     | natural  | expected slot | slot        |
| ---------- | -------- | ------------- | ----------- |
| sweater    | 640×593  | 360 × 333.6   | 360 × 334.1 |
| trench     | 432×640  | 243 × 360     | 242.2 × 360 |
| jeans      | 438×640  | 246.4 × 360   | 245.6 × 360 |
| sneakers   | 531×271  | 360 × 183.7   | 360 × 183.9 |
| avatar     | 433×768  | 203 × 360     | 204.1 × 360 |
| camel coat | 920×1380 | 240 × 360     | 239.3 × 360 |

The ≤ 1 px residue is the artwork's short side rounded to whole texels (`dimsForLongSide`).

**Edge mode** on the avatar: Hull `203.5 × 360` / Torn `203 × 360` / Both `204.1 × 360` /
Hull again `203.5 × 360`; camel coat back in hull: `123.1 × 331.3 @ +63.6,+12.3`, identical to the
first table. (In `torn`/`both` the saturation mask on the avatar catches the tinted torn edge, not
only the figure — a limit of the mask on that sample; the slot is what the check is about.)

**Swap**: camel coat → sneakers: status "swapped to sneakers", slot `360 × 184`, bbox
`273.8 × 70.2 @ +40.9,+47.1` — identical to sneakers mounted as the sample in `hull`. Swap to the
broken URL: "swap failed, rolled back to the previous sprite: could not decode …", every box
unchanged. (For sneakers the canvas, `341.3 × 190.2`, is _narrower_ than the slot: the PNG has
transparent padding, so the paper box is smaller than the picture's full box — correct.)

**Fold / Unfold** (blit, sneakers): canvas `341.3 × 190.2`, backing store `384 × 214`, unchanged at
every pose; bbox `null` at pose 5 and back to `273.8 × 70.2 @ +40.9,+47.1` at pose 0.

**`present: direct`** (sneakers): slot `360 × 184`; canvas is the square surface, `341.3 × 341.3`
(store 512×512). The plain mask reads the paper's outline there (a `premultipliedAlpha: false`
surface fringes through `drawImage`), so the artwork was measured on fully opaque pixels only:
`272 × 69.3 @ +42.7,+47.6` against blit's `273.8 × 70.2 @ +40.9,+47.1` — the same place to within
the resampling of a 512 square into 341 CSS px. A screenshot with the slot outlined confirmed it.

### Gates

`pnpm typecheck` clean; `pnpm lint` clean; `prettier --check .` clean (this also reformatted the
already-modified `examples/playground/README.md`); `vitest run --project unit --project types`:
138 files, 1412 tests; `pnpm test:gl`: 26 files, 193 tests, run again after the last edit.

## Addendum (2026-09-04, later): resolution

The framing above pins the artwork at `cssPx` CSS px, but the library built the artwork at
`A = maxSize / (1 + 2p)` texels with `maxSize = min(512, cssPx x dpr rounded to 64)` and `p`
scaled by the sprite's `h / w` — so every sample was upscaled on screen: sweater 1.33x, avatar
1.68x in `hull` at dpr 1.5 (5x in `both`). The sneakers numbers in "Fold / Unfold" show it: canvas
`341.3 x 190.2` CSS is the `384 x 214` front at `360 / 405`, and the store equals the front.

Resolution: (1) `paperSheet()` reserves the margin per axis in texels (`ceil(p x A.h)` on every
side), so `A` no longer depends on aspect and `PaperSheetHandle.overscan === sheet.overscan`;
(2) the playground builds its stage with `artworkCssPx: 360` — a new `paperStage` option that asks
the sheet for `ceil(360 x dpr)` artwork texels and sizes the surface for them — instead of
`cssPx`, which means the *paper's* box; (3) the front cap is 2048 texels. Under blit,
`view.frame.artwork`'s long side now equals `ceil(360 x dpr)` for every sample and the backing
store equals the canvas's CSS box times `dpr`. Known limitation kept: `exact: true` under
`present: 'blit'` still overflows the surface; a follow-up grows the blit surface to the front.
