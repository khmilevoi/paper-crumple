# `@paper-crumple/reatom`: дизайн реактивных моделей

Дата: 2026-09-11. Статус: согласованный дизайн для подготовки плана реализации.
Реализация пакета и изменения существующих пакетов ещё не начаты.
Имена `reatomScene`, `scene.view`, `picture.swap` и `picture.render` отражают
одобренную поверхность DX; полные сигнатуры определяются в плане реализации.

## 1. Цель и границы

Пакет позволяет описывать состояние сцены, работу с изображениями и анимационные
сценарии вне UI. Модели создаются в модуле приложения или фабрике моделей;
React отображает их состояние и передаёт пользовательские события.

В v1 входят модели scene, view, resource и run. Они сохраняют семантику core,
добавляя реактивные данные, команды и наблюдение за ошибками.
Отдельные обёртки SDF, renderers, resamplers, caches, meshes и прочих low-level
ресурсов не входят в v1. Чистые функции вызываются внутри actions/computed.
`core/unstable`, новые SSR-возможности и перестройка всего API библиотеки вне scope.

## 2. Зависимости и общее поведение

`@paper-crumple/react` работает без Reatom; `@paper-crumple/reatom` работает без React.
Основной Reatom entrypoint зависит от core и Reatom, но не загружает paper/motion.
Потребитель передаёт фабрику stage и сам выбирает реализации sheet/motion.
Необходимые специализированные helpers допустимы в опциональных `/paper` и
`/motion` entrypoints; основной entrypoint не реэкспортирует их runtime-код.

Общее framework-free поведение выделяется из существующей orchestration:
создание и завершение ресурсов, acquisition, отмена, актуальность результата,
settlement и правила смены изображения. Его размещение определяется планом;
оно не должно требовать React или Reatom. Не создавать две независимые версии
сложной логики `useCrumple` и не переносить hooks в Reatom механически.

## 3. Модели и владельцы

| Модель | Ответственность | Lifetime |
| --- | --- | --- |
| Scene | Создание stage, общие настройки, ресурсы, context loss, batch-команды | Явный владелец модели до `scene.dispose()` |
| View | Желаемое изображение, применённое состояние, target, команды, render-данные | Стабильная модель; live core View существует между attach/detach |
| Resource | Source/key, загрузка, prepare/replace, доступ к Sprite | Ресурс сцены, может использоваться несколькими views |
| Run | Синхронный запуск/stop, async completion, результат и отмена | Одна операция; завершённый run не возобновляется |

Surface, capabilities, descriptors и defaults доступны как данные сцены.
Sprite принадлежит stage и не получает второго независимого GPU-владельца.
Sheet/motion передаются как slot contracts; stage уже монтирует и освобождает их.
Их фабрики создают новые экземпляры при новом построении stage.

Желаемые source/knobs и реально применённые source/knobs различаются.
Отказ `set`, незавершённый acquire или rollback не превращают желаемое значение
в применённое. Успешное завершение операции и показанное изображение также
различаются: при swap изображение может смениться до завершения всей анимации.

## 4. Одобренный DX

Следующие примеры показывают будущий Reatom API, а не уже доступный пакет.
Фабрики core/paper/motion в примере соответствуют текущему API репозитория.

```ts
// artwork-model.ts
import { action, withAsyncData, wrap } from '@reatom/core'
import { paperStage } from '@paper-crumple/core'
import { paperSheet } from '@paper-crumple/paper'
import { bakedMotion } from '@paper-crumple/motion'
import pack2x3 from '@paper-crumple/motion/packs/2x3'
import { reatomScene } from '@paper-crumple/reatom'

const createStage = (signal: AbortSignal) =>
  paperStage({
    present: 'blit',
    artworkCssPx: 512,
    sheet: paperSheet(),
    motion: bakedMotion({ packs: [pack2x3] }),
    signal,
  })

export const scene = reatomScene({ name: 'artwork.scene', create: createStage })
export const picture = scene.view({
  name: 'artwork.picture',
  source: '/artworks/first.webp',
})

export const nextArtwork = action(async (source: string) => {
  await wrap(picture.swap(source))
  return source
}, 'artwork.next').extend(withAsyncData({ initState: null as string | null }))
```

`picture.swap` — команда orchestration с native async data/error, а не другое
имя для raw `View.swapTo`. Она отвечает за acquisition, актуальность запроса,
анимацию или согласованный reduced-motion путь и публикует успешный результат
только после settlement. Бизнес-действие может вернуть свой payload.

