# QA и repair: устройство подэтапа 4.2

24 ноября 2026 автор поручил продолжить после Runner. Основа — R03/R04/R06/R07/R09/R10/R12 TECHNICAL_SPEC. Направление уже выбрано в ROADMAP; новые runtime-детали фиксируются здесь, без изменения внешнего HTTP-профиля/suite.

## Результат и граница

Новый clinic-v3 после пяти первых test-ролей и публикации кандидата автоматически выполняет Python/HTTP/build через существующие ToolRun. Затем отдельная попытка QA получает immutable входы/фактические результаты, возвращает карту проверок, дополнительные предложения и TestReport; при настоящем дефекте — Bug. Worker проверяет ссылки, hashes и согласованность статуса с ToolRun. Модель не назначает TaskStatus или результат инструмента.

Предусмотрены test_scenario=standard, repair_success, repair_blocked. Последние два явно используют versioned defect fixture check-then-insert без SQLite uniqueness после получения исходного кандидата. Синхронизация двух проверенных запросов делает race наблюдаемым через неизменённый внешний HTTP-suite. Исходные/итоговые хэши, происхождение test_injected и инъекция сохраняются одной транзакцией. Обычный шаблон и обычный candidate дефект не содержат. Live/preview не включаются.

При failed HTTP с подтверждённой целостностью QA сохраняет Bug и завершает свою задачу анализа. Worker добавляет новую Backend repair-задачу и новую QA-задачу. Исторические succeeded/failed/cancelled Task и попытки не переоткрываются. Новый manifest имеет parent/source/input версии; новая проверка использует свежую SQLite. После первой хорошей repair suite реально проходит; после двух недостаточных repair создаётся третья QA-проверка, но третья repair не выдаётся. Run.blocked показывает причину и историю. max_repair_iterations=0/1 также соблюдается.

После green QA DevOps/preview остаются явной границей 4.3. Старые clinic-v1/v2 не получают автоматического QA задним числом; v2 сохраняет ручной Runner. API принимает явный workflow_version для прежних проверочных клиентов; default новых Start — clinic-v3, прежний default command hash/receipt совместимы. Необычный test_scenario допустим только в test clinic-v3.

## Сохраняемый процесс

QualityCycle для каждой QA-итерации закрепляет run/task/candidate/revision/tree/manifest/profile/suite, три ToolRun и immutable report/bug artifacts, repair/follow-up Task. Snapshot/workflow.updated содержат quality_cycles=[] совместимо с историей. Успех относится только к проверенной версии; чужой/поздний отчёт не применяется.

Worker создаёт цикл и ToolRun под Run lock. При dispatch QA-инструмента задача становится running; Agent QA показывает testing от фактического выполнения. После трёх известных результатов QA AgentRun анализирует их, пока Task остаётся running. Форматная ошибка, неизвестный исход, timeout/cache/suite mutation не подменяются Bug/green и не начинают содержательный repair. Существующие fencing/heartbeat/Decision/pause/cancel учитывают инструменты и попытки; новые задачи на паузе не выдаются.

ToolRun завершения дают immutable bounded tool_report для контекста: IDs/pins/status/ошибки/диагностический фрагмент, полный вывод доступен в ToolRun. QA request и trace сохраняют точные версии. Bug/TestReport содержат ссылки на требования и инструменты; дополнительные тесты помечены предложенными и не смешиваются с внешним suite.

TestReport.status показывает исход трёх проверок, а карта требований — границы доказательств. REQ-006 (поведение UI) и REQ-008 (preview) имеют status=not_verified: сборка не доказывает их выполнение. При общем HTTP red без структурированных результатов по каждому требованию остальные проверки также помечаются not_verified; Bug не приписывает неизвестный отказ конкретному требованию. Инфраструктурные exit codes pytest 2–5 блокируют QA без Bug/repair.

Defect injection — доверенный system/test шаг, не фиктивный AgentRun. Source/manifest сохраняют parent hashes и явную информацию о fixture; отдельный injection artifact связывает старую/новую версии. Backend repair получает текущие основы своей области, Bug и отчёт; frontend изменения не теряются. Fixture repair_success восстанавливает constraints/транзакцию; repair_blocked возвращает две отдельные версии одной недостаточной реализации с различимыми хэшами.

## Проверки и интерфейс

TDD: сценарии/compatibility, pin/report validation, параллельные QA ToolRun, late lease/result, controls/uncertainty, immutable Task history, budget/0–2 repair. Отдельный настоящий HTTP harness подтверждает red «два 201» и green «201/409» и три red для blocked; hashes suite до/после совпадают.

В проектном управлении — выбор test-сценария. В Inspector — QA-циклы, требования/предложения, TestReport/Bug, инструменты и цепочка repair. Подписи задач/попыток различают итерации. Контрактная проекция проверяет все ссылки/версии, reload/пагинацию и исторический отчёт. Клавиатура/430px/fallback сохраняются. Отдельные spec/quality reviews, backend/check/build/E2E и QA_REPORT с фактическим выводом; пользовательская PostgreSQL не очищается.
