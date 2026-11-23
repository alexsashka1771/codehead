# План: worker и первые роли

24 ноября 2026 года. Основа — WORKER_DESIGN.md и R03/R04/R06/R07/R12; автор выбрал заглушку, без локальных моделей. Исполнение через test-driven-development, subagent-driven-development и verification-before-completion. Git в этой папке отсутствует; коммиты не выполняются.

Статус: выполнен и проверен в режиме `test`. Фактический вывод и границы этапа — в [WORKER_REPORT](WORKER_REPORT.md). Live-провайдер и следующие роли ещё не реализованы.

## 1. Контракты и хранение

Файлы: contracts.py, persistence/models.py, migrations/versions/0003_worker.py, persistence/service.py, packages/contracts (генератор), tests/test_worker.py.

- [x] RED: StartRun принимает test; snapshot содержит попытки/решения; неизвестное live usage остаётся null.
- [x] Добавить AgentRun/Decision/WorkerHeartbeat, fencing/active_attempt_id задачи, cancel_requested run, immutable content артефакта.
- [x] Добавить совместимые значения по умолчанию новых полей и полное workflow.updated событие. После изменения Python выполнить npm run contracts.
- [x] GREEN: миграция чистой отдельной тестовой схемы и чтение прежних сущностей.

Проверка: `npm run test:backend -- apps/backend/tests/test_worker.py apps/backend/tests/test_contracts.py`.

## 2. Изолированный провайдер-заглушка

Файлы: src/codehead/llm/provider.py, llm/test_provider.py, llm/redaction.py, tests/test_llm.py. Эту задачу можно выполнять независимо от ORM.

Интерфейс:

```python
@dataclass(frozen=True)
class ProviderRequest:
    role: str
    project_name: str
    description: str
    requirements_version: int
    inputs: tuple[dict, ...]
    max_output_tokens: int = 2048

@dataclass(frozen=True)
class ArtifactDraft:
    artifact_type: str
    content: str
    media_type: str = "text/markdown"

@dataclass(frozen=True)
class ProviderResult:
    artifacts: tuple[ArtifactDraft, ...]
    summary: str
    raw_response: str
    stop_reason: str
    request_id: str | None
    input_tokens: int | None
    output_tokens: int | None
    cost_usd: float | None
    latency_ms: float
```

TestProvider: `name="test"`, `model="clinic-fixture-v1"`, `prepare(request) -> str`, `run(request) -> ProviderResult`; prepare возвращает редактированный prompt. LiveProviderUnavailable имеет тот же интерфейс и отклоняет выполнение. ProviderFailure имеет code/message/dispatched/uncertain и необязательный raw_response/stop_reason. Секреты и credentials редактируются общим `redact(text, secrets=()) -> str`.

- [x] RED: документы отражают проект и точные входы; unsupported role отвергается, live не возвращает fixture; secret canary не попадает в prompt/response.
- [x] Реализовать PM requirements, Architect architecture/api_contract и CTO decision с критериями Clinic Demo и коротким обоснованием.
- [x] Проверить малые завершённые результаты, отрицательные/обрезанные ответы и нулевую стоимость только test.

Проверка: `npm run test:backend -- apps/backend/tests/test_llm.py`.

## 3. Lease, recovery, управление и решения

Файлы: workflow/worker_service.py, workflow/worker.py, workflow/worker_models.py при необходимости, persistence/service.py, tests/test_worker.py.

- [x] RED: два потребителя получают единственный lease; устаревшие attempt/fence/lease/input_versions не принимаются.
- [x] Реализовать claim, begin, heartbeat, finish с короткими транзакциями и полными событиями.
- [x] RED: recovery до отправки освобождает queued; после отправки создаёт uncertain и блокировку без повторного вызова.
- [x] RED: pause/cancel во время вызова ожидают завершения; после unknown cancel остаётся blocked.
- [x] Сохранять immutable результаты, источник и trace; CTO создаёт Decision. Resolve проверяет версию/receipt и не повторяет оценку после approve.
- [x] Ограничить число вызовов/wall time, не выполнять следующие роли; явно блокировать незавершённый этап Clinic Demo.
- [x] После согласованного retry сохранить старую uncertain-попытку и отдельное неблокирующее решение для подтверждения её исхода; pause/cancel ждут исхода всех операций.

Проверка: `npm run test:backend -- apps/backend/tests/test_worker.py apps/backend/tests/test_persistence.py apps/backend/tests/test_transitions.py`.

## 4. API, CLI и production-проекция

Файлы: api/routes.py, settings.py, worker.py (CLI), tools/dev.py, tools/test-e2e.mjs, state/projection.ts, tests/test_supervisor.py, projection.test.ts, tests/test_worker.py.

- [x] Добавить решения/resolve, попытки/trace, immutable artifact content и актуальный usage/capabilities.
- [x] Отдельный процесс worker и флаг изолированного E2E; graceful shutdown/lease recovery.
- [x] Расширить production-проекцию и нормализацию; property-проверка PostgreSQL snapshot == events включает непустые артефакты, попытки, решения и usage.
- [x] Перед чтением snapshot/events/capabilities наблюдать истечение heartbeat короткой транзакцией и сохранять offline-событие, включая потерю idle worker.

Проверка: `npm run test:backend`, `npm run check`.

## 5. UI и завершение

Файлы: features/RunPanel.tsx, AgentPanel.tsx, Inspector.tsx, state/api.ts, useWorkspace.ts, app/App.tsx, styles.css, tests/e2e/worker.spec.ts.

- [x] Явная кнопка запуска test, постоянная метка, доступные решения, источники/trace и документы; существующая сцена использует настоящие состояния.
- [x] E2E: test доходит до CTO Decision; stale decision отвергается, approve не вызывает CTO повторно, следующий этап честно блокируется. Проверить pause/cancel и HTML без WebGL.
- [x] Проверить `npm run check`, `npm run test:backend`, `npm run build`, `npm run test:e2e -- --with-worker tests/e2e/worker.spec.ts` и применимые прежние сценарии.
- [x] Независимые spec/quality reviews; исправить подтверждённые замечания, обновить README/CHANGELOG/IMPLEMENTATION_PLAN и отчёт по фактическому выводу.