```tsx
// Artwork.tsx
import { wrap } from '@reatom/core'
import { reatomComponent } from '@reatom/react'
import { Crumple } from '@paper-crumple/react'
import { nextArtwork, picture } from './artwork-model'
import { handleActionRejection } from './application-errors'

const LastArtwork = reatomComponent(() => {
  const source = nextArtwork.data()
  return source === null ? null : <p>Последняя завершённая смена: {source}</p>
})

const ArtworkError = reatomComponent(() => {
  const error = nextArtwork.error()
  return error == null ? null : <p role="alert">{String(error)}</p>
})

export const Artwork = reatomComponent(() => (
  <section>
    <Crumple value={picture.render()} style={{ width: 320, height: 480 }}>
      <span>Изображение загружается</span>
    </Crumple>
    <button onClick={wrap(() => {
      void nextArtwork('/artworks/second.webp').catch(handleActionRejection)
    })}>
      Следующее изображение
    </button>
    <LastArtwork />
    <ArtworkError />
  </section>
))
```

`handleActionRejection` — обработчик приложения: завершает rejection-ветку,
распознаёт native cancellation и не создаёт второй async error-store.
Data и error читаются отдельными подписчиками; ошибка команды не требует
подписывать компонент результата на каждое изменение error.
Владелец модели вызывает `scene.dispose()` при завершении своего scope;
обычный unmount `Artwork` только отсоединяет canvas.

## 5. Наблюдаемость core

Core предоставляет лёгкие уведомления о фактических изменениях, включая вызовы
raw core API в обход адаптера. События анимации сами по себе недостаточны:
`show`, `draw`, re-source и переход ожидания target сейчас не покрыты полностью.

Уведомления разделены по областям:

- Scene: готовность/завершение stage, loss, warnings и изменения общих настроек.
- Resource: регистрация/удаление, residency, изменение front/геометрии,
  attachment/pin и применённые настройки.
- View: attachment, показанный Sprite, состояние операции, изменение frame
  после swap/re-source и применённые настройки.
- Run: начало, завершение и отмена; покадровый прогресс выделен отдельно.

Уведомление передаёт идентичность изменившейся сущности и область invalidation,
не полный snapshot сцены. Подписчик перечитывает только нужные getters.
Внутри одной операции согласованные изменения публикуются одной группой после
обновления соответствующих полей. Async settlement — самостоятельная граница.
Это не debounce до следующего кадра: синхронная семантика core сохраняется.

При отсутствии подписчиков не создавать snapshot, копии коллекций и payload
для них. Не обходить все sprites, не вызывать `usage()` на каждую invalidation.
Диагностика usage вычисляется по явному запросу; общий error bus сохраняет
`observed` и `view`, чтобы не дублировать возвращённую ошибку как новую.

## 6. Покадровая реактивность

Прогресс и текущая pose во время анимации доступны по явной opt-in подписке.
Без неё обычные atoms не обновляются каждый кадр и renderer не перерисовывается
из-за каждого `step`. Semantic start/end/parked/settle остаются наблюдаемыми.
Чтение pose по запросу может обращаться к core getter; это не обещание
покадрового обновления обычного computed без подписки на progress.

Progress-подписка не копирует frame geometry. Frame-данные публикуются только
при изменении геометрии/размещения, а не при изменении позы. После удаления
последнего progress-подписчика соответствующий канал прекращает работу;
это не уничтожает View, Sprite или stage.

## 7. Attach, detach и освобождение

Создание модели не создаёт WebGL stage. Инициализация начинается лениво при
attach target либо явной команде работы с ресурсом. Параллельные запросы
одной сцены присоединяются к одному её построению.

В React/blit режиме core владеет своей WebGL surface, а компонент передаёт
2D canvas target. Требование canvas относится к этому режиму; Direct/Hosted
views используют свои rect/framebuffer targets.

Core View привязан к target и после dispose не восстанавливается. Повторный
attach создаёт новый core View внутри прежней модели, готовит ресурс и
применяет сохранённое desired-состояние. На один target действует один владелец.

Detach прекращает live run, освобождает core View, его подписки и attachment
ресурса. Общие stage и sprites сохраняются: другое view может их использовать.
Resource removal и освобождение scene — отдельные действия владельца.
Detach не удаляет чужой Sprite и не закрывает borrowed source.

Вызов анимационной команды без необходимого target даёт явную domain error
до обращения к core play. Команда не ждёт будущий canvas, не ставится в скрытую
очередь и не возобновляется после attach. Уже начатая операция, прерванная
detach/dispose/supersession, завершается cancellation, а не новой user error.

`scene.dispose()` окончательно завершает принадлежащие ей операции и ресурсы.
Поздние результаты не оживляют disposed model; созданные ими ресурсы освобождаются.
Число подписчиков atoms никогда не определяет владение GPU-ресурсами.
Снятие React-подписки на error/data также не завершает сцену.

## 8. Async, ошибки и Run

Команды, сохраняющие результат, используют `action + withAsyncData`: `.data`,
`.error`, `.pending` и lifecycle берутся из native расширения. Не заводить
параллельные вручную обновляемые async loading/error/data atoms.
Состояния domain lifecycle и orphan/context-loss events не являются копией
ошибки async-команды и наблюдаются отдельно либо через производные значения.

