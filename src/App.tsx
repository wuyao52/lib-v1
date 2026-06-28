import { ReactFlowProvider } from '@xyflow/react';
import useProjectStore from './store/useProjectStore';
import ProjectSelector from './components/ProjectSelector';
import ProjectEditor from './components/ProjectEditor';

export default function App() {
  const currentView = useProjectStore((state) => state.currentView);

  return (
    <ReactFlowProvider>
      {currentView === 'home' ? <ProjectSelector /> : <ProjectEditor />}
    </ReactFlowProvider>
  );
}
