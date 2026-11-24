# Runner проверок: устройство подэтапа 4.1

24 ноября 2026 автор попросил продолжить после кандидата. Направление QA/Runner/preview уже закреплено в ROADMAP; этот подэтап реализует исполняемую основу проверок по R04/R06/R08/R09/R10/R11. Нормативный источник — TECHNICAL_SPEC.md.

## Граница

Пользователь явно ставит в очередь validate_backend, test_backend или build_frontend для ready-кандидата с expected revision. worker выполняет доверенную команду на отдельной материализованной копии. ToolRun сохраняет candidate/revision/tree/manifest/profile/suite pins, команду, lease/fence, время, exit code, ограниченные stdout/stderr и причину. Наличие проверки не означает исполнение QA/DevOps: автоматические роли, defect fixtures/repair и preview следуют отдельными подэтапами 4.2/4.3. Live не подключается.

API короткий: GET /api/runs/{run_id}/tools, POST /api/runs/{run_id}/tools/commands. Команда содержит operation_id, workspace_id (candidate id), snapshot_version (candidate revision), required_isolation и key. Только process_only поддержан; более сильный уровень возвращает runner_unavailable. Для пользовательского учебного test-кандидата действуют существующие review/provenance и ограничения профиля. Модель не задаёт shell или argv.

## Исполнение

Run lock защищает очередь, receipt, seq и ToolRun. Одновременный одинаковый key возвращает ту же операцию; разные параметры конфликтуют. Параллелизм учитывает уже работающие LLM/ToolRun. Начальный ToolRun имеет статус created, таймаут — отдельный terminal timed_out по R04. Запись/событие фиксируются вместе; API не создаёт копию и не запускает процесс.

Worker claim/begin/heartbeat/finish используют lease и fencing. До dispatch отменённая операция безопасно cancelled. Потеря lease после dispatch сохраняет uncertain и решение автора; поздний результат не принимается, автоматического повтора нет. Пауза/отмена останавливают собственное дерево и учитывают известность исхода ToolRun вместе с AgentRun. Подтверждение остановки неизвестной операции снимает соответствующую блокировку через версионируемый Decision.

Runner проверяет dependency cache и committed исходники, создаёт копию в .data/tool-runs/<tool_id>, очищает окружение от ключей/БД/PYTHONPATH/NODE_OPTIONS, запускает allowlist argv с shell=False в Windows Job Object. stdout/stderr читаются параллельно с лимитом и redaction; таймаут, переполнение, отмена и потеря lease завершают своё дерево. После процесса проверяются исходные pins/хэши. Ограничение process_only не защищает от враждебного кода локального пользователя; контейнер/remote не имитируются.

validate_backend компилирует прикладные Python-файлы. test_backend запускает неизменённый внешний acceptance/run_suite.py на свежей SQLite и сохраняет подробный report с проверенными хэшами до/после. build_frontend запускает TypeScript и Vite из проверенного кэша, проверяет index.html, предел 16 MiB/1024 записей и SHA-256 выходных файлов; preview не стартует. Сбой cache даёт dependency_unavailable, изменения источников/набора аннулируют успех. Ошибка остановки дерева сохраняет uncertain с известными PID/командами, а не фиктивный failed.

## Интерфейс и проверки

Snapshot/workflow.updated добавляют tool_runs=[] совместимо со старыми событиями. Production-проекция проверяет run/candidate/decision scope и pins, сохраняет время и вывод. Вкладка «Проверки» позволяет выбрать одну из трёх операций для готовой версии, показывает очередь/исполнение/вывод/ошибку и ссылки на решения. Закрытие панели или replay не запускают команд. Работа с клавиатуры/430 px/WebGL fallback сохраняется.

TDD: DTO/queue/receipt/scope, реальный subprocess/Job Object/таймаут/output/env/integrity, worker fencing/control/recovery и настоящая PostgreSQL-проекция. Финал: backend/check/build, runner HTTP и браузерный путь, независимые spec/quality reviews, документация и проверенная Git-контрольная точка. Пользовательская БД не очищается.
