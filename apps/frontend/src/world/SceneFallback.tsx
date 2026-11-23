import { Component, type ReactNode } from 'react';
import { AlertTriangle, Boxes } from 'lucide-react';

export function SceneFallback({ loading = false }: { loading?: boolean }) {
  return <div className="scene-fallback" role="status">
    <div className="fallback-header">
      {loading ? <Boxes size={34} strokeWidth={1.5} aria-hidden="true" /> :
        <AlertTriangle size={34} strokeWidth={1.5} aria-hidden="true" />}
      <h3>{loading ? 'Загружаем фабрику…' : '3D-сцена недоступна'}</h3>
    </div>
    <p>{loading ? 'Подготавливаем трёхмерный вид.' : 'Панели ролей и управление проектом остаются доступны.'}</p>
  </div>;
}

export class SceneBoundary extends Component<{ children: ReactNode; onReset?: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error) { console.error('Factory scene rendering failed:', error); }
  render() { return this.state.failed ? <SceneFallback /> : this.props.children; }
}
