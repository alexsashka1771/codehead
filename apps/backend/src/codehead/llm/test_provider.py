"""Original, deterministic clinic document fixtures; no local or remote LLM calls."""

import json
import time
from dataclasses import asdict
from hashlib import sha256

from codehead.llm.provider import ArtifactDraft, ProviderFailure, ProviderRequest, ProviderResult
from codehead.llm.redaction import redact

_REQUIRED_INPUTS = {
    "product_manager": frozenset(),
    "architect": frozenset({"requirements"}),
    "cto": frozenset({"architecture", "api_contract"}),
}
_TEXT_INPUT_FIELDS = ("id", "artifact_type", "content", "content_hash", "relative_path")
_ARTIFACT_LIMIT = 64 * 1024


def _document_header(title: str, request: ProviderRequest) -> str:
    sources = (
        "\n".join(
            f"- [{item['artifact_type']} {item['id']}@v{item['version']}]"
            f"({item['relative_path']}); content_hash={item['content_hash']}"
            for item in request.inputs
        )
        or "- Входных артефактов нет; используется текущий запрос автора."
    )
    return (
        f"# {title}: {request.project_name}\n\n"
        "Источник: test / clinic-fixture-v1. Реальный LLM не вызывался.\n\n"
        f"Requirements version: {request.requirements_version}\n\n"
        f"Описание проекта: {request.description}\n\n"
        "## Закреплённые источники\n\n"
        f"{sources}\n\n"
        "Профиль: [clinic_demo/v1, R02](docs/TECHNICAL_SPEC.md#r02). "
        "Тестовые документы проверяют процесс передачи входов между ролями.\n\n"
    )


def _requirements(request: ProviderRequest) -> tuple[tuple[ArtifactDraft, ...], str]:
    content = _document_header("Требования", request) + (
        "## Сценарии и критерии\n\n"
        "| ID | Сценарий | Приоритет и критерий приёмки |\n"
        "|---|---|---|\n"
        "| REQ-001 | S01: завести врача и условного пациента | P0, V01: создание, список, "
        "чтение и изменение; name/specialty/full_name — непустые строки до 120 символов. "
        "Данные только synthetic (синтетические). |\n"
        "| REQ-002 | S02: записать пациента к врачу | P0, V02: POST возвращает 201 и UUID; "
        "doctor_id/patient_id существуют; starts_at задан в RFC 3339 со смещением. |\n"
        "| REQ-003 | S03: конкурирующая запись на слот | P0, V03: слот 30 минут, "
        "Asia/Yekaterinburg, начало :00/:30 без секунд; хранение и ответ UTC. Новое начало "
        "строго позже server now. Для одного врача и пациента один scheduled на слот: "
        "при конкуренции один 201, второй 409. Ограничения обеспечивает БД. |\n"
        "| REQ-004 | S04: перенести запись | P0, V04: активная будущая запись меняется "
        "атомарно; ссылки, время и уникальность проверяются вместе. Отменённая запись "
        "не переносится; конфликт возвращает 409. |\n"
        "| REQ-005 | S05: отменить запись | P0, V05: POST cancel переводит scheduled "
        "в cancelled, освобождает слот и сохраняет историю. Повтор идемпотентен; отмена "
        "прошлой записи даёт 409. |\n"
        "| REQ-006 | S06: показать состояния интерфейса | P0, V06: React/TypeScript "
        "показывает загрузку, пустой список [], формы, ошибки и конфликт 409; часовой "
        "пояс клиники подписан. |\n"
        "| REQ-007 | S07: обработать ошибки API | P0, V07: чтение/изменение/отмена 200; "
        "неизвестные ресурсы/ссылки 404; неверный формат, прошлое или невыравненный слот "
        "422; ошибка содержит code/message без traceback. |\n"
        "| REQ-008 | S08: открыть проверенное приложение | P0, V08: FastAPI и отдельная "
        "SQLite приложения; PostgreSQL принадлежит платформе. GET /health проверяет "
        "готовность Clinic Demo. Фактические проверки ещё не выполнялись. |\n\n"
        "## Границы и противоречия\n\n"
        "Реальные медицинские данные, платежи, эксплуатация клиники, рабочие часы, "
        "произвольная длительность и удаление истории исключены. Описание автора "
        "конкретизирует этот профиль; расширение требует новой версии и решения автора. "
        "Это фиксированная тестовая конкретизация, без семантической оценки внешней моделью.\n"
    )
    return (ArtifactDraft("requirements", content),), (
        f"Test PM: требования {request.project_name}, версия {request.requirements_version}; "
        "критерии clinic_demo/v1 связаны со сценариями и проверками."
    )


