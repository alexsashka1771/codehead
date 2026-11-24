# Runner проверок: фактический результат подэтапа 4.1

24 ноября 2026 года. После кандидата автор попросил продолжить. Направление сессии 4 разделено на Runner 4.1, QA/repair 4.2 и DevOps/preview 4.3; этот отчёт подтверждает только 4.1. Основа — [RUNNER_DESIGN](RUNNER_DESIGN.md), [RUNNER_PLAN](RUNNER_PLAN.md), R04/R06/R08/R09/R10/R11 [TECHNICAL_SPEC](TECHNICAL_SPEC.md).

## Результат

Пользователь может явно поставить в очередь validate_backend, test_backend или build_frontend готового test-кандидата. GET /api/runs/{id}/tools показывает сохраняемые ToolRun; POST /tools/commands возвращает 202 с immutable receipt начального created. API не материализует файлы и не исполняет процесс. Один key возвращает ту же операцию, изменённые параметры конфликтуют. Между receipt и событием UI сохраняет accepted intent и не отправляет повторный POST; snapshot изменяется только по серверным данным.

Worker выполняет операцию на отдельной verified копии .data/tool-runs/<tool_id>/<candidate_id>/v<revision>. ToolRun закрепляет идентификатор/revision, manifest/tree/profile/suite/template hashes, параметры, команды, PID, время, exit code, stdout/stderr и отчёт. Перед finish повторно проверяются immutable source/manifest и все поля ToolCommand. Параллельные ToolRun и AgentRun учитываются одним лимитом Run; LLM-счётчики от проверки не изменяются.

Статусы соответствуют R04: created → running → succeeded/failed/timed_out/cancelled/uncertain. Lease/fence/heartbeat не допускают записи позднего результата. Пауза и отмена останавливают своё дерево и ждут известных исходов. Потеря lease или неподтверждённая остановка после dispatch сохраняет uncertain с известным PID/командами и версионируемым решением автора; автоматического повтора нет. После явного confirm_failed снимается нужная блокировка, сохраняются комментарий и история. Resume после остановленной проверки снимает pause intent, сохраняя границу QA.

Runner использует очищенное окружение, trusted argv, shell=False и Windows Job Object. Есть таймаут до 180 секунд, максимум 256 KiB на каждый поток, раздельное чтение и redaction, в том числе секрета на границе обрезки. Job закрывает потомков уже завершившегося родителя. Сборка проверяет index.html, регулярные файлы/reparse, предел 16 MiB и 1024 записей; сохраняет SHA-256/размеры выходов. Неизвестная остановка дерева не превращается в известный отказ.

validate_backend выполняет py_compile с явным UTF-8. test_backend исполняет закреплённый внешний HTTP-suite на свежей SQLite с отдельным rootdir и проверкой исходных/итоговых хэшей. build_frontend выполняет настоящий TypeScript и Vite из закреплённого кэша, без установки зависимостей. Процессные отчёты сохраняются как результат проверки, а не как ответ модели.

## Интерфейс и границы

В Inspector добавлена вкладка «Проверки»: три команды, состояния, время/exit code/PID, stdout/stderr, отчёт/хэши/лимиты, ссылки на manifest и решение автора. Кнопки отключены при отсутствии ready test-кандидата/worker, паузе, отмене, неизвестном исходе или ожидании принятой команды. Closing/reload/replay не исполняют операции. Старые snapshot получают tool_runs=[], Decision — совместимый tool_run_id=null. Проекция проверяет run/candidate/manifest/version/decision scope и сохраняет исторические результаты.

Desktop и 430 px с WebGL fallback/клавиатурой проверены. Основная сцена и риги не изменялись. В существующем ScenePrecompiler-тесте устранена гонка двух стадий scheduler явной очередью тестовых задач; production-код сцены сохранён.

QA/DevOps как автоматические роли, defect injection, repair, preview и Live пока недоступны. Отчёт не доказывает A02/A04/A05/A14 целиком. Прикладные файлы остаются test_injected; реальные LLM-вызовы, платные API и локальная модель не выполнялись. process_only ограничивает ошибки исполнения, но не изолирует враждебный Python/JS от файлов и сети пользователя. Container/remote возвращают runner_unavailable.

## Фактические проверки

PostgreSQL — только отдельная codehead_test и новые schemas; HTTP — свежая SQLite. Пользовательская codehead и .data/postgres не очищались.

| Команда | Результат | Лог/артефакт |
|---|---|---|
| npm run test:backend | 526 passed in 222.14s, exit 0 | [backend-final.log](../.data/reports/runner-stage/backend-final.log) |
| npm run check | 29 файлов / 305 тестов, lint/format/contracts/TypeScript прошли, exit 0 | [check-final.log](../.data/reports/runner-stage/check-final.log) |
| npm run build | 2696 modules; сборка прошла, exit 0 | [build-final.log](../.data/reports/runner-stage/build-final.log) |
| npm run test:runner | 3 настоящих ToolRun, compile/55 HTTP/build прошли; 5 LLM-вызовов не изменились, exit 0 | [runner-harness.log](../.data/reports/runner-stage/runner-harness.log), [summary.json](../.data/reports/runner-1795538325910/summary.json) |
| npm run test:e2e -- --with-worker tests/e2e/runner.spec.ts tests/e2e/candidate.spec.ts tests/e2e/worker.spec.ts | 8 passed (5.6m), exit 0 | [runner-e2e.log](../.data/reports/runner-stage/runner-e2e.log), .data/reports/e2e-1795536855531 |
| npm run test:e2e -- --with-worker tests/e2e/runner.spec.ts | После последней правки receipt: 2 passed (1.8m), exit 0 | [runner-final-e2e.log](../.data/reports/runner-stage/runner-final-e2e.log), .data/reports/e2e-1795538035749 |
| npm run test:e2e | 25 passed, 8 worker-only skipped (5.4m), exit 0 | [regression-e2e.log](../.data/reports/runner-stage/regression-e2e.log), .data/reports/e2e-1795538450777 |

Независимые spec/quality reviews одобрены после RED→GREEN: R04 created/timed_out, late command/content drift, лимит сборки, secret truncation в stdout/stderr, ошибка остановки как uncertain, receipt-before-event guard. Браузерный путь проверил короткий POST, реальные Python/HTTP, reload, snapshot == bounded event projection, immutable provenance и отсутствие новых LLM-вызовов. Три операции через backend worker дополнительно проверены отдельным harness.

Предупреждения сборки о существующем большом renderer chunk и THREE CJS deprecation сохранены; измеренные 60 FPS не заявляются. Ошибки WebGL при его принудительном отключении ожидаемы и не мешают HTML-проверкам.

## Запуск и следующий шаг

Собственный dev supervisor заменён с проверкой владельца процессов; его Job Object закрыл API/UI/worker, PostgreSQL сохранён. Миграция 0006 применена при новом запуске. [UI](http://127.0.0.1:5180/) вернул HTTP 200; [health](http://127.0.0.1:8010/health) — stage=worker, database=ready, command_security=ready. Runner capability — available с перечислением трёх операций; QA/preview planned, Live disabled.

Следующий подэтап — QA/repair 4.2: ToolRun уже даёт фактический отчёт, теперь нужны содержательный разбор роли QA, отдельная defect fixture, настоящий red/green и ограничение двух repair. После этого — DevOps/preview 4.3 отдельного origin. Git-контрольная точка хранится в codex/runner-checks по [GIT_WORKFLOW](GIT_WORKFLOW.md).
