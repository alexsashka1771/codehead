# DevOps и preview: план подэтапа 4.3

Подэтап 4.3 выполнен в `codex/devops-preview` от `ed6ab36` с тестами RED → GREEN и независимым ревью. Сохранены рабочий checkout `C:\Work\Diplom`, локальный PostgreSQL и подготовленный кэш. Фактические результаты приведены в [PREVIEW_REPORT](PREVIEW_REPORT.md).

## 1. Контракты и состояние

Файлы: contracts.py, persistence/models.py, migrations/versions/0008_delivery.py, workflow/definition.py, persistence/service.py, generated packages/contracts.

- [x] Проверить новый default `clinic-v4`, явные v2/v3, повтор исторического ключа и конфликт явных версий.
- [x] Связать Delivery, PreviewSession и ToolRun в PostgreSQL. Выделить отдельный контракт PreviewAccess с проверкой loopback-origin.
- [x] Синхронизировать сгенерированные контракты. Выбирать v3 в исторических QA-тестах, v2 в проверках кандидата и Runner.

## 2. Trusted package compiler (Root)

Создать codehead/delivery/package.py, tests/test_delivery_package.py. Интерфейс PackageRequest(package_id, generation, candidate, contents, manifest_content, build_tool_id, build_report); PackageCompiler(tool_root, package_root).publish → frozen PackageResult с root/manifest/files/tree/archive hashes/sizes. Только Root пишет эти файлы.

- [x] Проверить состав реальной сборки, pinned исходники, SHA-256, изменение файлов, границы путей и лимиты архива.
- [x] Сохранить канонический manifest и ZIP. Повторно проверить пакет перед чтением и запуском.
- [x] Прогнать тесты на закреплённом профиле, шаблоне и внешнем QA-наборе.

## 3. Trusted runtime/bridge (Root)

Создать delivery/runtime.py, delivery/bridge.py, tests/test_preview_runtime.py и bridge tests. RuntimeRequest(preview_id, package result, data_root, owner_boot); PreviewRuntime.start/stop/probe/owns/close. Registry держит только own Job trees; start/smoke возвращают известный Result с origin/health/PIDs либо failure/uncertain. Backend agent интегрирует эти интерфейсы после согласования.

- [x] Проверить реальный loopback, готовность процессов, занятый порт и отказ при изменении пакета.
- [x] Отдавать production-статику и фиксированный маршрут к Clinic API с ограниченными запросами, CSP, MIME и CORS. Отделить SQLite preview от свежей базы smoke.
- [x] Подтвердить Stop своего дерева, ограничение времени и обработку неизвестного исхода Job Object.

## 4. Worker, DevOps и preview API (backend agent)

Создать workflow/delivery_service.py, persistence/delivery.py и preview.py, llm/delivery_provider.py; изменить worker_service/worker/tool_worker, RunnerRequest/ExecutionResult adapter, api/routes и security; добавить test_delivery_workflow/test_delivery_provider/test_preview_api/test_preview_persistence. Не трогать Root package/runtime/bridge/tests.

- [x] Проверить 7/9/10 тестовых вызовов, старый v3 и блокировку при ошибке или неизвестном результате.
- [x] Публиковать пакет вне транзакции. Принять результат по версии lease и fence под блокировкой Run с событием, затем запустить smoke и сохранить документы DevOps.
- [x] Выполнять команды по ключу и версии сессии. Обновлять health независимо от занятых слотов. Восстанавливать статус по lease и подтверждённому владению.
- [x] Прогнать изолированные PostgreSQL-тесты. Закрыть замечания ревью к controls, фальшивому успеху и гонке Stop с probe.

## 5. UI и проекция

Создать features/PreviewPanel.tsx, state delivery/preview validators/hooks/tests; изменить App/api/useWorkspace/Inspector/WorkerDetails/ToolRunsPanel/projection, fixtures и tests/e2e/preview.spec.ts. Preserve incumbent DESIGN/3D.

- [x] Проверить связи пакета и сессии, историю, смену запуска и запоздавшие ответы.
- [x] Добавить панель ZIP и источников, явный Start, Stop и открытие iframe после свежей проверки.
- [x] Проверить TypeScript, сборку, равенство снимка и событий, Clinic-формы и 409. Осмотреть 1366 px и 430 px без WebGL.

## 6. Проверка и передача (Root)

Создать tools/test-preview.mjs и verify_preview.py, npm test:preview, docs/PREVIEW_REPORT; обновить README/IMPLEMENTATION_PLAN/ROADMAP/CHANGELOG/GIT_WORKFLOW.

- [x] Проверить `standard`, `repair_success`, `repair_blocked`. Подтвердить ZIP, реальные порты, остановку, перезапуск SQLite и отказ при повреждении пакета.
- [x] Прогнать backend, check, сборку и E2E на `codehead_test`, включая предыдущие QA и Runner.
- [x] Обновить документацию, применить миграцию и проверить локальные API и UI.

Финальная передача ветки следует [GIT_WORKFLOW](GIT_WORKFLOW.md). Следующий подэтап включает восстановление и replay.
