import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { api, ApiError, asApiError, isAbortError, type Appointment, type AppointmentInput, type Doctor, type DoctorInput, type Patient } from './api';
import './styles.css';

const CLINIC_NAME = "Clinic Demo";
const CLINIC_TIMEZONE = 'Asia/Yekaterinburg';
const SLOT_MS = 30 * 60 * 1000;

const timeFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: CLINIC_TIMEZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dateFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: CLINIC_TIMEZONE, day: 'numeric', month: 'long', weekday: 'long' });
const shortDateFormat = new Intl.DateTimeFormat('ru-RU', { timeZone: CLINIC_TIMEZONE, day: 'numeric', month: 'short' });
const inputFormat = new Intl.DateTimeFormat('en-CA', { timeZone: CLINIC_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

type View = 'appointments' | 'doctors' | 'patients';
type Scope = 'all' | 'scheduled' | 'cancelled';
type Editor = { kind: 'appointment'; item?: Appointment } | { kind: 'doctor'; item?: Doctor } | { kind: 'patient'; item?: Patient } | { kind: 'cancel'; item: Appointment };
type Collection<T> = { items: T[]; loaded: boolean; loading: boolean; error: ApiError | null };
type FocusTarget = RefObject<HTMLElement | null>;

function inputValue(timestamp: string | number): string {
  const parts = inputFormat.formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(value => value.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

function nextSlot(): string {
  return inputValue(Math.floor(Date.now() / SLOT_MS) * SLOT_MS + SLOT_MS);
}

function appointmentTimestamp(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:(00|30)(:00)?$/.test(value)) {
    throw new ApiError(422, 'invalid_slot', 'Выберите начало на :00 или :30. Приём длится 30 минут.');
  }
  const result = `${value.slice(0, 16)}:00+05:00`;
  const timestamp = new Date(result).valueOf();
  if (!Number.isFinite(timestamp) || inputValue(timestamp) !== value.slice(0, 16)) {
    throw new ApiError(422, 'invalid_time', 'Выберите корректную дату и время.');
  }
  if (timestamp <= Date.now()) {
    throw new ApiError(422, 'past_slot', 'Новая запись должна начинаться в будущем по времени Екатеринбурга.');
  }
  return result;
}

function useCollection<T extends { id: string }>(read: (signal?: AbortSignal) => Promise<T[]>) {
  const [state, setState] = useState<Collection<T>>({ items: [], loaded: false, loading: true, error: null });
  const revision = useRef(0);
  const controller = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    controller.current?.abort();
    const current = new AbortController();
    controller.current = current;
    const version = ++revision.current;
    setState(previous => ({ ...previous, loading: true, error: null }));
    try {
      const items = await read(current.signal);
      if (revision.current === version && !current.signal.aborted) {
        setState({ items, loaded: true, loading: false, error: null });
      }
    } catch (error) {
      if (revision.current === version && !current.signal.aborted && !isAbortError(error)) {
        setState(previous => ({ ...previous, loading: false, error: asApiError(error) }));
      }
    }
  }, [read]);

  const commit = useCallback((item: T) => {
    // A confirmed mutation invalidates every earlier read, even if abort is ignored.
    ++revision.current;
    controller.current?.abort();
    setState(previous => ({
      items: previous.items.some(value => value.id === item.id)
        ? previous.items.map(value => value.id === item.id ? item : value)
        : [...previous.items, item],
      loaded: true,
      loading: false,
      error: null,
    }));
  }, []);

  useEffect(() => {
    void reload();
    return () => { ++revision.current; controller.current?.abort(); };
  }, [reload]);

  return { ...state, reload, commit };
}

function useSubmission() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const inFlight = useRef(false);

  const submit = async (operation: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      await operation();
    } catch (failure) {
      setError(asApiError(failure));
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };
  return { pending, error, submit, clearError: () => setError(null) };
}

