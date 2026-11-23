import { useState, type FormEvent } from 'react';
import { ArrowRight, X } from 'lucide-react';
import type { CreateProject } from '../../../../packages/contracts';

interface Props {
  pending: boolean; onSubmit: (input: CreateProject) => Promise<boolean>; onClose?: () => void;
}

export function ProjectForm({ pending, onSubmit, onClose }: Props) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (await onSubmit({ name: name.trim(), description: description.trim(), profile: 'clinic_demo' })) {
      setName(''); setDescription(''); onClose?.();
    }
  }
  return <form className="project-form" onSubmit={submit} aria-label="Новый проект">
    <div className="section-title"><h2>Новый проект</h2>{onClose ? <button type="button" className="icon-button" aria-label="Закрыть создание проекта" disabled={pending} onClick={onClose}><X size={17} /></button> : null}</div>
    <p className="supporting-text">Опишите небольшое приложение. Начнём с профиля клиники.</p>
    <label htmlFor="project-name">Название проекта</label>
    <input id="project-name" name="name" required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} placeholder="Например, Клиника рядом" disabled={pending} autoComplete="off" />
    <label htmlFor="project-description">Что нужно создать</label>
    <textarea id="project-description" name="description" required minLength={10} maxLength={8000} rows={4} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Врачи, условные пациенты и запись на приём…" disabled={pending} aria-describedby="description-hint" />
    <span id="description-hint" className="field-hint">От 10 символов. Только учебные данные.</span>
    <div className="profile-field"><span>Профиль</span><strong>Clinic Demo</strong></div>
    <button className="button primary full-width" disabled={pending || !name.trim() || description.trim().length < 10} type="submit">{pending ? 'Сохраняем…' : 'Создать проект'}<ArrowRight size={16} /></button>
  </form>;
}