def _architecture(request: ProviderRequest) -> tuple[tuple[ArtifactDraft, ...], str]:
    architecture = _document_header("Архитектура", request) + (
        "## Модули и модель хранения\n\n"
        "React/TypeScript отвечает за формы и состояния UX; FastAPI — за фиксированную "
        "HTTP-границу. Внутренние модули: API schemas/handlers, appointment domain service, "
        "storage repository и доверенные часы. Отдельная SQLite принадлежит Clinic Demo; "
        "PostgreSQL платформы не используется приложением.\n\n"
        "Doctor: UUID id, name, specialty. Patient: UUID id, full_name. Appointment: UUID id, "
        "doctor_id/patient_id (FK), starts_at_utc, status scheduled/cancelled. Отменённые "
        "строки сохраняются. Два частичных UNIQUE-индекса для scheduled закрепляют "
        "(doctor_id, starts_at_utc) и (patient_id, starts_at_utc), как требует REQ-003.\n\n"
        "## Transaction boundary\n\n"
        "Создание и перенос проверяют время, ссылки и сохраняют состояние в одной "
        "transaction. Предварительный SELECT допускается для сообщения, но не заменяет "
        "UNIQUE. Нарушение уникальности переводится в 409. Отмена атомарно освобождает "
        "оба ограничения; повтор сохраняет cancelled. Перенос отменённой или отмена "
        "прошлой записи отклоняются 409.\n\n"
        "Начало принимается с явным смещением, проверяется в Asia/Yekaterinburg "
        "(:00/:30, нулевые секунды), хранится и сравнивается в UTC. Часы фиксирует "
        "доверенный тестовый запуск; публичного управления now нет.\n\n"
        "## Соответствие и проверка\n\n"
        "api_contract связывает REQ-001..REQ-008 с HTTP-профилем. Граница ошибок: "
        "404/409/422 и code/message без traceback. Внешний HTTP-suite должен проверить "
        "конкуренцию врача и пациента, перенос, освобождение слота и повтор отмены. "
        "Альтернатива check-then-insert без UNIQUE отклонена: она допускает две записи. "
        "Исходный requirements закреплён по ID/версии/хэшу выше. Этот test не создаёт "
        "код, базу, инструменты или свидетельство выполненных проверок.\n"
    )
    api_contract = _document_header("HTTP-контракт", request) + (
        "## Фиксированная граница clinic_demo/v1\n\n"
        "| Ресурс | Операции и поля | Требования |\n"
        "|---|---|---|\n"
        "| /api/doctors | GET список; POST name, specialty | REQ-001 |\n"
        "| /api/doctors/{id} | GET; PATCH name/specialty | REQ-001 |\n"
        "| /api/patients | GET список; POST full_name | REQ-001 |\n"
        "| /api/patients/{id} | GET; PATCH full_name | REQ-001 |\n"
        "| /api/appointments | GET список; POST doctor_id, patient_id, starts_at | "
        "REQ-002, REQ-003 |\n"
        "| /api/appointments/{id} | GET; PATCH doctor_id/patient_id/starts_at | REQ-004 |\n"
        "| /api/appointments/{id}/cancel | POST, пустой JSON-объект | REQ-005 |\n"
        "| /health | GET готовность приложения | REQ-008 |\n\n"
        "name/specialty/full_name: непустые строки до 120 символов. ID — UUID. "
        "Appointment возвращает id, doctor_id, patient_id, starts_at, status "
        "(scheduled/cancelled). Списки — JSON-массивы, пустой список — [].\n\n"
        "starts_at: RFC 3339 с явным смещением; ответ UTC, интерфейс "
        "Asia/Yekaterinburg. Слот 30 минут, начало :00/:30 без секунд и долей, "
        "строго позже серверного now. Ссылки существуют; два уникальных ограничения "
        "для scheduled защищают врача и пациента при конкуренции.\n\n"
        "Создание — 201; чтение/изменение/отмена — 200. Неизвестный ресурс/ссылка — "
        "404; конфликт слота, перенос отменённой и отмена прошлой — 409; формат, "
        "прошлое новое начало или невыравненный слот — 422. Ошибка содержит code/message "
        "без traceback (REQ-007). Отмена идемпотентна, история сохраняется. PATCH "
        "переносит только активную будущую запись и проверяет всё в одной транзакции.\n\n"
        "HTTP-профиль не расширяется этим тестовым контрактом. Внешние проверки и "
        "генерация приложения ещё не выполнялись.\n"
    )
    return (
        (ArtifactDraft("architecture", architecture), ArtifactDraft("api_contract", api_contract)),
        f"Test Architect: архитектура и HTTP-контракт {request.project_name} "
        "по закреплённым требованиям.",
    )