function Icon({ name, size = 18 }: { name: 'plus' | 'refresh' | 'arrow' | 'close' | 'search' | 'leaf' | 'clock'; size?: number }) {
  const paths = {
    plus: <path d="M12 5v14M5 12h14" />,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5" /><path d="M6.1 7a7 7 0 0 1 11.8-1L20 12M4 12l2.1 6a7 7 0 0 0 11.8-1" /></>,
    arrow: <><path d="M5 12h14M14 7l5 5-5 5" /></>,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    search: <><circle cx="10.5" cy="10.5" r="6" /><path d="m15 15 5 5" /></>,
    leaf: <><path d="M7 20V9m0 4c6 0 10-4 10-10C11 3 7 7 7 13Zm0 4C3 17 1 14 1 10c4 0 6 3 6 7Z" /><path d="M4 20h6" /></>,
    clock: <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function Dialog({ title, eyebrow, pending, focusTarget, onClose, children }: { title: string; eyebrow: string; pending: boolean; focusTarget: FocusTarget; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog?.showModal();
    dialog?.querySelector<HTMLElement>('input, select, [data-initial-focus]')?.focus();
    return () => {
      dialog?.close();
      // Cancellation or a changed day can replace the opener before cleanup.
      const canRestore = previousFocus?.isConnected && !previousFocus.matches(':disabled')
        && !previousFocus.closest('dialog') && previousFocus.getClientRects().length > 0
        && getComputedStyle(previousFocus).visibility === 'visible';
      const target = canRestore ? previousFocus : focusTarget.current;
      target?.focus();
    };
  }, [focusTarget]);
  useEffect(() => { if (pending) titleRef.current?.focus(); }, [pending]);

  return <dialog ref={ref} className="editor" aria-labelledby="editor-title" onKeyDown={event => {
    if (event.key !== 'Tab') return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])')]
      .filter(element => !element.matches(':disabled') && element.getClientRects().length > 0);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!first) {
      event.preventDefault();
      titleRef.current?.focus();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  }} onCancel={event => { event.preventDefault(); if (!pending) onClose(); }} onClick={event => {
    if (event.target !== event.currentTarget || pending) return;
    const rect = event.currentTarget.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
  }}>
    <div className="editor-heading">
      <span className="eyebrow">{eyebrow}</span>
      <button type="button" className="icon-button" aria-label="Закрыть форму" disabled={pending} onClick={onClose}><Icon name="close" /></button>
      <h2 id="editor-title" tabIndex={-1} ref={titleRef}>{title}</h2>
    </div>
    {children}
  </dialog>;
}

function FormError({ error, context }: { error: ApiError | null; context: 'appointment' | 'directory' | 'cancel' }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) ref.current?.focus(); }, [error]);
  if (!error) return null;
  const isSlot = error.status === 409 && context === 'appointment' && !/past|cancel|inactive|not_scheduled|not_active/.test(error.code);
  const title = isSlot ? 'Этот слот уже занят' : error.status === 404 ? 'Данные больше не найдены' : error.status === 422 ? 'Проверьте поля' : error.status === 409 ? 'Запись нельзя изменить' : 'Не удалось сохранить';
  return <div className="form-error" role="alert" tabIndex={-1} ref={ref}>
    <strong>{title}</strong>
    {isSlot && <p>У врача или пациента уже есть приём в это время. Выберите другой слот — введённые данные сохранены.</p>}
    <p>{error.message}</p>
    {error.status === 404 && <p>Обновите журнал и справочники после закрытия формы.</p>}
  </div>;
}

