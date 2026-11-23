import type { Role, RoleDefinition, RunStatus, TaskStatus } from '../../../../packages/contracts';

export const roleOrder: Role[] = ['product_manager', 'architect', 'cto', 'backend', 'frontend', 'qa', 'devops'];
export const roleDetails: Record<Role, { short: string; name: string; color: string; description: string; task: string; location: RoleDefinition['location'] }> = {
  product_manager: { short: 'PM', name: 'Product Manager', color: '#ff9c54', location: 'product', description: 'Превращает описание продукта в требования и проверяемые сценарии.', task: 'Требования и сценарии' },
  architect: { short: 'AR', name: 'Architect', color: '#52c8ff', location: 'architecture', description: 'Проектирует устройство приложения, модель данных и контракт API.', task: 'Архитектура приложения' },
  cto: { short: 'CTO', name: 'CTO', color: '#ffc477', location: 'architecture', description: 'Проверяет технический план перед передачей в разработку.', task: 'Техническое ревью' },
  backend: { short: 'BE', name: 'Backend', color: '#49bfff', location: 'development', description: 'Реализует серверную логику и работу с данными Clinic Demo.', task: 'Сервер приложения' },
  frontend: { short: 'FE', name: 'Frontend', color: '#ffaf75', location: 'development', description: 'Создаёт интерфейс приложения по общему контракту API.', task: 'Интерфейс приложения' },
  qa: { short: 'QA', name: 'QA', color: '#a0d9ff', location: 'qa', description: 'Проверяет приложение и фиксирует результаты настоящих тестов.', task: 'Проверка приложения' },
  devops: { short: 'DO', name: 'DevOps', color: '#6eb1ff', location: 'devops', description: 'Готовит воспроизводимую локальную сборку и запуск приложения.', task: 'Локальная сборка' },
};

export const fallbackRoles: RoleDefinition[] = roleOrder.map((role) => ({
  role, name: roleDetails[role].name, location: roleDetails[role].location,
  appearance_id: `${role}-v1`, instructions_version: '1',
}));

export const runLabels: Record<RunStatus, string> = {
  created: 'Ожидает worker', running: 'Выполняется', pausing: 'Приостанавливается', paused: 'На паузе',
  blocked: 'Заблокирован', succeeded: 'Завершён', failed: 'Ошибка запуска', cancelled: 'Отменён',
};
export const taskLabels: Record<TaskStatus, string> = {
  queued: 'В очереди', running: 'Выполняется', waiting_for_decision: 'Ждёт решения', blocked: 'Заблокирована',
  succeeded: 'Завершена', failed: 'Ошибка', cancelled: 'Отменена',
};
export const lifecycleLabels = { offline: 'Офлайн', idle: 'Ожидает', busy: 'Работает', blocked: 'Блокировка', failed: 'Ошибка' };
export const terminalStatuses: RunStatus[] = ['succeeded', 'failed', 'cancelled'];
export const zoneNames: Record<RoleDefinition['location'], string> = {
  product: 'Продукт', architecture: 'Архитектура', development: 'Разработка', qa: 'Тестирование',
  security: 'Безопасность', devops: 'Сборка', production: 'Выпуск', research: 'Исследования', meeting: 'Совещания', core: 'Ядро',
};

export function formatTime(value: string, date = false) {
  return new Intl.DateTimeFormat('ru-RU', date
    ? { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }
    : { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(value));
}