def _decision(request: ProviderRequest) -> tuple[tuple[ArtifactDraft, ...], str]:
    content = _document_header("Оценка CTO", request) + (
        "## Рекомендация и основания\n\n"
        "Рекомендация test: принять архитектуру как вход следующего этапа после "
        "подтверждения автора (approval). Это краткое тестовое обоснование по "
        "закреплённым источникам, без вызова LLM и без утверждения о готовом приложении.\n\n"
        "- REQ-001/REQ-002: разделение React/TypeScript и FastAPI поддерживает сущности "
        "врача, синтетического пациента и записи в фиксированной HTTP-границе.\n"
        "- REQ-003/REQ-004/REQ-005: UNIQUE для врача и пациента и общая транзакция "
        "создания/переноса защищают слот; отмена освобождает его, сохраняя историю. "
        "Проверить конкурентными HTTP-запросами, включая перенос.\n"
        "- REQ-006/REQ-007/REQ-008: состояния UX, code/message и /health должны быть "
        "проверены на реальном кандидате. Сейчас executable candidate и отчётов нет.\n\n"
        "## Ограничения решения\n\n"
        "Связи с requirements, architecture и api_contract приведены выше с точными "
        "ID, версиями и хэшами. У test нулевые внешние токены и стоимость; это не оценка "
        "будущего live. Расход live неизвестен до выбора провайдера/модели/бюджета. "
        "Реальные данные, расширение профиля и production не разрешаются. Автор "
        "подтверждает новую версию решения; отказ либо изменение требований требует "
        "новой версии входов. Backend/Frontend и запуск приложения — следующий этап.\n"
    )
    return (ArtifactDraft("decision", content),), (
        f"Рекомендация test CTO: принять архитектуру {request.project_name} после approval автора; "
        "основания связаны с точными входными версиями."
    )


_DOCUMENT_FACTORIES = {
    "product_manager": _requirements,
    "architect": _architecture,
    "cto": _decision,
}