function AppointmentForm({ item, doctors, patients, focusTarget, onSaved, onClose }: { item?: Appointment; doctors: Doctor[]; patients: Patient[]; focusTarget: FocusTarget; onSaved: (item: Appointment) => void; onClose: () => void }) {
  const [doctorId, setDoctorId] = useState(item?.doctor_id ?? '');
  const [patientId, setPatientId] = useState(item?.patient_id ?? '');
  const [startsAt, setStartsAt] = useState(() => item ? inputValue(item.starts_at) : nextSlot());
  const submission = useSubmission();
  const missing = doctors.length === 0 || patients.length === 0;
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submission.submit(async () => {
      const input: AppointmentInput = { doctor_id: doctorId, patient_id: patientId, starts_at: appointmentTimestamp(startsAt) };
      let saved: Appointment;
      if (item) {
        const patch: Partial<AppointmentInput> = {};
        if (doctorId !== item.doctor_id) patch.doctor_id = doctorId;
        if (patientId !== item.patient_id) patch.patient_id = patientId;
        if (new Date(input.starts_at).valueOf() !== new Date(item.starts_at).valueOf()) patch.starts_at = input.starts_at;
        if (Object.keys(patch).length === 0) throw new ApiError(422, 'no_changes', 'Выберите другое время, врача или пациента для переноса.');
        saved = await api.appointments.update(item.id, patch);
      } else {
        saved = await api.appointments.create(input);
      }
      onSaved(saved);
    });
  };

  return <Dialog title={item ? 'Перенести запись' : 'Новая запись'} eyebrow={item ? 'Журнал / перенос' : 'Журнал / запись на приём'} pending={submission.pending} focusTarget={focusTarget} onClose={onClose}>
    <form className="editor-form" onSubmit={handleSubmit}>
      <p className="editor-description">Выберите врача, условного пациента и свободное время.</p>
      <FormError error={submission.error} context="appointment" />
      {missing && <div className="form-note" role="status">Сначала добавьте врача и пациента в соответствующих разделах. Затем вернитесь к записи.</div>}
      <fieldset disabled={submission.pending}>
        <label htmlFor="appointment-doctor">Врач</label>
        <select id="appointment-doctor" value={doctorId} onChange={event => { setDoctorId(event.target.value); submission.clearError(); }} required>
          <option value="" disabled>Выберите врача</option>
          {doctors.map(doctor => <option key={doctor.id} value={doctor.id}>{doctor.name} · {doctor.specialty}</option>)}
        </select>
        <label htmlFor="appointment-patient">Пациент</label>
        <select id="appointment-patient" value={patientId} onChange={event => { setPatientId(event.target.value); submission.clearError(); }} required>
          <option value="" disabled>Выберите пациента</option>
          {patients.map(patient => <option key={patient.id} value={patient.id}>{patient.full_name}</option>)}
        </select>
        <label htmlFor="appointment-start">Дата и время</label>
        <input id="appointment-start" type="datetime-local" value={startsAt} min={nextSlot()} step={1800} onChange={event => { setStartsAt(event.target.value); submission.clearError(); }} aria-describedby="appointment-time-note" required />
        <div id="appointment-time-note" className="time-note"><Icon name="clock" /><span><strong>Екатеринбург · UTC+5</strong><br />Начало в :00 или :30. Длительность — 30 минут.</span></div>
      </fieldset>
      <div className="editor-actions">
        <button className="button primary" type="submit" disabled={submission.pending || missing}>{submission.pending ? 'Сохраняем…' : item ? 'Сохранить перенос' : 'Сохранить запись'}{!submission.pending && <Icon name="arrow" />}</button>
        <button className="button quiet" type="button" disabled={submission.pending} onClick={onClose}>Вернуться в журнал</button>
      </div>
    </form>
  </Dialog>;
}

