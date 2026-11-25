# QA и repair: отчёт подэтапа 4.2

24–25 ноября 2026. Подэтап 4.2 реализован и проверен: backend, интерфейс, реальные QA-сценарии и независимые reviews завершены. Основа требований — TECHNICAL_SPEC, устройство — QA_DESIGN, выполнение — QA_PLAN. Ветка codex/qa-repair от aa4b7cf.

## Проверенные сценарии

Новые Start используют clinic-v3. После PM/Architect/CTO и решения автора Backend/Frontend публикуют кандидат, затем worker выполняет Python, независимый HTTP-suite и frontend build. QA сохраняет typed TestReport/Bug и immutable ссылки на проверенную ревизию. Repair добавляет новые задачи и попытки; завершённая история сохраняется.

| Сценарий | Вызовы test provider | QA-циклы | ToolRun | Реальный HTTP | Repair Tasks |
|---|---:|---:|---:|---|---:|
| standard | 6 | 1 | 3 | passed, revision 3 | 0 |
| repair_success | 8 | 2 | 6 | failed v4 → passed v5 | 1 |
| repair_blocked | 10 | 3 | 9 | failed v4/v5/v6 | 2 |

Каждый red содержит фактический результат двух конкурентных HTTP-запросов `[201, 201]`. Хорошая repair возвращает защиту слота; следующий неизменённый suite проходит. После initial и двух недостаточных repair третья repair не создаётся: run блокируется с причиной. После green границей остаётся DevOps/preview.

Сводка фактических результатов отдельных прогонов:

```text
QA verified: standard       calls=6  cycles=1 tools=3
QA verified: repair_success calls=8  cycles=2 tools=6
QA verified: repair_blocked calls=10 cycles=3 tools=9
All 3 real scenarios audited; 6 distinct SQLite roots; no external calls.
```

Локальные доказательства: [standard](../.data/reports/qa-1795541721565/standard/snapshot.json), [red→green](../.data/reports/qa-1795541963455/repair_success/snapshot.json), [два repair](../.data/reports/qa-1795542391255/repair_blocked/snapshot.json), [аудит всех сценариев](../.data/reports/qa-retained-audit.json). Там сохранены ToolRun, полные HTTP-отчёты, Candidate/manifest hashes и события. Эти файлы исключены из Git и остаются на машине автора.

Аудит повторно сверил SHA-256 исходников, parent hashes и manifest инъекции 3→4, шесть отдельных SQLite roots, непрерывность событий, ToolRun/report/Task pins, количество repair и сохранность файлов frontend. Чтение событий не создало новых вызовов. Frozen profile/schema/template/acceptance suite не изменены.

`npm run test:qa` создаёт отдельную PostgreSQL test-schema и Python-процесс для каждого сценария. Первый составной прогон обнаружил конфликт с правилом одного активного run после успешного red→green; harness исправлен без ослабления этого правила. Отдельный blocked-прогон прошёл; orchestration новых схем проверена независимым reviewer. Исторические данные не удаляются.

## Границы доказательств

TestReport.status — результат трёх инструментов. REQ-006/008 в карте требований остаются `not_verified`: сборка не доказывает поведение UI или работающий preview. При общем HTTP-red отсутствует структурированный исход каждого требования; QA не приписывает неизвестную причину отдельному пункту. Дополнительные тесты помечены `proposed`.

Доверенная defect injection сохраняется одной транзакцией с событием и новой ревизией. Это system/test fixture без фиктивной LLM-попытки. Прикладные файлы test_injected и вызовы test provider не являются Live-генерацией. Старые clinic-v1/v2 сохраняют прежние границы и receipts.

Runner — process_only, только доверенный учебный кандидат, до 180 секунд на инструмент. Это ограничения процессов/команд/окружения/вывода, а не изоляция враждебного кода от файлов и сети пользователя. В фактических прогонах HTTP занимал 113–171 секунду под нагрузкой; успешный прогон не является гарантией скорости на другой машине.

