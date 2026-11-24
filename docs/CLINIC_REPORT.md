# Кандидат Clinic Demo: фактический результат

24 ноября 2026 года, сессия 3. Основа — [CLINIC_DESIGN](CLINIC_DESIGN.md), [CLINIC_PLAN](CLINIC_PLAN.md) и R02/R03/R04/R06/R07/R09/R11 в [TECHNICAL_SPEC](TECHNICAL_SPEC.md).

## Результат и граница

Новый test run закрепляет clinic-v2, clinic_demo/v1 и SHA-256 профиля, внешних проверок и технического каркаса при Start. Worker сохраняет документы PM → Architect → CTO, запрашивает решение автора и после одобрения выполняет Backend/Frontend в двух независимых слотах. CTO повторно не вызывается. Обычный путь содержит пять отправленных успешных вызовов; пауза может дополнительно сохранить отменённый до отправки lease, который не считается вызовом и не производит артефактов.

Инженеры создают шесть прикладных файлов в отдельных областях. Приём проверяет base_hash, состав, размер и происхождение всего набора одной транзакцией под блокировкой Run. Immutable manifest проходит ревизии 1 → 2 → 3; исходники, родительские артефакты/хэши, производители и точные входные версии сохраняются. Конфликт основы блокирует отдельную попытку; retry_files использует актуальную основу своей области.

Committed версия материализуется вне HTTP и транзакции в .data/candidates/<candidate_id>/v<revision>. Публикация имеет собственный lease/fence/heartbeat; пауза, отмена, смена ревизии и поздний worker не публикуют устаревшее ready. Windows byte lock сериализует scan/read/write одной ревизии между процессами, освобождается при завершении процесса и находится вне immutable vN. Идемпотентный повтор проверяет байты/хэши и отказывается перезаписывать изменённые или неучтённые файлы.

После сохранения файлов run блокируется перед QA/DevOps. Публичные Runner, preview, repair, replay UI и Live не подключены. Прикладные файлы происходят из TestProvider fixtures и помечены test_injected; каркас — template, артефакты заглушки — test. Это не доказательство генерации реальной LLM и не завершение всех A-критериев курсовой. Платные вызовы и локальная модель не выполнялись; неизвестные Live-расходы не заменены нулём.

## Интерфейс и согласованность

В Inspector появилась вкладка кандидата с версией, статусом, manifest, SHA-256, списком исходников и ссылками на родителей, производителей и входные документы. Исходники показываются текстом с nosniff; чтение не запускает код. GET /api/runs/{id}/candidate и /artifacts возвращают descriptor только выбранного run.

Проекция проверяет принадлежность manifest/source/parent/producer и всех входных ссылок своему run, версии/хэши/размеры immutable артефактов и всю родительскую цепочку manifest. Запоздавшие ответы не меняют выбранный run. Snapshot совпадает с ограниченной его курсором проекцией событий, включая промежуточные ревизии, паузу, параллельные операции и отмену. Seeded property проверила восемь последовательностей кандидата; прежняя property-проверка lifecycle также прошла.

Старые snapshot получают candidate=null и nullable pins. Сохранённый clinic-v1 продолжает только прежние три роли. Миграция 0005 добавляет nullable Run.template_hash без переписывания истории; старому run неизвестный хэш не приписывается задним числом. Основная 3D-сцена и риги сохраняют существующий дизайн. Просмотр кода, клавиатура и provenance доступны без WebGL на 430 px.

## Проверки

Все проверки PostgreSQL использовали отдельную codehead_test и новые schemas. HTTP-suite использовал свежую SQLite кандидата, доверенный rootdir, отдельные синтетические данные и закреплённые хэши. Пользовательская codehead и .data/postgres не очищались.

| Команда | Фактический результат | Лог/артефакт |
|---|---|---|
| npm run test:backend | 467 passed in 93.02s, exit 0 | [backend-final.log](../.data/reports/clinic-stage/backend-final.log) |
| npm run check | 25 файлов / 260 тестов; Python lint/format, contracts и TypeScript прошли, exit 0 | [check-final.log](../.data/reports/clinic-stage/check-final.log) |
| npm run build | 2695 modules; built in 1.17s, exit 0 | [build-final.log](../.data/reports/clinic-stage/build-final.log) |
| npm run test:clinic | 5 вызовов; revision 3; TypeScript/build, 11 browser tests и 55 HTTP tests прошли, exit 0 | [candidate-final.log](../.data/reports/clinic-stage/candidate-final.log), [summary.json](../.data/reports/clinic-candidate-1795533443473/summary.json) |
| npm run test:e2e -- --with-worker tests/e2e/candidate.spec.ts tests/e2e/worker.spec.ts | 5 passed (2.4m), exit 0 | [worker-e2e.log](../.data/reports/clinic-stage/worker-e2e.log), .data/reports/e2e-1795532326958 |
| npm run test:e2e | 25 passed, 5 worker-only skipped (6.9m), exit 0 | [regression-e2e.log](../.data/reports/clinic-stage/regression-e2e.log), .data/reports/e2e-1795532777988 |
| npm run test:e2e -- --with-worker tests/e2e/candidate.spec.ts -g "seeded candidate" | 1 passed (1.4m), seed 20261124, 8 run-сценариев, exit 0 | [property-e2e.log](../.data/reports/clinic-stage/property-e2e.log), .data/reports/e2e-1795533581010 |

Browser tests приложения в test:clinic используют управляемые HTTP-ответы и проверяют экран/формы/конфликты/отмену/перенос, поздние ответы и доступность. Реальная семантика SQLite/HTTP, включая конкуренцию, проверена внешними 55 тестами. Происхождение, source integrity и SHA-256 профиля/suite/кандидата сохранены в отдельном отчёте; public_runner и preview в нём unavailable.

Независимые spec/quality reviews backend и frontend одобрены после исправлений через RED→GREEN: pin шаблона при Start, capabilities по реальному составу ролей, несовместимый лимит файлов до dispatch, stop_reason отклонённого ответа, чужие входные версии manifest, concurrent materialization. Повтор harness обнаружил ошибку своего bind-теста на Windows TIME_WAIT; остановка теперь проверяется по состоянию Listen, две регрессии прошли. Seeded property первоначально неправильно считала отменённый до dispatch lease шестым вызовом; ожидание уточнено без изменения production.

Известные предупреждения: THREE_CJS_DEPRECATED в существующем тестовом окружении и renderer chunk больше 500 kB при сборке. Измеренные 60 FPS не заявляются. Искусственная потеря WebGL в fallback-сценариях ожидаемо пишет ошибку renderer, но HTML-контроль проходит.

## Запуск и следующий этап

После миграций собственный supervisor перезапущен. [UI](http://127.0.0.1:5180/) вернул HTTP 200; [health](http://127.0.0.1:8010/health) — stage=worker, database=ready, command_security=ready. Capabilities объявляют первые роли и candidate_files available, QA/Runner/preview planned, Live disabled. Новые тестовые пользовательские проекты для проверки dev не создавались.

Следующая сессия — QA/DevOps, ToolRun/RestrictedProcessRunner, независимые red/green и две неудачные repair-попытки, сборка и preview отдельного origin. Реальный провайдер и успешная live-приёмка остаются отдельной согласованной работой. Git этой контрольной точки ведётся в feat/clinic-candidate по [GIT_WORKFLOW](GIT_WORKFLOW.md).