function PersonForm({ kind, item, focusTarget, onSaved, onClose }: { kind: 'doctor' | 'patient'; item?: Doctor | Patient; focusTarget: FocusTarget; onSaved: (item: Doctor | Patient) => void; onClose: () => void }) {
  const doctor = kind === 'doctor';
  const [name, setName] = useState(item ? 'name' in item ? item.name : item.full_name : '');
  const [specialty, setSpecialty] = useState(item && 'specialty' in item ? item.specialty : '');
  const submission = useSubmission();
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    void submission.submit(async () => {
      const cleanName = name.trim();
      const cleanSpecialty = specialty.trim();
      if (!cleanName || (doctor && !cleanSpecialty)) throw new ApiError(422, 'blank_name', 'Заполните поля: строки из одних пробелов не подходят.');
      let saved: Doctor | Patient;
      if (doctor) {
        const input: DoctorInput = { name: cleanName, specialty: cleanSpecialty };
        if (item && 'name' in item) {
          const patch: Partial<DoctorInput> = {};
          if (input.name !== item.name) patch.name = input.name;
          if (input.specialty !== item.specialty) patch.specialty = input.specialty;
          if (!Object.keys(patch).length) throw new ApiError(422, 'no_changes', 'Измените имя или специальность перед сохранением.');
          saved = await api.doctors.update(item.id, patch);
        } else saved = await api.doctors.create(input);
      } else {
        if (item && 'full_name' in item) {
          if (cleanName === item.full_name) throw new ApiError(422, 'no_changes', 'Измените имя перед сохранением.');
          saved = await api.patients.update(item.id, { full_name: cleanName });
        } else saved = await api.patients.create({ full_name: cleanName });
      }
      onSaved(saved);
    });
  };

  return <Dialog title={item ? doctor ? 'Изменить врача' : 'Изменить пациента' : doctor ? 'Новый врач' : 'Новый пациент'} eyebrow={doctor ? 'Справочник / врачи' : 'Справочник / пациенты'} pending={submission.pending} focusTarget={focusTarget} onClose={onClose}>
    <form className="editor-form" onSubmit={handleSubmit}>
      <p className="editor-description">{doctor ? 'Имя и специальность будут видны в журнале приёмов.' : 'Используйте вымышленное имя. Медицинские данные здесь не нужны.'}</p>
      <FormError error={submission.error} context="directory" />
      <fieldset disabled={submission.pending}>
        <label htmlFor="person-name">{doctor ? 'Имя врача' : 'Имя пациента'}</label>
        <input id="person-name" type="text" value={name} maxLength={120} required onChange={event => { setName(event.target.value); submission.clearError(); }} autoComplete="off" />
        {doctor && <><label htmlFor="person-specialty">Специальность</label><input id="person-specialty" type="text" value={specialty} maxLength={120} required onChange={event => { setSpecialty(event.target.value); submission.clearError(); }} autoComplete="off" /></>}
      </fieldset>
      <p className="field-hint">Только синтетические данные. До 120 символов в каждом поле.</p>
      <div className="editor-actions">
        <button className="button primary" type="submit" disabled={submission.pending}>{submission.pending ? 'Сохраняем…' : doctor ? 'Сохранить врача' : 'Сохранить пациента'}{!submission.pending && <Icon name="arrow" />}</button>
        <button className="button quiet" type="button" disabled={submission.pending} onClick={onClose}>Вернуться к списку</button>
      </div>
    </form>
  </Dialog>;
}

function CancelForm({ item, doctor, patient, focusTarget, onSaved, onClose }: { item: Appointment; doctor?: Doctor; patient?: Patient; focusTarget: FocusTarget; onSaved: (item: Appointment) => void; onClose: () => void }) {
  const submission = useSubmission();
  return <Dialog title="Отменить запись?" eyebrow="Журнал / отмена" pending={submission.pending} focusTarget={focusTarget} onClose={onClose}>
    <form className="editor-form" onSubmit={event => { event.preventDefault(); void submission.submit(async () => onSaved(await api.appointments.cancel(item.id))); }}>
      <div className="cancel-summary"><span>{shortDateFormat.format(new Date(item.starts_at))} · {timeFormat.format(new Date(item.starts_at))}</span><strong>{patient?.full_name ?? 'Пациент не найден'}</strong><p>{doctor?.name ?? 'Врач не найден'}{doctor ? ` · ${doctor.specialty}` : ''}</p></div>
      <p className="editor-description">Слот освободится для новой записи. Запись останется в журнале со статусом «Отменена».</p>
      <FormError error={submission.error} context="cancel" />
      <div className="editor-actions">
        <button className="button danger" type="submit" disabled={submission.pending} data-initial-focus>{submission.pending ? 'Отменяем…' : 'Подтвердить отмену'}</button>
        <button className="button quiet" type="button" disabled={submission.pending} onClick={onClose}>Сохранить приём</button>
      </div>
    </form>
  </Dialog>;
}

