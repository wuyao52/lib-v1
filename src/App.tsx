import { ReactFlowProvider } from '@xyflow/react';
import useProjectStore from './store/useProjectStore';
import ProjectSelector from './components/ProjectSelector';
import ProjectEditor from './components/ProjectEditor';
import { AuthProvider, useAuth } from './auth/AuthContext';
import { lazy, Suspense, useEffect, useState } from 'react';

const AuthScreen = lazy(() => import('./components/AuthScreen'));

function AuthenticatedApp() {
  const { user, isLoading } = useAuth();
  const currentView = useProjectStore((state) => state.currentView);
  const setUserScope = useProjectStore((state) => state.setUserScope);
  const [readyUserId, setReadyUserId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    if (!user) {
      setReadyUserId(null);
      return () => { active = false; };
    }
    setReadyUserId(null);
    Promise.resolve(setUserScope(user.id)).then(() => {
      if (active) setReadyUserId(user.id);
    });
    return () => { active = false; };
  }, [user, setUserScope]);

  if (isLoading) {
    return <div className="w-screen h-screen bg-dark-950 flex items-center justify-center text-dark-400">正在验证会话...</div>;
  }
  if (!user) return <Suspense fallback={null}><AuthScreen /></Suspense>;
  if (readyUserId !== user.id) {
    return <div className="w-screen h-screen bg-dark-950 flex items-center justify-center text-dark-400">正在加载当前账号项目...</div>;
  }

  return <ReactFlowProvider>{currentView === 'home' ? <ProjectSelector /> : <ProjectEditor />}</ReactFlowProvider>;
}

export default function App() {
  return (
    <AuthProvider>
      <AuthenticatedApp />
    </AuthProvider>
  );
}
