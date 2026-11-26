# DevOps и preview: устройство подэтапа 4.3

25 ноября 2026 автор поручил продолжить после QA/repair. Нормативный источник — TECHNICAL_SPEC, R03/R04/R06/R07/R08/R09/R10/R11/R12; данный документ фиксирует реализацию, не новые требования. Основа ed6ab36, ветка codex/devops-preview. Только test provider и loopback; Live, внешнее развёртывание и replay UI не подключаются.

## Выбранный способ

Пакет содержит committed исходники, исходный manifest и проверенный frontend/dist. Он замораживается с перечнем SHA-256/размеров и воспроизводимым ZIP. Preview использует production-статику и API Clinic Demo, а не Vite dev-server. Статический-only вариант не обеспечивает формы/API; dev-server оставляет изменяемое дерево и не является проверенной сборкой. Выбран отдельный доверенный HTTP bridge с фиксированным reverse proxy на собственный backend.

Новые Start — clinic-v4: пять первых ролей, QA и существующий ограниченный repair, публикация пакета, настоящий smoke, DevOps-анализ и завершение run. Standard даёт 7 test-вызовов; repair_success — 9; repair_blocked остаётся 10 без DevOps и третьей repair. Старые v1/v2/v3 и их receipts сохраняются, законченные задачи не переоткрываются. Явно разные workflow версии с одним ключом конфликтуют; неявный повтор прежнего Start возвращает исторический run.

DevOps получает фактические package/build/QA/smoke inputs, создаёт typed deployment_package и runbook. Smoke реально запускает приложение на свежей отдельной SQLite и завершает своё дерево. Это временная проверка, а не объявленный интерактивный preview. Run.succeeded требует всех семи задач и известных успешных gates; ошибки/unknown/бюджет не дают фиктивного успеха.

## Публикация и доказательства

Delivery фиксирует run/task/candidate/revision/tree/manifest/profile/suite/template, passed QA cycle/report, build ToolRun/report hash, package manifest/ZIP hashes и smoke/report/DevOps artifacts. Долгая публикация вне транзакции, с отдельным lease/fencing и собственной генерацией каталога; результат и событие принимаются под Run lock. Частичный/stale каталог не заменяет готовый пакет.

Источник build — только retained результат последнего успешно проверенного кандидата. Копируются ровно перечисленные source/manifest/dist файлы; reparse/path/byte hash проверяются повторно. node_modules, окружения, SQLite/PostgreSQL, secrets и чужие файлы в архив не входят. Пределы: 1024 файлов, до 16 MiB payload и архива; превышение явно блокирует delivery. Download — attachment, nosniff, после готовых gates.

Пакет имеет .codehead/package.json с отсортированным перечнем payload, package tree/hash и pins. ZIP содержит payload и этот manifest, но не сам ZIP. Hash архива хранится в Delivery, чтобы избежать самоссылки. SQLite preview изменяема отдельно от пакета и сохраняется для пары run/package; smoke всегда использует другой свежий каталог.

## Preview-команды и жизненный цикл

GET /api/runs/{id}/preview читает сохранённые сессии и доступность. POST /api/runs/{id}/preview/commands принимает start/stop, package/session refs, expected state version и ключ. API лишь создаёт PreviewSession/ToolRun/receipt и событие. Start разрешён для ready delivery завершённого test clinic-v4; stop работает для собственной сессии независимо от terminal Run. Общий tools API не обходит эти gates; smoke_test/start_preview/stop_preview — доверенные Runner операции.

PreviewSession состояния: created, starting, ready, stopping, stopped, failed, uncertain. Сессия закрепляет пакет, версию, own worker boot, PID/ownership, origin, health/time/lease и ToolRun IDs. Управляющая версия меняется при переходах, а не каждом heartbeat. Одновременно одна незавершённая сессия на run, максимум две живые сессии для локального worker; превышение — явная ошибка ресурса. Новый run/версия не забирает занятый порт.

Runtime хранит собственные Job Object handles и проверяет завершение обоих процессов. Только registry-owned trees останавливаются; сохранённый PID или занятый порт не разрешают kill чужого процесса. Потеря lease/worker не вызывает автоматического повторного start. Утрата ownership или неизвестный исход сохраняются как uncertain, URL не выдаётся готовым. Shutdown worker закрывает свои деревья, сохраняя SQLite. Паузу/отмену и budgets учитывают publication/smoke/начатые операции.

Domain snapshot/events содержат persisted Delivery/PreviewSessions. GET preview дополнительно возвращает access/availability: URL только при ready, свежем health/lease и соответствующем worker; устаревший источник имеет явную причину. Этот read-only runtime access не подменяет состояние журнала и не входит в его fold. Чтение/reload/переключение run/будущий replay ничего не запускают.

## Граница доверия

Backend и bridge удерживают отдельные сокеты на `127.0.0.1`. ОС выделяет порты при bind, Windows ограничивает повторную привязку сокета. Worker проверяет живые процессы и HTTP health loopback-bridge. Отдельный цикл мониторинга обновляет время проверки, пока слоты заняты сборкой или другими задачами. Дочерние процессы получают системные переменные для запуска, настройки UTF-8 и конфигурацию локальной SQLite Clinic Demo.

Bridge служит только frozen inventory и /api/*, /health к фиксированному собственному backend. Не проксирует произвольные URL/Host/redirects, credentials и X-CodeHead-*; запросы/ответы ограничены. Traversal, абсолютные пути, reparse и изменённые hashes отклоняются. MIME/nosniff, CSP, frame/referrer policy задаёт доверенная конфигурация. Platform Host/Origin/bootstrap/JSON/custom-header/token остаются закрытыми для preview.

Iframe: sandbox="allow-scripts allow-forms", без allow-same-origin, top-navigation, popups и полномочий платформы. Для opaque iframe bridge обеспечивает CORS только null и собственному origin, без credentials; CSP ограничивает scripts/connect/assets этим preview origin. Preview загружается в iframe по отдельному действию «Открыть», после подтверждённого ready; GET/events сами iframe/процесс не запускают. Прямой внешний link имеет noopener/noreferrer. Process_only не изолирует враждебный Python от пользовательских файлов/сети; текущий test-кандидат явно помечен.

## Интерфейс и проверки

В Inspector — пакет/ZIP/QA/smoke/DevOps sources, preview состояния и версии, start/stop/open, причина ошибки/потери worker и fresh access. Исторический пакет или поздний ответ не заменяет текущую выборку. Последний QA итог и хронология сохраняются; старые v3 показывают свою границу. Live остаётся отключённым; source test_injected не объявляется реальной LLM-генерацией.

RED→GREEN: version/receipt compatibility; 7/9/10 calls; publication/source/build mutation; actual smoke failure/timeout; controls/leases/budgets; exact package/preview pins; two run ports/ownership; stop/restart SQLite; worker loss/foreign process; R08 bootstrap/commands blocked from iframe; snapshot == full event fold; replay GET не вызывает действий. Реальный harness и E2E исполняют compiled candidate, CRUD/409 в iframe, reload, stop и 430px/fallback. Проверки только codehead_test с новыми schemas, без очистки .data/postgres. Отдельные spec/quality reviews, check/build, PREVIEW_REPORT, сохранённый dev/health и Git по GIT_WORKFLOW.