function CollectionFeedback<T>({ collection, noun }: { collection: Collection<T> & { reload: () => Promise<void> }; noun: 'журнал' | 'врачей' | 'пациентов' }) {
  if (collection.loading) return <div className="loading-note" role="status"><span className="loading-dot" />{collection.loaded ? `Обновляем ${noun}…` : `Загружаем ${noun}…`}</div>;
  if (!collection.error) return null;
  const genitive = noun === 'журнал' ? 'журнала' : noun;
  return <div className="load-error" role="alert"><div><strong>Не удалось загрузить {noun}</strong><p>{collection.error.message}</p></div><button className="button secondary" type="button" aria-label={`Повторить загрузку ${genitive}`} onClick={() => void collection.reload()}>Повторить <Icon name="refresh" /></button></div>;
}

function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty-state"><span className="empty-rule" /><h2>{title}</h2><div>{children}</div></div>;
}

export default function App() {
  const doctors = useCollection(api.doctors.list);
  const patients = useCollection(api.patients.list);
  const appointments = useCollection(api.appointments.list);
  const [view, setView] = useState<View>('appointments');
  const [scope, setScope] = useState<Scope>('all');
  const [query, setQuery] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [notice, setNotice] = useState('');
  const [now, setNow] = useState(Date.now);
  const focusTarget = useRef<HTMLHeadingElement>(null);

  useEffect(() => { document.title = `${CLINIC_NAME} · Журнал приёмов`; }, []);
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 30_000); return () => window.clearInterval(timer); }, []);

  const doctorById = useMemo(() => new Map(doctors.items.map(doctor => [doctor.id, doctor])), [doctors.items]);
  const patientById = useMemo(() => new Map(patients.items.map(patient => [patient.id, patient])), [patients.items]);
  const sortedAppointments = useMemo(() => [...appointments.items].sort((left, right) => new Date(left.starts_at).valueOf() - new Date(right.starts_at).valueOf() || left.id.localeCompare(right.id)), [appointments.items]);
  const search = query.trim().toLocaleLowerCase('ru-RU');
  const visibleAppointments = sortedAppointments.filter(item => {
    if (scope !== 'all' && item.status !== scope) return false;
    const doctor = doctorById.get(item.doctor_id);
    const patient = patientById.get(item.patient_id);
    return !search || `${doctor?.name ?? ''} ${doctor?.specialty ?? ''} ${patient?.full_name ?? ''}`.toLocaleLowerCase('ru-RU').includes(search);
  });
  const days = new Map<string, Appointment[]>();
  for (const item of visibleAppointments) {
    const day = inputValue(item.starts_at).slice(0, 10);
    const group = days.get(day) ?? [];
    group.push(item);
    days.set(day, group);
  }
  const upcoming = sortedAppointments.filter(item => item.status === 'scheduled' && new Date(item.starts_at).valueOf() > now);
  const cancelledCount = appointments.items.filter(item => item.status === 'cancelled').length;
  const loading = doctors.loading || patients.loading || appointments.loading;
  const referencesReady = doctors.loaded && patients.loaded && !doctors.error && !patients.error;
  const currentCollection = view === 'appointments' ? appointments : view === 'doctors' ? doctors : patients;
  const creationReady = currentCollection.loaded && !currentCollection.error && (view !== 'appointments' || referencesReady);
  const viewInfo = {
    appointments: { eyebrow: 'Расписание / 30-минутные слоты', title: 'Журнал приёмов', description: 'Время, врач и пациент — всё для спокойной работы регистратуры.', action: 'Новая запись' },
    doctors: { eyebrow: 'Справочник / специалисты', title: 'Врачи', description: 'Команда клиники. Имена и специальности для записи на приём.', action: 'Добавить врача' },
    patients: { eyebrow: 'Справочник / условные пациенты', title: 'Пациенты', description: 'Вымышленные имена для учебных записей. Без медицинских данных.', action: 'Добавить пациента' },
  }[view];

  const changeView = (next: View) => { setView(next); setQuery(''); setNotice(''); };
  const refresh = () => { void doctors.reload(); void patients.reload(); void appointments.reload(); };
  const openCreate = () => setEditor({ kind: view === 'appointments' ? 'appointment' : view === 'doctors' ? 'doctor' : 'patient' });
  const saveAppointment = (item: Appointment) => { appointments.commit(item); setNotice(item.status === 'cancelled' ? 'Запись отменена. История сохранена.' : editor?.kind === 'appointment' && editor.item ? 'Запись перенесена.' : 'Новая запись сохранена.'); setEditor(null); };
  const savePerson = (item: Doctor | Patient) => { if ('specialty' in item) doctors.commit(item); else patients.commit(item); setNotice(editor?.item ? 'Изменения сохранены.' : 'Справочник дополнен.'); setEditor(null); };
  const directory = view === 'doctors' ? doctors : patients;
  const people = (view === 'doctors' ? doctors.items : patients.items).filter(item => !search || ('name' in item ? `${item.name} ${item.specialty}` : item.full_name).toLocaleLowerCase('ru-RU').includes(search)).sort((left, right) => ('name' in left ? left.name : left.full_name).localeCompare('name' in right ? right.name : right.full_name, 'ru-RU'));

  return <div className="clinic-app">
    <a href="#main-content" className="skip-link">Перейти к содержимому</a>
    <header className="masthead">
      <div className="brand"><span className="brand-mark"><Icon name="leaf" size={35} /></span><div><span className="brand-name">{CLINIC_NAME}</span><span className="brand-caption">Учебная регистратура</span></div></div>
      <div className="masthead-notes"><span className="synthetic-tag"><span />Синтетические данные</span><span className="timezone">Екатеринбург · UTC+5</span></div>
    </header>
    <div className="navigation-line"><nav aria-label="Разделы клиники">{([{ id: 'appointments', name: 'Журнал приёмов' }, { id: 'doctors', name: 'Врачи' }, { id: 'patients', name: 'Пациенты' }] as const).map((tab, index) => <button key={tab.id} type="button" className={view === tab.id ? 'nav-item active' : 'nav-item'} aria-current={view === tab.id ? 'page' : undefined} onClick={() => changeView(tab.id)}><span aria-hidden="true">0{index + 1}</span>{tab.name}</button>)}</nav><span className="navigation-note">У каждого приёма — своё время</span></div>
    <main id="main-content" className="main-content" tabIndex={-1}>
      <section className="section-intro" aria-labelledby="page-title"><div><span className="eyebrow">{viewInfo.eyebrow}</span><h1 id="page-title" tabIndex={-1} ref={focusTarget}>{viewInfo.title}</h1><p>{viewInfo.description}</p></div><div className="intro-actions"><button className="button primary" type="button" onClick={openCreate} disabled={!creationReady}><Icon name="plus" />{viewInfo.action}</button><button className="refresh-button" type="button" aria-label="Обновить данные" disabled={loading} onClick={refresh}><Icon name="refresh" /><span>Обновить</span></button></div></section>
      {notice && <div className="notice" role="status"><span>{notice}</span><button className="icon-button" type="button" aria-label="Скрыть уведомление" onClick={() => setNotice('')}><Icon name="close" size={16} /></button></div>}
      {view === 'appointments' ? <>
        <div className="journal-summary"><div className="summary-heading"><span className="eyebrow">В журнале</span><span>Приёмы и история</span></div><div className="summary-stat"><strong>{appointments.loaded ? upcoming.length : '—'}</strong><span>предстоящих</span></div><div className="summary-stat"><strong>{appointments.loaded ? cancelledCount : '—'}</strong><span>отменённых</span></div><div className="next-appointment"><span className="eyebrow">Ближайший приём</span><strong>{appointments.error ? 'Данные недоступны' : !appointments.loaded ? 'Загружается…' : upcoming[0] ? `${shortDateFormat.format(new Date(upcoming[0].starts_at))} · ${timeFormat.format(new Date(upcoming[0].starts_at))}` : 'Ещё не назначен'}</strong></div></div>
        <div className="journal-toolbar"><div className="scope-controls" role="group" aria-label="Статус записей">{([{ id: 'all', name: 'Все записи' }, { id: 'scheduled', name: 'Активные' }, { id: 'cancelled', name: 'Отменённые' }] as const).map(filter => <button type="button" key={filter.id} className={scope === filter.id ? 'scope-button selected' : 'scope-button'} aria-pressed={scope === filter.id} onClick={() => setScope(filter.id)}>{filter.name}</button>)}</div><label className="search-field"><Icon name="search" /><span className="visually-hidden">Поиск в журнале</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Врач или пациент" /></label></div>
        <CollectionFeedback collection={appointments} noun="журнал" />
        {(!doctors.loaded || doctors.error) && <CollectionFeedback collection={doctors} noun="врачей" />}
        {(!patients.loaded || patients.error) && <CollectionFeedback collection={patients} noun="пациентов" />}
        {referencesReady && (doctors.items.length === 0 || patients.items.length === 0) && <div className="setup-note"><span>Для первой записи нужны врач и условный пациент.</span><div>{doctors.items.length === 0 && <button type="button" onClick={() => { changeView('doctors'); setEditor({ kind: 'doctor' }); }}>Добавить врача <Icon name="arrow" size={15} /></button>}{patients.items.length === 0 && <button type="button" onClick={() => { changeView('patients'); setEditor({ kind: 'patient' }); }}>Добавить пациента <Icon name="arrow" size={15} /></button>}</div></div>}
        <div className="appointment-ledger" aria-label="Записи на приём">
          {visibleAppointments.length > 0 && <div className="ledger-column-headings" aria-hidden="true"><span>Время</span><span>Врач</span><span>Пациент</span><span>Запись</span></div>}
          {[...days.entries()].map(([day, items]) => <section className="day-group" key={day} aria-labelledby={`day-${day}`}><div className="day-heading"><h2 id={`day-${day}`}>{dateFormat.format(new Date(items[0].starts_at))}</h2><span>{items.length} {items.length === 1 ? 'приём' : items.length < 5 ? 'приёма' : 'приёмов'}</span></div><ul className="appointment-list">{items.map(item => {
            const doctor = doctorById.get(item.doctor_id);
            const patient = patientById.get(item.patient_id);
            const start = new Date(item.starts_at);
            const canChange = item.status === 'scheduled' && start.valueOf() > now;
            return <li className={`appointment-row ${item.status}`} key={item.id} data-appointment-id={item.id}>
              <div className="appointment-time"><time dateTime={item.starts_at}>{timeFormat.format(start)}</time><span>до {timeFormat.format(new Date(start.valueOf() + SLOT_MS))}</span></div>
              <div className="appointment-doctor"><span className="mobile-label">Врач</span><strong>{doctor?.name ?? 'Врач не найден'}</strong><span>{doctor?.specialty ?? (doctors.loading ? 'Загружается…' : 'Обновите справочник')}</span></div>
              <div className="appointment-patient"><span className="mobile-label">Пациент</span><strong>{patient?.full_name ?? 'Пациент не найден'}</strong><span className={`status-label ${item.status}`}><span />{item.status === 'cancelled' ? 'Отменена' : 'Запланирован'}</span></div>
              <div className="appointment-actions">{canChange ? <><button type="button" className="row-action" aria-label={`Перенести запись: ${patient?.full_name ?? 'пациент'}, ${timeFormat.format(start)}`} disabled={!referencesReady} onClick={() => setEditor({ kind: 'appointment', item })}>Перенести <Icon name="arrow" size={15} /></button><button type="button" className="row-action cancel-action" aria-label={`Отменить запись: ${patient?.full_name ?? 'пациент'}, ${timeFormat.format(start)}`} onClick={() => setEditor({ kind: 'cancel', item })}>Отменить</button></> : <span className="history-note">{item.status === 'cancelled' ? 'Сохранено в журнале' : 'Время приёма прошло'}</span>}</div>
            </li>;
          })}</ul></section>)}
          {!appointments.loading && !appointments.error && appointments.loaded && visibleAppointments.length === 0 && <EmptyState title={appointments.items.length === 0 ? 'Пока нет записей' : 'Ничего не найдено'}><p>{appointments.items.length === 0 ? 'Добавьте врача и пациента, затем выберите время первого приёма.' : 'Попробуйте другое имя или покажите все статусы.'}</p>{appointments.items.length > 0 && <button className="button secondary" type="button" onClick={() => { setQuery(''); setScope('all'); }}>Показать все записи</button>}</EmptyState>}
        </div>
        <div className="journal-footnote"><div><span className="footnote-symbol" aria-hidden="true">*</span><p><strong>Одно время — один приём.</strong> Врач и пациент могут иметь только одну активную запись на слот.</p></div><span>30 минут <span aria-hidden="true">/</span> Asia/Yekaterinburg</span></div>
      </> : <>
        <div className="directory-toolbar"><span>{directory.error && !directory.loaded ? 'Справочник недоступен' : directory.loaded ? `${directory.items.length} ${view === 'doctors' ? 'в справочнике врачей' : 'в справочнике пациентов'}` : 'Загружаем справочник…'}</span><label className="search-field"><Icon name="search" /><span className="visually-hidden">{view === 'doctors' ? 'Поиск врачей' : 'Поиск пациентов'}</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={view === 'doctors' ? 'Имя или специальность' : 'Имя пациента'} /></label></div>
        {view === 'doctors' ? <CollectionFeedback collection={doctors} noun="врачей" /> : <CollectionFeedback collection={patients} noun="пациентов" />}
        <ul className="directory-list">{people.map((item, index) => <li className="directory-row" key={item.id} data-person-id={item.id}><span className="directory-number" aria-hidden="true">{String(index + 1).padStart(2, '0')}</span><div><strong>{'name' in item ? item.name : item.full_name}</strong><span>{'specialty' in item ? item.specialty : 'Условный пациент'}</span></div><button type="button" className="row-action" aria-label={`Изменить: ${'name' in item ? item.name : item.full_name}`} onClick={() => setEditor('specialty' in item ? { kind: 'doctor', item } : { kind: 'patient', item })}>Изменить <Icon name="arrow" size={16} /></button></li>)}</ul>
        {!directory.loading && !directory.error && directory.loaded && people.length === 0 && <EmptyState title={directory.items.length ? 'Ничего не найдено' : view === 'doctors' ? 'Пока нет врачей' : 'Пока нет пациентов'}><p>{directory.items.length ? 'Попробуйте другое имя в поиске.' : view === 'doctors' ? 'Добавьте первого специалиста, чтобы назначать приёмы.' : 'Добавьте вымышленное имя для первой учебной записи.'}</p></EmptyState>}
        <div className="directory-footnote"><span className="eyebrow">Учебная среда</span><p>Используйте только вымышленные имена. Все записи в этой клинике — синтетические.</p></div>
      </>}
    </main>
    <footer className="site-footer"><span>{CLINIC_NAME} <span aria-hidden="true">/</span> Учебная регистратура</span><span>Только синтетические данные</span></footer>
    {editor?.kind === 'appointment' && <AppointmentForm item={editor.item} doctors={doctors.items} patients={patients.items} focusTarget={focusTarget} onSaved={saveAppointment} onClose={() => setEditor(null)} />}
    {(editor?.kind === 'doctor' || editor?.kind === 'patient') && <PersonForm kind={editor.kind} item={editor.item} focusTarget={focusTarget} onSaved={savePerson} onClose={() => setEditor(null)} />}
    {editor?.kind === 'cancel' && <CancelForm item={editor.item} doctor={doctorById.get(editor.item.doctor_id)} patient={patientById.get(editor.item.patient_id)} focusTarget={focusTarget} onSaved={saveAppointment} onClose={() => setEditor(null)} />}
  </div>;
}
