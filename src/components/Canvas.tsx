import { useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  SelectionMode,
  useReactFlow,
} from '@xyflow/react';
import type { NodeTypes, OnConnectEnd, Connection } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import useProjectStore from '@/store/useProjectStore';
import SceneNodeComponent from './SceneNode';
import GenerationModal, { GenerationSettings } from './GenerationModal';
import RemoveWatermarkModal from './RemoveWatermarkModal';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, Image, Video, Droplets, Wand2, Plus } from 'lucide-react';

// 自定义节点类型
const nodeTypes: NodeTypes = {
  sceneNode: SceneNodeComponent as any,
};

// 小地图样式
const minimapStyle = {
  height: 120,
  width: 180,
  backgroundColor: '#1e293b',
  border: '1px solid #334155',
  borderRadius: '12px',
};

export default function Canvas() {
  const { screenToFlowPosition } = useReactFlow();
  const {
    project,
    onNodesChange,
    onEdgesChange,
    onConnect,
    setSelectedNode,
    addNode,
    startGenerationWithType,
    pushToHistory,
  } = useProjectStore();

  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const generationSourceNodeRef = useRef<string | null>(null);
  const generationPositionRef = useRef({ x: 0, y: 0 });

  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [showGenerationModal, setShowGenerationModal] = useState(false);
  const [showWatermarkModal, setShowWatermarkModal] = useState(false);
  const [watermarkSourceUrl, setWatermarkSourceUrl] = useState('');
  const [watermarkSourceType, setWatermarkSourceType] = useState<'image' | 'video'>('image');

  // 检查是否有弹窗打开
  const hasModalOpen = showGenerationModal || showWatermarkModal;

  const hasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes('Files');

  const getFileType = (file: File): 'image' | 'video' | null => {
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('video/')) return 'video';
    return null;
  };

  const readFileAsDataURL = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });

  // 拖放处理
  const onDragEnter = (event: React.DragEvent) => {
    event.preventDefault();
    if (hasModalOpen) return; // 弹窗打开时忽略
    if (hasFiles(event)) setIsDraggingFile(true);
  };

  const onDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    if (hasModalOpen) return; // 弹窗打开时忽略
    event.dataTransfer.dropEffect = hasFiles(event) ? 'copy' : 'move';
  };

  const onDragLeave = (event: React.DragEvent) => {
    event.preventDefault();
    if (hasModalOpen) return; // 弹窗打开时忽略
    const rect = reactFlowWrapper.current?.getBoundingClientRect();
    if (rect) {
      const { clientX, clientY } = event;
      if (clientX <= rect.left || clientX >= rect.right || clientY <= rect.top || clientY >= rect.bottom) {
        setIsDraggingFile(false);
      }
    }
  };

  const handleFileDrop = async (event: React.DragEvent) => {
    if (!project || hasModalOpen) return; // 弹窗打开时忽略
    const files = Array.from(event.dataTransfer.files);
    const dropPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });

    for (const file of files) {
      const fileType = getFileType(file);
      if (!fileType) continue;

      try {
        const dataUrl = await readFileAsDataURL(file);
        const fileName = file.name.replace(/\.[^/.]+$/, '');

        addNode({
          id: `scene-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`,
          type: 'sceneNode',
          position: { x: dropPosition.x - 100, y: dropPosition.y - 60 },
          data: {
            label: fileName || `${fileType === 'image' ? '图片' : '视频'}场景`,
            type: fileType,
            content: file.name,
            duration: fileType === 'video' ? 10 : 5,
            prompt: '',
            generatedContent: dataUrl,
            settings: { style: project.settings.defaultStyle, mood: '', camera: '', lighting: '' },
            status: 'completed',
            progress: 100,
          },
        });
      } catch (error) {
        console.error('读取文件失败:', error);
      }
    }
    setIsDraggingFile(false);
  };

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    if (hasFiles(event)) {
      handleFileDrop(event);
      return;
    }
    if (!project) return;

    const type = event.dataTransfer.getData('application/reactflow');
    if (!type) return;

    addNode({
      id: `scene-${Date.now()}`,
      type: 'sceneNode',
      position: screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      data: {
        label: `新场景 ${project.nodes.length + 1}`,
        type: type as any,
        content: '',
        duration: 5,
        prompt: '',
        settings: { style: project.settings.defaultStyle, mood: '', camera: '', lighting: '' },
        status: 'idle',
        progress: 0,
      },
    });
  };

  // 连接结束处理
  const onConnectEnd: OnConnectEnd = (event, connectionState) => {
    if (connectionState.isValid) return;
    const sourceNodeId = connectionState.fromNode?.id;
    if (!sourceNodeId) return;

    const clientX = 'clientX' in event ? event.clientX : (event as TouchEvent).touches?.[0]?.clientX;
    const clientY = 'clientY' in event ? event.clientY : (event as TouchEvent).touches?.[0]?.clientY;
    if (clientX === undefined || clientY === undefined) return;

    const wrapper = reactFlowWrapper.current;
    if (!wrapper) return;

    generationSourceNodeRef.current = sourceNodeId;
    generationPositionRef.current = screenToFlowPosition({ x: clientX, y: clientY });
    setShowGenerationModal(true);
  };

  const handleConnect = (connection: Connection) => onConnect(connection);

  const handleGenerationSelect = (type: 'video' | 'image' | 'img2img', settings: GenerationSettings) => {
    const sourceNode = generationSourceNodeRef.current;
    if (!sourceNode || !project) return;
    startGenerationWithType(sourceNode, type, settings, generationPositionRef.current);
    setShowGenerationModal(false);
    generationSourceNodeRef.current = null;
  };

  const onPaneClick = () => setSelectedNode(null);

  if (!project) return null;

  const sourceNode = project.nodes.find(n => n.id === generationSourceNodeRef.current);
  const selectedNodes = project.nodes.filter((node) => node.selected);
  const createBatchNode = () => {
    if (selectedNodes.length < 2) return;
    const right = Math.max(...selectedNodes.map((node) => node.position.x + 240));
    const top = selectedNodes.reduce((sum, node) => sum + node.position.y, 0) / selectedNodes.length;
    const id = `scene-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    addNode({ id, type: 'sceneNode', position: { x: right + 120, y: top }, data: {
      label: `批量组件 ${project.nodes.length + 1}`, type: 'transition', content: '', duration: 5,
      prompt: selectedNodes.map((node) => `@[${node.data.label}](${node.id})`).join(' '),
      settings: { style: project.settings.defaultStyle, mood: '', camera: '', lighting: '' }, status: 'idle', progress: 0,
    } });
    selectedNodes.forEach((node) => onConnect({ source: node.id, target: id, sourceHandle: null, targetHandle: null }));
    setSelectedNode(id);
  };

  return (
    <div
      ref={reactFlowWrapper}
      className="w-full h-full relative"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
    >
      {/* 工具按钮 */}
      <div className="absolute top-20 right-4 z-50 flex flex-col gap-2">
        <button
          onClick={() => setIsSelectionMode(prev => !prev)}
          className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all ${
            isSelectionMode
              ? 'bg-primary-600 text-white shadow-lg shadow-primary-500/30'
              : 'bg-dark-800/90 text-dark-300 hover:text-white border border-dark-600/50'
          }`}
          title={isSelectionMode ? '点击切换为拖拽模式' : '点击切换为框选模式'}
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 2">
            <rect x="2" y="2" width="12" height="12" rx="1" />
          </svg>
          {isSelectionMode ? '框选模式' : '拖拽模式'}
        </button>

        <button
          onClick={() => {
            setWatermarkSourceUrl('');
            setWatermarkSourceType('image');
            setShowWatermarkModal(true);
          }}
          className="flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-all
            bg-dark-800/90 text-dark-300 hover:text-white border border-dark-600/50 hover:border-cyan-500/50 hover:bg-cyan-500/10"
          title="去除水印"
        >
          <Droplets className="w-4 h-4" />
          去水印
        </button>
      </div>

      {/* 提示信息 */}
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="absolute bottom-16 left-1/2 -translate-x-1/2 z-40">
        <div className="bg-dark-800/90 backdrop-blur-xl rounded-full px-4 py-2 border border-dark-600/50 shadow-xl">
          <div className="flex items-center gap-2 text-xs text-dark-400">
            <Wand2 className="w-3 h-3 text-primary-400" />
            <span>从节点连接点拖拽到空白处可选择生成类型</span>
          </div>
        </div>
      </motion.div>

      {/* 文件拖放提示 */}
      <AnimatePresence>
        {isDraggingFile && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="absolute inset-0 z-[100] pointer-events-none">
            <div className="absolute inset-4 border-2 border-dashed border-primary-500 rounded-2xl bg-primary-500/10 backdrop-blur-sm flex items-center justify-center">
              <div className="text-center">
                <div className="flex justify-center gap-6 mb-4">
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-16 h-16 rounded-xl bg-purple-500/20 flex items-center justify-center">
                      <Image className="w-8 h-8 text-purple-400" />
                    </div>
                    <span className="text-sm text-purple-300">图片</span>
                  </div>
                  <div className="flex flex-col items-center gap-2">
                    <div className="w-16 h-16 rounded-xl bg-orange-500/20 flex items-center justify-center">
                      <Video className="w-8 h-8 text-orange-400" />
                    </div>
                    <span className="text-sm text-orange-300">视频</span>
                  </div>
                </div>
                <div className="flex items-center gap-2 text-white">
                  <Upload className="w-5 h-5 animate-bounce" />
                  <span className="text-lg font-medium">拖放文件到此处</span>
                </div>
                <p className="text-sm text-dark-300 mt-2">支持 JPG、PNG、GIF、MP4、MOV 等格式</p>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <ReactFlow
        nodes={project.nodes}
        edges={project.edges}
        onNodesChange={onNodesChange}
        onNodeDragStop={pushToHistory}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onConnectEnd={onConnectEnd}
        onPaneClick={onPaneClick}
        onDragOver={onDragOver}
        onDrop={onDrop}
        nodeTypes={nodeTypes}
        fitView
        snapToGrid
        snapGrid={[16, 16]}
        selectionOnDrag={isSelectionMode}
        panOnDrag={!isSelectionMode}
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode="Shift"
        selectionKeyCode={null}
        defaultEdgeOptions={{ type: 'smoothstep', animated: true, style: { stroke: '#8b5cf6', strokeWidth: 2 } }}
        className="bg-dark-950"
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="#334155" />
        <Controls className="!bg-dark-800 !border-dark-600 !rounded-xl !shadow-xl" showInteractive={false} />
        <MiniMap
          style={minimapStyle}
          nodeColor={(node) => {
            const colors: Record<string, string> = { text: '#3b82f6', image: '#a855f7', video: '#f97316', audio: '#22c55e', transition: '#eab308' };
            return colors[node.data?.type as string] || '#64748b';
          }}
          maskColor="rgba(0, 0, 0, 0.7)"
          pannable
          zoomable
        />
      </ReactFlow>

      {selectedNodes.length > 1 && (
        <div className="absolute left-1/2 top-20 -translate-x-1/2 z-50 flex items-center gap-3 rounded-xl border border-primary-500/50 bg-dark-800/95 px-3 py-2 shadow-xl backdrop-blur">
          <span className="text-xs text-dark-200">已选 {selectedNodes.length} 个目标</span>
          <button onClick={createBatchNode} title="将选中目标连接到新组件" className="flex items-center gap-1 rounded-lg bg-primary-600 px-3 py-1.5 text-xs text-white hover:bg-primary-500">
            <Plus className="h-4 w-4" /> 新建连接组件
          </button>
        </div>
      )}

      {/* 生成弹窗 */}
      <GenerationModal
        isOpen={showGenerationModal}
        onClose={() => {
          setShowGenerationModal(false);
          generationSourceNodeRef.current = null;
        }}
        onSelect={handleGenerationSelect}
        sourceImageUrl={sourceNode?.data?.generatedContent}
        sourceNodeType={sourceNode?.data?.type}
        mentionableNodes={project.nodes.filter((node) => node.id !== generationSourceNodeRef.current).map((node) => ({ id: node.id, label: node.data.label, type: node.data.type }))}
      />

      {/* 去水印弹窗 */}
      <RemoveWatermarkModal
        isOpen={showWatermarkModal}
        onClose={() => setShowWatermarkModal(false)}
        sourceUrl={watermarkSourceUrl}
        sourceType={watermarkSourceType}
      />
    </div>
  );
}
