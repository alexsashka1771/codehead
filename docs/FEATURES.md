# CodeHead — указатель функций

Идентификаторы F01–F68 сохранены для навигации. Требования и критерии находятся только в [TECHNICAL_SPEC](TECHNICAL_SPEC.md); этот каталог не дублирует их формулировки. «Основа» означает частичную реализацию первого этапа, а не готовую функцию всей курсовой. Проверенные результаты — [STAGE_01_REPORT](STAGE_01_REPORT.md).

| ID | Функция | Нормативная ссылка | Этап |
|---|---|---|---|
| F01 | Создание проекта по описанию | [R01](TECHNICAL_SPEC.md#r01), [R02](TECHNICAL_SPEC.md#r02) | Основа → курсовая/диплом |
| F02 | Семь основных LLM-агентов | [R03](TECHNICAL_SPEC.md#r03) | Курсовая → диплом |
| F03 | Контракты и инструменты ролей | [R03](TECHNICAL_SPEC.md#r03), [R08](TECHNICAL_SPEC.md#r08) | Курсовая → диплом |
| F04 | Database Agent | [R14](TECHNICAL_SPEC.md#r14) | Диплом |
| F05 | Security Agent | [R14](TECHNICAL_SPEC.md#r14) | Диплом |
| F06 | Reviewer Agent | [R14](TECHNICAL_SPEC.md#r14) | Диплом |
| F07 | Research | [R14](TECHNICAL_SPEC.md#r14) | Диплом |
| F08 | Пользователь как CTO | [R01](TECHNICAL_SPEC.md#r01), [R04](TECHNICAL_SPEC.md#r04) | Курсовая → диплом |
| F09 | CTO Agent | [R03](TECHNICAL_SPEC.md#r03) | Курсовая → диплом |
| F10 | Сохранение проектов и запусков | [R01](TECHNICAL_SPEC.md#r01), [R11](TECHNICAL_SPEC.md#r11) | Основа → курсовая/диплом |
| F11 | Граф задач | [R04](TECHNICAL_SPEC.md#r04) | Основа → курсовая/диплом |
| F12 | Состояния агентов и задач | [R04](TECHNICAL_SPEC.md#r04), [R13](TECHNICAL_SPEC.md#r13) | Основа → курсовая/диплом |
| F13 | Сохраняемая очередь и восстановление | [R04](TECHNICAL_SPEC.md#r04), [R06](TECHNICAL_SPEC.md#r06) | Курсовая → диплом |
| F14 | Ограниченные исправления и повторы | [R04](TECHNICAL_SPEC.md#r04), [R10](TECHNICAL_SPEC.md#r10) | Курсовая → диплом |
| F15 | Пауза, продолжение, остановка | [R04](TECHNICAL_SPEC.md#r04) | Основа → курсовая/диплом |
| F16 | Human-in-the-loop | [R04](TECHNICAL_SPEC.md#r04), [R08](TECHNICAL_SPEC.md#r08) | Курсовая → диплом |
| F17 | Решения и разногласия | [R04](TECHNICAL_SPEC.md#r04), [R12](TECHNICAL_SPEC.md#r12) | Курсовая → диплом |
| F18 | Совещания агентов | [R14](TECHNICAL_SPEC.md#r14) | Диплом |
| F19 | Сообщения между агентами | [R03](TECHNICAL_SPEC.md#r03), [R14](TECHNICAL_SPEC.md#r14) | Курсовая → диплом |
| F20 | Вопрос пользователем агенту | [R14](TECHNICAL_SPEC.md#r14) | Диплом |
| F21 | Backlog и критерии | [R02](TECHNICAL_SPEC.md#r02), [R03](TECHNICAL_SPEC.md#r03) | Курсовая → диплом |
| F22 | Архитектура и контракт API | [R02](TECHNICAL_SPEC.md#r02), [R03](TECHNICAL_SPEC.md#r03) | Курсовая → диплом |
| F23 | Генерация frontend | [R02](TECHNICAL_SPEC.md#r02), [R07](TECHNICAL_SPEC.md#r07) | Курсовая → диплом |
| F24 | Генерация backend и схемы | [R02](TECHNICAL_SPEC.md#r02), [R07](TECHNICAL_SPEC.md#r07) | Курсовая → диплом |
| F25 | Независимые приёмочные тесты | [R10](TECHNICAL_SPEC.md#r10) | Курсовая → диплом |
| F26 | Работа QA | [R03](TECHNICAL_SPEC.md#r03), [R10](TECHNICAL_SPEC.md#r10) | Курсовая → диплом |
| F27 | Исправление дефекта | [R04](TECHNICAL_SPEC.md#r04), [R10](TECHNICAL_SPEC.md#r10) | Курсовая → диплом |
| F28 | Артефакты и происхождение | [R07](TECHNICAL_SPEC.md#r07) | Курсовая → диплом |
| F29 | Версии и конфликты файлов | [R07](TECHNICAL_SPEC.md#r07) | Курсовая → диплом |
| F30 | DevOps: сборка и preview | [R03](TECHNICAL_SPEC.md#r03), [R11](TECHNICAL_SPEC.md#r11) | Курсовая → диплом |
| F31 | Локальное исполнение | [R09](TECHNICAL_SPEC.md#r09) | Курсовая → диплом |
| F32 | Изолированное исполнение | [R09](TECHNICAL_SPEC.md#r09), [R14](TECHNICAL_SPEC.md#r14) | Диплом |
| F33 | Git | [R14](TECHNICAL_SPEC.md#r14) | Диплом |
| F34 | Pull request и внешний репозиторий | [R08](TECHNICAL_SPEC.md#r08), [R14](TECHNICAL_SPEC.md#r14) | Диплом |
| F35 | Поддержка существующего продукта | [R14](TECHNICAL_SPEC.md#r14) | Диплом |
| F36 | Все зоны фабрики | [R13](TECHNICAL_SPEC.md#r13) | Основа → курсовая/диплом |
| F37 | Персонажи и деятельность | [R13](TECHNICAL_SPEC.md#r13) | Основа → курсовая/диплом |
| F38 | Перемещение артефактов | [R06](TECHNICAL_SPEC.md#r06), [R13](TECHNICAL_SPEC.md#r13) | Курсовая → диплом |
| F39 | Визуальные совещания | [R14](TECHNICAL_SPEC.md#r14) | Диплом |
| F40 | День и ночь | [R13](TECHNICAL_SPEC.md#r13) | Основа → курсовая/диплом |
| F41 | Панели управления | [R11](TECHNICAL_SPEC.md#r11), [R13](TECHNICAL_SPEC.md#r13) | Основа → курсовая/диплом |
| F42 | Базовый replay | [R06](TECHNICAL_SPEC.md#r06) | Курсовая → диплом |
| F43 | Перемотка и сравнение запусков | [R06](TECHNICAL_SPEC.md#r06), [R14](TECHNICAL_SPEC.md#r14) | Диплом |
| F44 | Графика и идентичность CodeHead | [R13](TECHNICAL_SPEC.md#r13), [R16](TECHNICAL_SPEC.md#r16) | Основа → курсовая/диплом |
| F45 | Доступность и производительность | [R13](TECHNICAL_SPEC.md#r13), [R15](TECHNICAL_SPEC.md#r15) | Основа → курсовая/диплом |
| F46 | Учёт токенов и стоимости | [R12](TECHNICAL_SPEC.md#r12) | Основа → курсовая/диплом |
| F47 | Бюджеты | [R12](TECHNICAL_SPEC.md#r12) | Основа → курсовая/диплом |
| F48 | Выбор контекста | [R12](TECHNICAL_SPEC.md#r12) | Курсовая → диплом |
| F49 | Долговременная и семантическая память | [R14](TECHNICAL_SPEC.md#r14) | Диплом |
| F50 | Семантический кэш | [R14](TECHNICAL_SPEC.md#r14) | Диплом |
| F51 | Сжатие контекста | [R14](TECHNICAL_SPEC.md#r14) | Диплом |
| F52 | Маршрутизация моделей | [R12](TECHNICAL_SPEC.md#r12), [R14](TECHNICAL_SPEC.md#r14) | Курсовая → диплом |
| F53 | Сменяемый провайдер | [R12](TECHNICAL_SPEC.md#r12), [R14](TECHNICAL_SPEC.md#r14) | Курсовая → диплом |
| F54 | Эксперимент по оптимизации | [R15](TECHNICAL_SPEC.md#r15) | Диплом |
| F55 | Token Core | [R12](TECHNICAL_SPEC.md#r12), [R15](TECHNICAL_SPEC.md#r15) | Основа → курсовая/диплом |
| F56 | Gate перед выпуском | [R10](TECHNICAL_SPEC.md#r10), [R11](TECHNICAL_SPEC.md#r11), [R14](TECHNICAL_SPEC.md#r14) | Курсовая → диплом |
| F57 | Развёртывание и откат | [R11](TECHNICAL_SPEC.md#r11), [R14](TECHNICAL_SPEC.md#r14) | Курсовая → диплом |
| F58 | Мониторинг | [R14](TECHNICAL_SPEC.md#r14) | Диплом |
| F59 | Инциденты | [R14](TECHNICAL_SPEC.md#r14) | Диплом |
| F60 | Автоматическое исправление инцидентов | [R14](TECHNICAL_SPEC.md#r14) | Диплом |
| F61 | Контроль внешних действий | [R08](TECHNICAL_SPEC.md#r08), [R14](TECHNICAL_SPEC.md#r14) | Курсовая → диплом |
| F62 | Надёжный realtime | [R06](TECHNICAL_SPEC.md#r06) | Основа → курсовая/диплом |
| F63 | Политика инструментов и данных | [R07](TECHNICAL_SPEC.md#r07), [R08](TECHNICAL_SPEC.md#r08), [R09](TECHNICAL_SPEC.md#r09) | Основа → курсовая/диплом |
| F64 | Объяснимость и диагностика | [R06](TECHNICAL_SPEC.md#r06), [R12](TECHNICAL_SPEC.md#r12) | Основа → курсовая/диплом |
| F65 | Экспорт и демонстрация | [R06](TECHNICAL_SPEC.md#r06), [R11](TECHNICAL_SPEC.md#r11), [R16](TECHNICAL_SPEC.md#r16) | Курсовая → диплом |
| F66 | Локальный запуск и подготовка | [R09](TECHNICAL_SPEC.md#r09) | Основа → курсовая/диплом |
| F67 | Изменение требований | [R01](TECHNICAL_SPEC.md#r01), [R14](TECHNICAL_SPEC.md#r14) | Курсовая → диплом |
| F68 | Расширение продуктовых профилей | [R02](TECHNICAL_SPEC.md#r02), [R14](TECHNICAL_SPEC.md#r14) | Курсовая → диплом |

Кнопка, класс или комната сами по себе не закрывают функцию. Для целевой курсовой проверяются [A01–A18](TECHNICAL_SPEC.md#acceptance), для диплома дополнительно [V01–V09](TECHNICAL_SPEC.md#r13) и работающие сценарии [R14](TECHNICAL_SPEC.md#r14). Очерёдность и контрольные точки — [ROADMAP](ROADMAP.md).
