import copy
import json
import os
import unittest
from datetime import UTC
from pathlib import Path
from urllib.parse import urlparse

from playwright.sync_api import Error, expect, sync_playwright

REPORT = Path(os.environ["CODEHEAD_CLINIC_TEST_REPORT_DIR"])
BASE_URL = os.environ["CODEHEAD_CLINIC_BASE_URL"]
DOCTOR = "10000000-0000-4000-8000-000000000001"
OTHER_DOCTOR = "10000000-0000-4000-8000-000000000002"
PATIENT = "20000000-0000-4000-8000-000000000001"
OTHER_PATIENT = "20000000-0000-4000-8000-000000000002"
APPOINTMENT = "30000000-0000-4000-8000-000000000001"
CANCELLED = "30000000-0000-4000-8000-000000000002"


class HttpBoundary:
    def __init__(self):
        self.doctors = [
            {"id": DOCTOR, "name": "Анна Миронова", "specialty": "Терапевт"},
            {"id": OTHER_DOCTOR, "name": "Павел Орлов", "specialty": "Невролог"},
        ]
        self.patients = [
            {"id": PATIENT, "full_name": "Алина Сергеева"},
            {"id": OTHER_PATIENT, "full_name": "Лев Волков"},
        ]
        self.appointments = [
            {
                "id": APPOINTMENT,
                "doctor_id": DOCTOR,
                "patient_id": PATIENT,
                "starts_at": "2030-01-02T04:00:00Z",
                "status": "scheduled",
            },
            {
                "id": CANCELLED,
                "doctor_id": OTHER_DOCTOR,
                "patient_id": OTHER_PATIENT,
                "starts_at": "2030-01-02T06:00:00Z",
                "status": "cancelled",
            },
        ]
        self.requests = []
        self.conflict_once = False
        self.fail_appointments = False
        self.hold_reads = False
        self.read_resource = "appointments"
        self.hold_mutations = False
        self.held_reads = []
        self.held_mutations = []

    @staticmethod
    def respond(route, payload, status=200):
        route.fulfill(
            status=status,
            content_type="application/json",
            body=json.dumps(payload, ensure_ascii=False),
        )

    def handle(self, route):
        request = route.request
        parts = urlparse(request.url).path.strip("/").split("/")
        resource = parts[1]
        items = getattr(self, resource)
        method = request.method
        payload = request.post_data_json if method in ("POST", "PATCH") else None
        self.requests.append(
            {"method": method, "path": urlparse(request.url).path, "payload": payload}
        )
        if method == "GET":
            if resource == "appointments" and self.fail_appointments:
                route.abort("failed")
                return
            if resource == self.read_resource and self.hold_reads:
                self.held_reads.append((route, copy.deepcopy(items)))
                return
            self.respond(route, items)
            return
        if (
            method == "POST"
            and resource == "appointments"
            and len(parts) == 2
            and self.conflict_once
        ):
            self.conflict_once = False
            self.respond(
                route,
                {
                    "code": "slot_conflict",
                    "message": "Doctor or patient already has a scheduled appointment "
                    "in this slot.",
                },
                409,
            )
            return
        if len(parts) > 2:
            item = next(value for value in items if value["id"] == parts[2])
            if len(parts) == 4:
                assert payload == {}, "Cancel must send an empty JSON object."
                item["status"] = "cancelled"
            else:
                item.update(payload)
                if "starts_at" in payload:
                    from datetime import datetime

                    item["starts_at"] = (
                        datetime.fromisoformat(payload["starts_at"])
                        .astimezone(UTC)
                        .isoformat()
                        .replace("+00:00", "Z")
                    )
            status = 200
        else:
            item = {"id": f"40000000-0000-4000-8000-{len(items) + 1:012d}", **payload}
            if resource == "appointments":
                from datetime import datetime

                item["starts_at"] = (
                    datetime.fromisoformat(payload["starts_at"])
                    .astimezone(UTC)
                    .isoformat()
                    .replace("+00:00", "Z")
                )
                item["status"] = "scheduled"
            items.append(item)
            status = 201
        if self.hold_mutations:
            self.held_mutations.append((route, copy.deepcopy(item), status))
        else:
            self.respond(route, item, status)

    def release_mutations(self):
        self.hold_mutations = False
        for route, payload, status in self.held_mutations:
            self.respond(route, payload, status)
        self.held_mutations.clear()

    def release_reads(self):
        self.hold_reads = False
        for route, payload in self.held_reads:
            try:
                self.respond(route, payload)
            except Error as error:
                if "closed" not in str(error).lower() and "disposed" not in str(error).lower():
                    raise
        self.held_reads.clear()


class FrontendBehaviorTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        cls.browser = cls.playwright.chromium.launch(headless=True)
        expect.set_options(timeout=3000)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context(
            viewport={"width": 1366, "height": 900},
            locale="ru-RU",
            timezone_id="UTC",
            reduced_motion="reduce",
        )
        self.context.add_init_script("""
          const NativeDate = Date;
          class FixedDate extends NativeDate {
            constructor(...args) { super(...(args.length ? args : ['2030-01-01T00:00:00Z'])); }
            static now() { return new NativeDate('2030-01-01T00:00:00Z').valueOf(); }
          }
          window.Date = FixedDate;
        """)
        self.page = self.context.new_page()
        self.page.set_default_timeout(3000)
        self.api = HttpBoundary()
        self.page.route("**/api/**", self.api.handle)
        self.page_errors = []
        self.page.on("pageerror", lambda error: self.page_errors.append(str(error)))

    def tearDown(self):
        problems = self._outcome.result.failures + self._outcome.result.errors
        if any(test is self for test, _ in problems):
            self.page.screenshot(
                path=str(REPORT / f"failure-{self._testMethodName}.png"), full_page=True
            )
            (REPORT / f"failure-{self._testMethodName}.html").write_text(
                self.page.content(), encoding="utf-8"
            )
        self.api.release_reads()
        self.api.release_mutations()
        self.page.wait_for_load_state("networkidle")
        self.context.close()

    def open_app(self, wait=True):
        self.page.goto(BASE_URL, wait_until="domcontentloaded")
        if wait:
            self.page.wait_for_load_state("networkidle")

    def row(self, identity=APPOINTMENT):
        return self.page.locator(f'[data-appointment-id="{identity}"]')

    def fill_appointment(self, time="2030-01-02T09:30"):
        self.page.get_by_label("Врач", exact=True).select_option(DOCTOR)
        self.page.get_by_label("Пациент", exact=True).select_option(OTHER_PATIENT)
        self.page.get_by_label("Дата и время", exact=True).fill(time)

    def test_conflict_keeps_appointment_fields(self):
        self.api.conflict_once = True
        self.open_app()
        expect(self.page.get_by_role("button", name="Новая запись", exact=True)).to_be_visible()
        self.page.get_by_role("button", name="Новая запись", exact=True).click()
        self.fill_appointment()
        self.page.get_by_role("button", name="Сохранить запись", exact=True).click()
        expect(self.page.get_by_role("alert")).to_contain_text("Этот слот уже занят")
        expect(self.page.get_by_label("Врач", exact=True)).to_have_value(DOCTOR)
        expect(self.page.get_by_label("Пациент", exact=True)).to_have_value(OTHER_PATIENT)
        expect(self.page.get_by_label("Дата и время", exact=True)).to_have_value("2030-01-02T09:30")
        expect(self.page.get_by_role("button", name="Сохранить запись", exact=True)).to_be_enabled()
        self.page.screenshot(path=str(REPORT / "conflict-desktop.png"), full_page=True)
        self.page.get_by_label("Дата и время", exact=True).fill("2030-01-02T10:00")
        self.page.get_by_role("button", name="Сохранить запись", exact=True).click()
        expect(self.page.get_by_role("dialog")).not_to_be_visible()
        expect(self.row(self.api.appointments[-1]["id"])).to_contain_text("10:00")
        posts = [request for request in self.api.requests if request["method"] == "POST"]
        self.assertEqual(posts[0]["payload"]["starts_at"], "2030-01-02T09:30:00+05:00")
        self.assertEqual(posts[1]["payload"]["starts_at"], "2030-01-02T10:00:00+05:00")
        self.assertEqual(self.page_errors, [])

    def test_pending_disables_submit_and_cancel_keeps_history(self):
        self.open_app()
        self.api.hold_mutations = True
        expect(self.page.get_by_role("button", name="Новая запись", exact=True)).to_be_visible()
        self.page.get_by_role("button", name="Новая запись", exact=True).click()
        self.fill_appointment()
        self.page.get_by_role("button", name="Сохранить запись", exact=True).click()
        expect(self.page.get_by_role("button", name="Сохраняем…", exact=True)).to_be_disabled()
        expect(self.page.get_by_role("button", name="Закрыть форму", exact=True)).to_be_disabled()
        self.page.keyboard.press("Escape")
        expect(self.page.get_by_role("dialog")).to_be_visible()
        self.page.keyboard.press("Tab")
        self.assertTrue(
            self.page.evaluate("Boolean(document.activeElement.closest('dialog'))"),
            "Pending modal must retain keyboard focus while every form control is disabled.",
        )
        self.assertEqual(len(self.api.held_mutations), 1)
        self.api.release_mutations()
        expect(self.page.get_by_role("dialog")).not_to_be_visible()
        self.row().get_by_role("button", name="Отменить", exact=False).click()
        expect(self.page.get_by_role("dialog")).to_contain_text("Запись останется в журнале")
        self.page.get_by_role("button", name="Подтвердить отмену", exact=True).click()
        expect(self.row()).to_contain_text("Отменена")
        expect(self.row().get_by_role("button", name="Перенести", exact=False)).to_have_count(0)
        expect(self.row()).to_be_visible()
        cancellation = next(
            request for request in self.api.requests if request["path"].endswith("/cancel")
        )
        self.assertEqual(cancellation["payload"], {})
        self.assertEqual(self.page_errors, [])

    def test_focus_returns_to_journal_after_successful_cancellation(self):
        self.open_app()
        trigger = self.row().get_by_role("button", name="Отменить", exact=False)
        original_button = trigger.element_handle()
        trigger.focus()
        self.page.keyboard.press("Enter")
        self.page.get_by_role("button", name="Подтвердить отмену", exact=True).focus()
        self.page.keyboard.press("Enter")
        expect(self.page.get_by_role("dialog")).not_to_be_visible()
        expect(self.row()).to_contain_text("Отменена")
        self.assertFalse(
            original_button.evaluate("element => element.isConnected"),
            "Cancellation removes its original action button.",
        )
        expect(self.page.get_by_role("heading", name="Журнал приёмов", exact=True)).to_be_visible()
        expect(self.page.get_by_role("heading", name="Журнал приёмов", exact=True)).to_be_focused()
        self.page.screenshot(path=str(REPORT / "focus-after-cancellation-1366.png"), full_page=True)
        self.page.keyboard.press("Tab")
        expect(self.page.get_by_role("button", name="Новая запись", exact=True)).to_be_focused()
        self.assertEqual(self.page_errors, [])

    def test_focus_returns_to_journal_after_reschedule_changes_day(self):
        self.open_app()
        trigger = self.row().get_by_role("button", name="Перенести", exact=False)
        original_button = trigger.element_handle()
        trigger.focus()
        self.page.keyboard.press("Enter")
        self.page.get_by_label("Дата и время", exact=True).fill("2030-01-03T14:30")
        self.page.get_by_role("button", name="Сохранить перенос", exact=True).focus()
        self.page.keyboard.press("Enter")
        expect(self.page.get_by_role("dialog")).not_to_be_visible()
        expect(self.row()).to_contain_text("14:30")
        self.assertFalse(
            original_button.evaluate("element => element.isConnected"),
            "Moving to a different day replaces the original action button.",
        )
        expect(self.page.get_by_role("heading", name="Журнал приёмов", exact=True)).to_be_visible()
        expect(self.page.get_by_role("heading", name="Журнал приёмов", exact=True)).to_be_focused()
        self.page.screenshot(path=str(REPORT / "focus-after-reschedule-1366.png"), full_page=True)
        self.page.keyboard.press("Tab")
        expect(self.page.get_by_role("button", name="Новая запись", exact=True)).to_be_focused()
        self.assertEqual(self.page_errors, [])

    def test_rescheduling_and_directory_create_edit(self):
        self.open_app()
        expect(self.row()).to_be_visible()
        self.row().get_by_role("button", name="Перенести", exact=False).click()
        self.page.get_by_label("Врач", exact=True).select_option(OTHER_DOCTOR)
        self.page.get_by_label("Пациент", exact=True).select_option(OTHER_PATIENT)
        self.page.get_by_label("Дата и время", exact=True).fill("2030-01-03T14:30")
        self.page.get_by_role("button", name="Сохранить перенос", exact=True).click()
        expect(self.row()).to_contain_text("14:30")
        expect(self.row()).to_contain_text("Павел Орлов")
        expect(self.row()).to_contain_text("Лев Волков")
        patch = next(request for request in self.api.requests if request["method"] == "PATCH")
        self.assertEqual(
            patch["payload"],
            {
                "doctor_id": OTHER_DOCTOR,
                "patient_id": OTHER_PATIENT,
                "starts_at": "2030-01-03T14:30:00+05:00",
            },
        )
        self.page.get_by_role("button", name="Врачи", exact=True).click()
        self.page.locator(f'[data-person-id="{DOCTOR}"]').get_by_role(
            "button", name="Изменить", exact=False
        ).click()
        self.page.get_by_label("Специальность", exact=True).fill("Кардиолог")
        self.page.get_by_role("button", name="Сохранить врача", exact=True).click()
        expect(self.page.locator(f'[data-person-id="{DOCTOR}"]')).to_contain_text("Кардиолог")
        doctor_patch = next(
            request
            for request in self.api.requests
            if request["method"] == "PATCH" and "/doctors/" in request["path"]
        )
        self.assertEqual(doctor_patch["payload"], {"specialty": "Кардиолог"})
        self.page.get_by_role("button", name="Добавить врача", exact=True).click()
        self.page.get_by_label("Имя врача", exact=True).fill("Мария Соколова")
        self.page.get_by_label("Специальность", exact=True).fill("Офтальмолог")
        self.page.get_by_role("button", name="Сохранить врача", exact=True).click()
        expect(self.page.get_by_text("Мария Соколова", exact=True)).to_be_visible()
        self.page.screenshot(path=str(REPORT / "doctors-desktop-1366.png"), full_page=True)
        self.page.get_by_role("button", name="Пациенты", exact=True).click()
        self.page.locator(f'[data-person-id="{PATIENT}"]').get_by_role(
            "button", name="Изменить", exact=False
        ).click()
        self.page.get_by_label("Имя пациента", exact=True).fill("Алина Смирнова")
        self.page.get_by_role("button", name="Сохранить пациента", exact=True).click()
        expect(self.page.get_by_text("Алина Смирнова", exact=True)).to_be_visible()
        self.page.get_by_role("button", name="Добавить пациента", exact=True).click()
        self.page.get_by_label("Имя пациента", exact=True).fill("Илья Котов")
        self.page.get_by_role("button", name="Сохранить пациента", exact=True).click()
        expect(self.page.get_by_text("Илья Котов", exact=True)).to_be_visible()
        self.page.set_viewport_size({"width": 430, "height": 932})
        self.page.screenshot(path=str(REPORT / "patients-mobile-430.png"), full_page=True)
        self.assertTrue(self.page.evaluate("document.documentElement.scrollWidth <= innerWidth"))
        self.assertEqual(self.page_errors, [])

    def test_loading_error_retry_and_real_empty_state(self):
        self.api.hold_reads = True
        self.api.appointments = []
        self.open_app(wait=False)
        expect(self.page.get_by_text("Загружаем журнал…", exact=True)).to_be_visible()
        expect(self.page.get_by_text("Пока нет записей", exact=True)).to_have_count(0)
        self.api.fail_appointments = True
        for route, _ in self.api.held_reads:
            route.abort("failed")
        self.api.held_reads.clear()
        self.api.hold_reads = False
        expect(self.page.get_by_role("alert")).to_contain_text("Не удалось загрузить журнал")
        expect(self.page.get_by_text("Данные недоступны", exact=True)).to_be_visible()
        expect(self.page.get_by_text("Загружается…", exact=True)).to_have_count(0)
        expect(self.page.get_by_text("Пока нет записей", exact=True)).to_have_count(0)
        self.api.fail_appointments = False
        self.page.get_by_role("button", name="Повторить загрузку журнала", exact=True).click()
        expect(self.page.get_by_text("Пока нет записей", exact=True)).to_be_visible()
        expect(self.page.get_by_role("alert")).to_have_count(0)

    def test_initial_load_blocks_creation_until_history_is_known(self):
        self.api.hold_reads = True
        self.open_app(wait=False)
        expect(self.page.get_by_text("Загружаем журнал…", exact=True)).to_be_visible()
        expect(self.page.get_by_text("Загружаем врачей…", exact=True)).to_have_count(0)
        expect(self.page.get_by_text("Загружаем пациентов…", exact=True)).to_have_count(0)
        expect(self.page.get_by_role("button", name="Новая запись", exact=True)).to_be_disabled()
        self.api.release_reads()
        expect(self.row()).to_be_visible()
        expect(self.page.get_by_role("button", name="Новая запись", exact=True)).to_be_enabled()

    def test_initial_directory_load_blocks_creation(self):
        self.api.hold_reads = True
        self.api.read_resource = "doctors"
        self.open_app(wait=False)
        self.page.get_by_role("button", name="Врачи", exact=True).click()
        expect(self.page.get_by_text("Загружаем врачей…", exact=True)).to_be_visible()
        expect(self.page.get_by_role("button", name="Добавить врача", exact=True)).to_be_disabled()
        self.api.release_reads()
        expect(self.page.locator(f'[data-person-id="{DOCTOR}"]')).to_be_visible()
        expect(self.page.get_by_role("button", name="Добавить врача", exact=True)).to_be_enabled()

    def test_late_get_cannot_restore_confirmed_cancellation(self):
        self.context.add_init_script("""
          const nativeFetch = window.fetch;
          window.fetch = (url, options = {}) => {
            if (!options.method || options.method === 'GET') {
              const { signal, ...rest } = options;
              return nativeFetch(url, rest);
            }
            return nativeFetch(url, options);
          };
        """)
        self.open_app()
        self.api.hold_reads = True
        expect(self.page.get_by_role("button", name="Обновить данные", exact=True)).to_be_visible()
        self.page.get_by_role("button", name="Обновить данные", exact=True).click()
        expect(self.page.get_by_text("Обновляем журнал…", exact=True)).to_be_visible()
        self.assertGreaterEqual(len(self.api.held_reads), 1)
        self.row().get_by_role("button", name="Отменить", exact=False).click()
        self.page.get_by_role("button", name="Подтвердить отмену", exact=True).click()
        expect(self.row()).to_contain_text("Отменена")
        self.api.release_reads()
        self.page.wait_for_load_state("networkidle")
        expect(self.row()).to_contain_text("Отменена")
        expect(self.row().get_by_role("button", name="Перенести", exact=False)).to_have_count(0)
        self.assertEqual(self.page_errors, [])

    def test_past_appointment_has_no_mutation_actions(self):
        self.api.appointments[0]["starts_at"] = "2029-12-31T04:00:00Z"
        self.open_app()
        expect(self.row()).to_contain_text("Время приёма прошло")
        expect(self.row().get_by_role("button")).to_have_count(0)
        expect(self.row(CANCELLED)).to_contain_text("Отменена")

    def test_desktop_mobile_keyboard_and_reduced_motion(self):
        self.open_app()
        expect(self.page.get_by_text("Синтетические данные", exact=True)).to_be_visible()
        expect(self.page.get_by_text("Екатеринбург · UTC+5", exact=True).first).to_be_visible()
        expect(self.row()).to_contain_text("09:00")
        self.page.screenshot(path=str(REPORT / "journal-desktop-1366.png"), full_page=True)
        self.page.set_viewport_size({"width": 430, "height": 932})
        self.page.screenshot(path=str(REPORT / "journal-mobile-430.png"), full_page=True)
        self.assertTrue(
            self.page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
            "Mobile journal must not overflow horizontally.",
        )
        self.page.get_by_role("button", name="Новая запись", exact=True).click()
        expect(self.page.get_by_role("dialog")).to_be_visible()
        self.fill_appointment()
        self.page.screenshot(path=str(REPORT / "appointment-mobile-430.png"), full_page=False)
        self.assertTrue(
            self.page.get_by_role("dialog").evaluate(
                "element => element.getBoundingClientRect().right <= innerWidth && "
                "element.getBoundingClientRect().left >= 0"
            )
        )
        focus_history = []
        for _ in range(8):
            self.page.keyboard.press("Tab")
            focus_history.append(
                self.page.evaluate(
                    "document.activeElement.tagName + ':' + (document.activeElement.id || "
                    "document.activeElement.getAttribute('aria-label') || "
                    "document.activeElement.textContent.slice(0, 50))"
                )
            )
            self.assertTrue(
                self.page.evaluate("Boolean(document.activeElement.closest('dialog'))"),
                f"Keyboard focus must stay in the native modal. Sequence: {focus_history}",
            )
        self.assertTrue(
            self.page.evaluate("matchMedia('(prefers-reduced-motion: reduce)').matches")
        )
        expect(self.page.get_by_role("dialog")).to_have_css("animation-name", "none")
        self.page.keyboard.press("Escape")
        expect(self.page.get_by_role("dialog")).not_to_be_visible()
        expect(self.page.get_by_role("button", name="Новая запись", exact=True)).to_be_focused()
        self.assertEqual(self.page_errors, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