Инфраструктурные/unknown исходы, повреждение hashes, устаревшие leases и pytest exit codes 2–5 блокируют QA без Bug/repair/фиктивного green. Лимит repair 0/1/2 проверяется отдельно. Общий бюджет времени проверяется до claim/dispatch, во время исполнения и анализа QA; фактический ToolRun сохраняется при блокировке цикла. Лимит LLM-вызовов синхронно блокирует Task/Run/Cycle/Agent. Неожиданный HTTP-red в standard допускает repair обычным fixture без defect injection. Эти случаи исправлены через RED→GREEN и одобрены spec/quality reviews.

## Проверки backend

Финальный полный прогон после всех review-исправлений:

```text
npm run test:backend
572 passed in 587.93s (0:09:47)
exit 0
```

Локальный вывод — [qa-final-backend.log](../.data/reports/qa-final-backend.log). Все БД-тесты используют отдельную codehead_test с новыми schema. Reviews fixtures/backend одобрены после RED→GREEN: инфраструктурные exit codes, изменённые ссылки/JSON/hash, preclaimed ToolRun, prior Bug и границы бюджета не дают фиктивного успеха.

## Интерфейс и браузер

```text
npm run check
All checks passed! / 85 files already formatted / Contracts are in sync.
Test Files 33 passed (33)
Tests 370 passed (370)
npm run build: exit 0
```

Вывод: [check](../.data/reports/qa-final-check.log), [build](../.data/reports/qa-final-build.log). Сохранились предупреждения Three CJS/Clock и большого графического chunk; этот подэтап не заявляет оптимизацию всей сцены или измеренные 60 FPS.

В первоначальном worker-прогоне прошли три candidate-сценария, два Runner и настоящий red→green QA с reload/source/repair. Мобильный тест выявил неправильный exact label-локатор; worker-тест исчерпал общий бюджет 60 секунд после навигации и снимков. Trace подтвердил обычную running Frontend-попытку, а не отказ кандидата. Исправлены локатор роли с ограниченным focus и общий бюджет только этого длинного теста 120 секунд; ожидание кандидата осталось 30 секунд. Прерванный прогон не считается полностью успешным.

```text
Повтор mobile QA + worker: 4 passed (2.6m)
Базовый прогон без worker: 12 skipped / 23 passed (5.7m)
Два Start-сценария с готовым worker: 2 passed (39.0s)
```

Все 35 сценариев проверены: 23 базовых и 12 с worker; условно пропущенные в базовом прогоне 12 выполнены отдельно. Логи: [первый worker-прогон](../.data/reports/qa-final-worker-e2e.log), [повтор четырёх](../.data/reports/qa-final-worker-rerun.log), [базовые](../.data/reports/qa-final-standard-e2e.log), [два Start](../.data/reports/qa-final-start-e2e.log). Все использовали отдельные test schemas; пользовательская база не очищалась.

Визуальный reviewer запросил один компактный последний итог над историей: после red v4 успешный v5 был ниже первого viewport. Правка прошла RED→GREEN, последняя версия/статус и действие отчёта подтверждены на сохранённых реальных API-данных без новых LLM/Runner. [Desktop 1366](../.data/reports/e2e-1795545574191/results/quality-preserves-real-rep-5de6c-and-task-links-after-reload/quality-history-1366.png), [HTML fallback 430](../.data/reports/e2e-1795624661805/results/quality-offers-default-v3--740f1-at-430px-with-HTML-fallback/quality-fallback-430.png). После тестовой отмены QA-результаты сохраняются в истории. Verdict `ship` подтверждает именно это исправление; мир фабрики не перерабатывался. Однократный detector не нашёл замечаний в новых QA-элементах; 11 прежних advisory остаются вне scope.

## Локальный запуск и следующая граница

После прерывания PostgreSQL штатно восстановился через fsync/WAL; данные .data/postgres сохранены. Основной dev перезапущен: API health.status=ok, stage=worker, command_security=ready; QA available, preview planned, Live disabled; UI отвечает HTTP 200. Старый clinic-v2 run остаётся доступен, автоматические QA-циклы задним числом не добавлены.

Следующий подэтап 4.3 — DevOps и preview отдельного origin. Live и replay UI остаются отдельной работой. Порядок Git — GIT_WORKFLOW; отчёты .data не входят в commit.
