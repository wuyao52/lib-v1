import { ReactFlowProvider } from '@xyflow/react';
import useProjectStore from './store/useProjectStore';
import ProjectSelector from './components/ProjectSelector';
import ProjectEditor from './components/ProjectEditor';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { lazy, Suspense, useEffect } from 'react';

const AuthScreen = lazy(() => import('./components/AuthScreen'));

function AuthenticatedApp() {
  const { user, isLoading } = useAuth();
  const currentView = useProjectStore((state) => state.currentView);
  const setUserScope = useProjectStore((state) => state.setUserScope);

  useEffect(() => {
    if (user) setUserScope(user.id);
  }, [user, setUserScope]);

  if (isLoading) {
    return <div className="w-screen h-screen bg-dark-950 flex items-center justify-center text-dark-400">正在验证会话...</div>;
  }
  if (!user) return <Suspense fallback={null}><AuthScreen /></Suspense>;

  return <ReactFlowProvider>{currentView === 'home' ? <ProjectSelector /> : <ProjectEditor />}</ReactFlowProvider>;
}

export default function App() {
  return (
    <AuthProvider>
      <AuthenticatedApp />
    </AuthProvider>
  );
}