class TestProvider:
    """An explicitly selected test source with zero external usage."""

    __test__ = False
    name = "test"
    model = "clinic-fixture-v1"

    def __init__(self, secrets: tuple[str, ...] = (), delay_seconds: float = 0):
        self.secrets = secrets
        self.delay_seconds = delay_seconds

    def _failure(self, code: str, message: str, **diagnostics) -> ProviderFailure:
        return ProviderFailure(code, redact(message, self.secrets), **diagnostics)

    def _clean_request(self, request: ProviderRequest) -> ProviderRequest:
        if not isinstance(request, ProviderRequest):
            raise self._failure("invalid_provider_request", "Expected a ProviderRequest.")
        if not isinstance(request.role, str) or request.role not in _REQUIRED_INPUTS:
            raise self._failure(
                "unsupported_role", "The test provider does not support the requested role."
            )
        if (
            not isinstance(request.project_name, str)
            or not isinstance(request.description, str)
            or not request.project_name
            or not request.description
            or type(request.requirements_version) is not int
            or request.requirements_version < 1
            or type(request.max_output_tokens) is not int
            or request.max_output_tokens < 1
            or not isinstance(request.inputs, tuple)
        ):
            raise self._failure(
                "invalid_provider_request", "Invalid project, version, inputs or limit."
            )
        inputs = []
        for item in request.inputs:
            if (
                not isinstance(item, dict)
                or any(not isinstance(item.get(key), str) for key in _TEXT_INPUT_FIELDS)
                or type(item.get("version")) is not int
                or item["version"] < 1
            ):
                raise self._failure(
                    "invalid_provider_request", "Invalid pinned input artifact metadata."
                )
            inputs.append(
                {key: redact(item[key], self.secrets) for key in _TEXT_INPUT_FIELDS}
                | {"version": item["version"]}
            )
        missing = _REQUIRED_INPUTS[request.role] - {item["artifact_type"] for item in inputs}
        if missing:
            raise self._failure(
                "missing_input_artifacts",
                f"Missing pinned input artifacts: {', '.join(sorted(missing))}.",
            )
        return ProviderRequest(
            role=request.role,
            project_name=redact(request.project_name, self.secrets),
            description=redact(request.description, self.secrets),
            requirements_version=request.requirements_version,
            inputs=tuple(inputs),
            max_output_tokens=request.max_output_tokens,
        )

    def _prompt(self, request: ProviderRequest) -> str:
        payload = {
            "provider": self.name,
            "model": self.model,
            "mode": "test",
            "instructions_version": "clinic-document-v1",
            "instruction": (
                "Produce only deterministic, non-executable clinic_demo/v1 test documents. "
                "No LLM, tool execution, or private chain of thought is requested. "
                "Use the current project and exact selected input versions."
            ),
        } | asdict(request)
        return redact(
            json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2), self.secrets
        )

    def prepare(self, request: ProviderRequest) -> str:
        return self._prompt(self._clean_request(request))

    def run(self, request: ProviderRequest) -> ProviderResult:
        started = time.perf_counter()
        clean = self._clean_request(request)
        prompt = self._prompt(clean)
        artifacts, summary = _DOCUMENT_FACTORIES[clean.role](clean)
        artifacts = tuple(
            ArtifactDraft(item.artifact_type, redact(item.content, self.secrets), item.media_type)
            for item in artifacts
        )
        summary = redact(summary, self.secrets)
        if len(artifacts) > 2 or any(
            len(item.content.encode("utf-8")) > _ARTIFACT_LIMIT for item in artifacts
        ):
            raise self._failure(
                "invalid_provider_output", "Test artifact exceeds the 64 KiB limit."
            )
        raw_response = redact(
            json.dumps(
                {"artifacts": [asdict(item) for item in artifacts], "summary": summary},
                ensure_ascii=False,
                sort_keys=True,
            ),
            self.secrets,
        )
        # This is a fixture character budget, not measured LLM token usage.
        if len(raw_response) > clean.max_output_tokens * 4:
            raise self._failure(
                "incomplete_provider_output",
                "Complete fixture exceeds the configured output budget.",
                raw_response=raw_response,
                stop_reason="length",
            )
        if self.delay_seconds > 0:
            time.sleep(min(self.delay_seconds, 5.0))
        return ProviderResult(
            artifacts=artifacts,
            summary=summary,
            raw_response=raw_response,
            stop_reason="stop",
            request_id=f"test-{sha256(prompt.encode('utf-8')).hexdigest()[:24]}",
            input_tokens=0,
            output_tokens=0,
            cost_usd=0.0,
            latency_ms=(time.perf_counter() - started) * 1000,
        )
