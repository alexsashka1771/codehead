import { lazy, StrictMode, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { SceneBoundary, SceneFallback } from './world/SceneFallback';
import './app/styles.css';

const AnimationStudio = lazy(() => import('./world/AnimationStudio'));
const previewAnimations = new URLSearchParams(window.location.search).get('view') === 'animations';
createRoot(document.getElementById('root')!).render(<StrictMode>
  {previewAnimations ? <SceneBoundary><Suspense fallback={<SceneFallback loading />}><AnimationStudio /></Suspense></SceneBoundary> : <App />}
</StrictMode>);
