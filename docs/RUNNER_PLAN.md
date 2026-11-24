# Runner проверок: план подэтапа 4.1

Исполнение: test-driven-development и subagent-driven-development, независимые spec/quality reviews. Обычные commit/push разрешены GIT_WORKFLOW; текущая ветка codex/runner-checks.

## 1. Контракты, очередь и worker

Файлы: contracts.py, persistence/models.py, migrations/versions/0006_tool_runs.py, persistence/tools.py, persistence/service.py, workflow/tool_worker.py, workflow/worker.py, api/routes.py; tests/test_tool_runs.py, test_tool_worker.py.

- [x] RED: совместимые tool_runs=[], immutable pins, receipt/key conflict, готовность/revision/scope/isolation, максимум два слота, поздний fence, paused/cancelled и unknown Decision.
- [x] ToolRunView/ToolCommand и модель ToolRun; optional tool_run_id/nullable task_id в Decision, generated packages/contracts.
- [x] Короткая постановка операции в очередь/GET списка; snapshot/events сохраняют ToolRun одной транзакцией. Pause/cancel ждут AgentRun и ToolRun; confirm_failed для tool Decision проверяет актуальную версию.
- [x] Worker claim/begin/heartbeat/finish/recovery вне HTTP; реальный runner инъецируется через service, управление процессом не держит транзакцию.
- [x] GREEN: npm run test:backend -- apps/backend/tests/test_tool_runs.py apps/backend/tests/test_tool_worker.py.

## 2. RestrictedProcessRunner

Файлы: codehead/runner/{processes,execution}.py, tools/process_tree.py, tests/test_runner.py.

- [x] RED: argv allowlist, отдельная копия/исходные pins, secret env/redaction, отсутствующий cache, Job Object с потомком после смерти родителя, ограничение двух потоков вывода, timeout/cancel и отказ при изменённых исходниках.
- [x] Добавить optional stdout/stderr pipe в существующий ProcessTree без изменения default dev-поведения; источник wrapper остаётся доверенным tools/process_child.py.
- [x] Три операции validate_backend/test_backend/build_frontend на committed копии; внешние suite/profile pins проверяются до/после, report подтверждает fresh SQLite. Никакой установки пакетов, preview или произвольной shell-строки.
- [x] GREEN: реальные subprocess-тесты и запуск трёх операций на worker-кандидате из отдельной тестовой схемы.

## 3. Проекция и интерфейс

Файлы: state/projection.ts, api.ts, features/ToolRunsPanel.tsx, Inspector.tsx, CandidatePanel.tsx, styles.css, hook/unit tests, tests/e2e/runner.spec.ts.

- [x] RED: tool snapshot == events, совместимость старого snapshot, чужие pins/решения, поздние ответы; кнопка только для connected ready test-кандидата, double click/pending, текстовая ошибка/вывод.
- [x] API read/queue и вкладка «Проверки»; результаты stdout/stderr/error/exit/time/isolation/hash; кнопки validate/test/build и переход к Decision. QA/DevOps/preview/Live остаются недоступными.
- [x] GREEN: frontend tests/typecheck; E2E реальная проверка через короткий HTTP и worker, reload/projection, 430 px/fallback/keyboard.

## 4. Проверки и передача

- [x] Независимые spec review, затем quality review; подтверждённые замечания RED→GREEN.
- [x] npm run test:backend, npm run check, npm run build, применимые E2E и runner HTTP/build; фактические логи.
- [x] README/IMPLEMENTATION_PLAN/ROADMAP/CHANGELOG и RUNNER_REPORT показывают подэтап 4.1 и остаток 4.2/4.3, без объявления всех ролей/preview готовыми.
- [x] Перезапущен собственный dev/health без удаления БД; проверенная Git-контрольная точка оформляется по GIT_WORKFLOW с guard/diff и сверкой удалённого SHA.
