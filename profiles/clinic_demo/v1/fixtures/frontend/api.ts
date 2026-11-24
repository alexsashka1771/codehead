export type UUID = string;

export interface Doctor {
  id: UUID;
  name: string;
  specialty: string;
}

export interface Patient {
  id: UUID;
  full_name: string;
}

export interface Appointment {
  id: UUID;
  doctor_id: UUID;
  patient_id: UUID;
  starts_at: string;
  status: 'scheduled' | 'cancelled';
}

export type DoctorInput = Pick<Doctor, 'name' | 'specialty'>;
export type PatientInput = Pick<Patient, 'full_name'>;
export type AppointmentInput = Pick<Appointment, 'doctor_id' | 'patient_id' | 'starts_at'>;

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

export function asApiError(error: unknown): ApiError {
  return error instanceof ApiError
    ? error
    : new ApiError(0, 'request_failed', 'Не удалось завершить запрос. Проверьте соединение и повторите попытку.');
}

async function request<T>(path: string, method = 'GET', payload?: object, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: payload === undefined
        ? { Accept: 'application/json' }
        : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal,
    });
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    throw new ApiError(0, 'network_error', 'Сервер недоступен. Проверьте соединение и повторите попытку.');
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    throw new ApiError(response.status, 'invalid_response', 'Сервер вернул нечитаемый ответ. Повторите запрос.');
  }

  if (!response.ok) {
    if (typeof body === 'object' && body !== null && 'code' in body && 'message' in body
      && typeof body.code === 'string' && typeof body.message === 'string') {
      throw new ApiError(response.status, body.code, body.message);
    }
    throw new ApiError(response.status, 'request_failed', 'Сервер не смог выполнить запрос. Повторите попытку.');
  }
  return body as T;
}

export const api = {
  doctors: {
    list: (signal?: AbortSignal) => request<Doctor[]>('/api/doctors', 'GET', undefined, signal),
    create: (input: DoctorInput) => request<Doctor>('/api/doctors', 'POST', input),
    update: (id: UUID, input: Partial<DoctorInput>) => request<Doctor>(`/api/doctors/${encodeURIComponent(id)}`, 'PATCH', input),
  },
  patients: {
    list: (signal?: AbortSignal) => request<Patient[]>('/api/patients', 'GET', undefined, signal),
    create: (input: PatientInput) => request<Patient>('/api/patients', 'POST', input),
    update: (id: UUID, input: Partial<PatientInput>) => request<Patient>(`/api/patients/${encodeURIComponent(id)}`, 'PATCH', input),
  },
  appointments: {
    list: (signal?: AbortSignal) => request<Appointment[]>('/api/appointments', 'GET', undefined, signal),
    create: (input: AppointmentInput) => request<Appointment>('/api/appointments', 'POST', input),
    update: (id: UUID, input: Partial<AppointmentInput>) => request<Appointment>(`/api/appointments/${encodeURIComponent(id)}`, 'PATCH', input),
    cancel: (id: UUID) => request<Appointment>(`/api/appointments/${encodeURIComponent(id)}/cancel`, 'POST', {}),
  },
};