На границе адаптера Error-значение core превращается в throw для native async.
`ABORTED` превращается в native abort: не попадает в user error и не публикует
новый successful payload. Нельзя безусловно использовать core `unwrapAsync`,
поскольку его `unwrap` превращает sentinel в `AbortedError`.
Async continuations и внешние callbacks сохраняют Reatom context через wrap/bind.

Raw `view.play/crumpleTo/swapTo` запускаются синхронно и возвращают `Run`.
Низкоуровневая команда модели сохраняет эту синхронность и доступность stop;
native async completion наблюдает `.done`. Не вставлять await перед стартом,
когда исходный core вызов должен сработать в том же user gesture.
Высокоуровневая `picture.swap` может ожидать acquisition по своей семантике.

Для `picture.swap` проектное правило — последний запрос данного view заменяет
предыдущий, без очереди. Native abort должен остановить принадлежащий запросу
actual Run, отменить его собственную работу и запретить позднее визуальное
применение результата. Одного подавления обновлений atoms недостаточно.
Разделяемую загрузку нельзя отменять сигналом одного потребителя; отменённый
потребитель теряет право применить её результат, остальные продолжают ожидание.
Правила reset/очистки `.data` и `.error` остаются native lifecycle расширения,
а не дополнительным протоколом адаптера.

Core `.done` не rejects, но преобразованная Promise адаптера может rejects.
Наличие `.error()` не считать доказательством отсутствия unhandled rejection:
каждый запущенный из UI Promise получает явную rejection-ветку, как в примере.
Обработчики cancellation и stop должны завершать конкретный run, не чужие runs.

`stage.play` возвращает aggregate report с `started/skipped/failed/completed`.
Частичные `failed[]` остаются данными report, не искусственной generic error.
Бизнес-orchestration отдельно решает, как реагировать на частичный результат.

## 9. Источники и React-контракт

Source ownership core сохраняется. Borrowed ImageBitmap принадлежит потребителю;
supplier возвращает fresh bitmap, который закрывает core. URL/Blob/supplier
воспроизводимы; ImageBitmap/image/canvas требуют `pin: true` по контракту core.
Сохранённая модель не обещает восстановить удалённый Sprite из закрытого bitmap:
для восстановления после освобождения нужен пригодный source/re-supplier.

Для `<Crumple>` выделяется минимальный общий render-контракт:
`ref`, `shown`, `frameStyle`. `picture.render()` — computed этого контракта;
callback ref стабилен при обновлениях данных и отвечает за attach/detach.
Renderer не владеет scene и не требует всего интерфейса React hook.
`PaperScene` остаётся существующим React context provider, не обязательным
контейнером Reatom-модели. `useCrumple` и Reatom не управляют одним view одновременно.

## 10. Проверка реализации и производительности

Добавить unit/type проверки моделей, actual-mutation notifications и независимых
импортов. Покрыть attach/detach/reattach, shared sprites, rejected set, отсутствие
target, отмену, supersession, поздние результаты, loss и aggregate reports.
React integration проверяет стабильный ref, отображение минимального контракта,
раздельные data/error subscriptions и отсутствие второго lifecycle-владельца.
GL проверки запускаются существующим последовательным browser harness.

Снять baseline и сравнение CPU/smooth benchmarks для трёх режимов: без
подписчиков, обычные semantic subscribers, explicit frame subscribers.
Отчёт содержит p50/p95 CPU, allocations и стабильность кадров при одинаковой
нагрузке. Структурные требования: нет покадровых публикаций без opt-in, eager
snapshot/geometry copies и полного usage scan на обычном пути уведомлений.
Результаты нужны для приёмки реализации; регрессии требуют исследования.
Числовой performance budget не согласован; измерения пока не проводились.

## 11. Основания

- Core ownership/API: `packages/core/src/stage-types.ts:17`, `stage.ts:133`,
  `stage.ts:1356`, `stage.ts:1561`, `stage.ts:2108`, `stage.ts:2397`.
- Источники и результаты: `packages/core/src/source.ts:5`, `source.ts:229`,
  `run.ts:20`, `unwrap.ts:18`, `events.ts:15`, `sprite.ts:12`.
- Существующее общее поведение: `packages/react/src/acquire.ts:74`,
  `use-crumple.ts:276`, `store.ts:4`, `crumple.tsx:48`.
- Фабрики: `packages/core/src/stage.ts:2414`, `packages/paper/src/sheet.ts:1021`,
  `packages/motion/src/source.ts:135`.
- Проверки: `vitest.config.ts`, `package.json`, `tools/bench/cpu`,
  `tools/bench/smooth`, `docs/level-3-timing.md`.
- [Официальный Reatom async handbook](https://www.reatom.dev/handbook/async/):
  native async data/error, action с сохраняемым результатом, abort/context.
  Использован также vendored handbook Reatom v1001 из установленного skill.
  Reatom ещё не установлен в проекте; installed-версия не подтверждена.
  Перед реализацией требуется выбрать версию и проверить её реальные types.
