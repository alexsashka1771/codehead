# Кандидат Clinic Demo: план реализации

> Исполнение: test-driven-development и subagent-driven-development с независимыми spec/quality reviews. Автор разрешил продолжить согласованный этап и позже поручил ведение Git; актуальный порядок — GIT_WORKFLOW.md. Первичный main отделён от незавершённых fixtures.

**Цель:** новый test run создаёт проверяемую версию Clinic Demo через два инженера и показывает происхождение/код в фабрике.

**Архитектура:** [CLINIC_DESIGN](CLINIC_DESIGN.md), R02/R03/R06/R07/R09/R11. Python владеет DTO и PostgreSQL-состоянием; провайдер предлагает отдельные файлы, worker принимает и материализует immutable manifest. Проверки/preview как публичный Runner остаются этапом 4.

**Стек:** существующие FastAPI/Pydantic/SQLAlchemy/PostgreSQL; SQLite кандидата; React 19/TypeScript/Vite; pytest/Playwright, Windows/PowerShell 5.1.

## 1. Закреплённый профиль и каркас

Файлы: profiles/clinic_demo/v1/profile.json, schemas.json, acceptance/test_http.py, template/**; apps/backend/src/codehead/clinic/profile.py; apps/backend/tests/test_clinic_profile.py.

- [x] RED: закреплённые endpoint/status/slot правила и SHA-256 профиля/suite; template не содержит прикладного кода.

```python
def test_profile_has_fixed_http_boundary():
    profile = load_profile()
    assert profile.id == "clinic_demo/v1"
    assert profile.timezone == "Asia/Yekaterinburg"
    assert len(profile.profile_hash) == len(profile.suite_hash) == 64
    assert "clinic_api.py" not in profile.template_files
```

- [x] Зафиксировать JSON-схемы и внешний HTTP-suite до изготовления backend/frontend fixtures. GET/POST/PATCH/cancel, пустые списки, 404/409/422, UTC, 30 минут, future, partial UNIQUE/concurrency/перенос/отмена.
- [x] Добавить технический template с закреплёнными locks и пустыми extension points. Проверить кэш версий существующей среды, без установки на dev.
- [x] GREEN: `npm run test:backend -- apps/backend/tests/test_clinic_profile.py`.

## 2. Предложения файлов, manifest и безопасные пути

Файлы: codehead/clinic/files.py, workspace.py, contracts.py, persistence/models.py, persistence/candidates.py, migrations/versions/0004_candidate.py; tests/test_candidate_files.py, test_candidate_persistence.py.

- [x] RED: UTF-8/BOM/CRLF, Windows traversal/ADS/reserved/reparse/8.3, дубликаты/размеры, неверный base_hash; ни один файл частичного набора не принят.

```python
def test_candidate_batch_is_atomic(database):
    candidate = create_template_candidate(database)
    before = candidate_manifest(database, candidate.id)
    with pytest.raises(FileConflict):
        apply_files(candidate.id, [valid_file(), file_with_stale_base()])
    assert candidate_manifest(database, candidate.id) == before
```

- [x] DTO FileProposal(relative_path, base_hash, media_type, content); CandidateFileView и CandidateView, optional candidate в snapshot/events и profile/suite pins в новых Run. Генератор: `npm run contracts`.
- [x] Candidate/manifest/file artifacts в одной транзакции под Run lock; parent hashes/producer/input versions, отдельные области и новая revision без перезаписи истории.
- [x] Материализация committed manifest вне HTTP/транзакции; byte/hash verification, отказ на reparse/изменённую версию, без удаления пользовательских файлов.
- [x] GREEN: `npm run test:backend -- apps/backend/tests/test_candidate_files.py apps/backend/tests/test_candidate_persistence.py`.

## 3. Versioned fixtures инженеров

Файлы: profiles/clinic_demo/v1/fixtures/backend/clinic_api.py, clinic_storage.py, clinic_models.py; fixtures/frontend/App.tsx, api.ts, styles.css; llm/provider.py, test_provider.py; tests/test_candidate_provider.py, tools/test-clinic.mjs.

- [x] RED: provider возвращает отдельные завершённые файлы только своей области, с base_hash актуальной основы и test-происхождением; live/QA не возвращают fixture.
- [x] Backend fixture реализует фиксированный профиль с SQLite transaction/partial UNIQUE и доверенными часами; отдельные реальные HTTP-проверки.
- [x] Frontend fixture реализует журнал/справочники/формы/перенос/отмену и состояния; frontend-design, без изменения основной сцены.
- [x] В raw response/trace присутствует исходный структурированный результат после redaction; suite/fixtures/template разделены.
- [x] GREEN provider/fixtures: 141 provider/legacy, 76 backend, 55 настоящих HTTP; frontend type/build и 17 браузерных сценариев прошли. Независимые spec/quality reviews одобрены.
- [x] `node tools/test-clinic.mjs` проверяет именно материализованный worker-кандидат; общий harness завершается после интеграции worker.

## 4. Worker и конфликт основы

Файлы: workflow/definition.py, worker_service.py, workflow/worker.py, worker.py, persistence/service.py; tests/test_candidate_worker.py, test_worker.py, test_worker_api.py.

- [x] RED: два инженера начинают независимо после CTO, максимум два running; изменение backend не инвалидирует frontend; approve не повторяет CTO.

```python
def test_engineers_can_hold_independent_leases(started):
    service, run = approve_architecture(started)
    backend = worker_service.claim("worker-backend")
    frontend = worker_service.claim("worker-frontend")
    assert {backend.request.role, frontend.request.role} == {"backend", "frontend"}
```

- [x] clinic-v2/profile/suite/template pins для новых run; clinic-v1 сохраняет старую границу. SUPPORTED_ROLES добавляет backend/frontend, coding/development presentation и propose_files операции.
- [x] File conflict сохраняет attempt/решение атомарно; retry_files использует актуальные bases. Pause/cancel и stale lease работают с двумя операциями.
- [x] CLI исполняет два независимых слота; heartbeat/recovery и graceful shutdown сохраняют прежние гарантии.
- [x] После двух инженеров материализовать кандидат и явно блокировать QA/DevOps.
- [x] GREEN: `npm run test:backend -- apps/backend/tests/test_candidate_worker.py apps/backend/tests/test_worker.py apps/backend/tests/test_worker_api.py`.

## 5. API, проекция и интерфейс

Файлы: api/routes.py, contracts.py, state/projection.ts и тесты; features/CandidatePanel.tsx, Inspector.tsx, WorkerDetails.tsx, RunPanel.tsx, styles.css; tests/e2e/candidate.spec.ts, worker.spec.ts.

- [x] RED: snapshot == events с непустым candidate/manifest/source_code; чужой run и устаревшие ответы не применяются, старый snapshot получает candidate=null.
- [x] Добавить GET /api/runs/{id}/artifacts и /candidate; capabilities показывают пять test-ролей и недоступный Runner/preview. Code остаётся текстом с nosniff.
- [x] HTML-карточка manifest/revision/профиля/хэшей/происхождения и просмотр кода, ссылки на попытки и родители; доступность при WebGL fallback и на 430px.
- [x] E2E: 5 попыток, только один CTO, реальные source_code, immutable hashes/parents, reload/event projection, недоступный QA/preview и данные обеих областей.
- [x] GREEN: `npm run check`, `npm run test:e2e -- --with-worker tests/e2e/candidate.spec.ts tests/e2e/worker.spec.ts`.

- [x] Seeded property кандидата: 8 реальных PostgreSQL-сценариев с parallel=1/2, pause/resume, пагинацией и отменой; snapshot == bounded event prefix. Отменённые до dispatch leases не считаются вызовами.

## 6. Проверка и передача

- [x] Независимые spec и quality reviews; подтверждённые замечания исправить через RED→GREEN.
- [x] `npm run test:backend`, `npm run check`, `npm run build`, кандидат HTTP/type/build и применимые прежние E2E; сохранить фактический вывод.
- [x] Обновить README, IMPLEMENTATION_PLAN, CHANGELOG, ROADMAP и CLINIC_REPORT; указать происхождение fixtures и границу QA/Runner/preview.
- [x] Перезапустить собственный dev supervisor после миграций, сохранить пользовательскую БД, проверить health/UI на 8010/5180. Не запускать платные API или локальную модель.
