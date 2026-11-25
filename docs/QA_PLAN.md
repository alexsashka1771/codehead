# QA и repair: план подэтапа 4.2

Исполнение: test-driven-development и subagent-driven-development с независимыми spec/quality reviews. Ветка codex/qa-repair от проверенного Runner. Git — GIT_WORKFLOW. Направление автора продолжено без платных API/локальной модели.

## 1. Доверенные test fixtures

Файлы: profiles/clinic_demo/v1/fixtures/defects/clinic_storage.py, codehead/clinic/quality_fixtures.py, тесты test_quality_fixtures.py; независимый suite не меняется.

- [x] RED: normal backend сохраняет UNIQUE; defect check-then-insert даёт два HTTP успеха при конкуренции; версии fixture и hashes фиксированы, repair_success/две insufficient repair различимы.
- [x] Generic синхронизация только versioned test defect; complete storage fixture и loader с bounded UTF-8/reparse/path verification. Agent не пишет fixtures/suite.
- [x] GREEN: настоящие конкурентные HTTP и неизменённый frozen suite для defect/good.

## 2. Workflow, QA и состояние

Файлы: contracts.py, models.py, migration0007_quality.py, workflow/quality_service.py, worker_service.py/worker.py/publication.py, persistence/service.py/tools.py/candidates.py, llm/provider.py/test_provider.py/quality_provider.py; тесты test_quality_workflow.py/test_quality_provider.py.

- [x] RED: v3 default/v1-v2 compatibility+receipt hash, quality_cycles=[]; standard/repair_success/repair_blocked, pins, immutable tasks, limit0/1/2, stale results/control/unknown.
- [x] DTO QualityCycle/TestReport/Bug и test scenario; три auto ToolRun, immutable summaries, QA input/output validation и фактическое testing состояния. Raw trace/result остаются после redaction.
- [x] Атомарная system injection после исходного кандидата, версии/hash/provenance, публикация новой revision.
- [x] Failed gate создаёт новые Backend/QA Tasks; green блокирует только DevOps/preview; третий repair запрещён. Инфраструктурные отказы явно блокируют и не объявляются содержательными Bug/green.
- [x] GREEN: целевые PostgreSQL/provider tests, contracts generation/check. Spec/quality reviews закрыли budget claim/begin/running/analysis, standard repair и гонку заранее захваченного ToolRun.

## 3. UI и проекция

Файлы: useWorkspace/RunPanel/App, QualityPanel/Inspector/WorkerDetails, projection и fixtures/unit tests, tests/e2e/quality.spec.ts.

- [x] RED: выбор scenario входит в command/key; старый v2 не получает новый QA, foreign/historical cycles/pins/tasks/tool/report refs; snapshot == events и поздние ответы.
- [x] Панель циклов/ToolRun/TestReport/Bug и repair-итераций, реальные роли/status, явный test_injected и предложенные проверки; нет ready preview/Live.
- [x] GREEN: frontend tests/type/build и E2E с реальным QA, reload, 430px/fallback/keyboard; старые проверки выбирают explicit v2 там, где проверяют старую границу. Последний итог QA добавлен перед хронологией и подтверждён визуальным verdict `ship` на 1366/430 px.

## 4. Проверка и передача

- [x] Отдельный QA harness: standard green, настоящие red→green и initial+2 red; отдельная PostgreSQL schema на сценарий, свежая SQLite, hash suite/candidate pins, Task/attempt/repair counts без новых вызовов от replay. Дополнительный аудит сохранённых трёх отчётов проверил шесть независимых SQLite roots и цепочку инъекции без повторных внешних вызовов.
- [x] Независимые spec/quality reviews; исправления замечаний через RED→GREEN.
- [x] backend/check/build, QA harness и применимые E2E; сохранить фактические логи. Backend 572, frontend 370, 23 базовых и 12 worker E2E подтверждены.
- [x] README/IMPLEMENTATION_PLAN/ROADMAP/CHANGELOG/QA_REPORT; следующий шаг DevOps/preview4.3, без объявления live готовым.
- [x] Проверенный перезапуск своего dev/health без очистки БД. QA available, Live disabled, preview planned, UI HTTP 200; старый v2 доступен.

Git завершает проверенный подэтап: guard/staged diff, commit/push и сверка удалённого SHA по GIT_WORKFLOW. Фактический результат этих команд фиксируется в итоговом сообщении чата; локальные отчёты .data не публикуются.
