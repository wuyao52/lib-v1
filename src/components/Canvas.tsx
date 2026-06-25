import React, { useCallback, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  SelectionMode,
  useReactFlow,
  useOnSelectionChange,
} from '@xyflow/react';
import type { NodeTypes, OnConnectEnd, Connection, Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import useProjectStore from '@/store/useProjectStore';
import SceneNodeComponent from './SceneNode';
import GenerationModal, { GenerationSettings } from './GenerationModal';
import RemoveWatermarkModal from './RemoveWatermarkModal';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, Image, Video, Droplets, Wand2, Link2 } from 'lucide-react';

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
  const {
    project,
    onNodesChange,
    onEdgesChange,
    onConnect,
    setSelectedNode,
    addNode,
    startGenerationWithType,
  } = useProjectStore();

  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const { screenToFlowPosition, getNodes } = useReactFlow();

  // 框选模式状态
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  // 拖放状态
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  // 选中的节点
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);

  // 生成弹窗状态
  const [showGenerationModal, setShowGenerationModal] = useState(false);
  const [generationSourceNode, setGenerationSourceNode] = useState<string | null>(null);
  const [generationPosition, setGenerationPosition] = useState({ x: 0, y: 0 });

  // 去水印弹窗状态
  const [showWatermarkModal, setShowWatermarkModal] = useState(false);
  const [watermarkSourceUrl, setWatermarkSourceUrl] = useState<string>('');
  const [watermarkSourceType, setWatermarkSourceType] = useState<'image' | 'video'>('image');

  // 监听选中节点变化
  const onSelectionChange = useCallback(({ nodes }: { nodes: any[] }) => {
    setSelectedNodeIds(nodes.map(n => n.id));
  }, []);

  useOnSelectionChange({ onChange: onSelectionChange });

  // 检测是否为文件拖放
  const hasFiles = (event: React.DragEvent) => {
    return event.dataTransfer.types.includes('Files');
  };

  // 获取文件类型
  const getFileType = (file: File): 'image' | 'video' | null => {
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('video/')) return 'video';
    return null;
  };

  // 读取文件为 Data URL
  const readFileAsDataURL = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  // 处理拖放进入
  const onDragEnter = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    if (hasFiles(event)) {
      setIsDraggingFile(true);
    }
  }, []);

  // 处理拖放
  const onDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = hasFiles(event) ? 'copy' : 'move';
  }, []);

  // 处理拖放离开
  const onDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    const rect = reactFlowWrapper.current?.getBoundingClientRect();
    if (rect) {
      const { clientX, clientY } = event;
      if (
        clientX <= rect.left ||
        clientX >= rect.right ||
        clientY <= rect.top ||
        clientY >= rect.bottom
      ) {
        setIsDraggingFile(false);
      }
    }
  }, []);

  // 处理文件拖放
  const handleFileDrop = useCallback(
    async (event: React.DragEvent) => {
      if (!project) return;

      const files = Array.from(event.dataTransfer.files);

      for (const file of files) {
        const fileType = getFileType(file);
        if (!fileType) continue;

        const position = {
          x: event.clientX - 200,
          y: event.clientY - 100,
        };

        try {
          const dataUrl = await readFileAsDataURL(file);
          const fileName = file.name.replace(/\.[^/.]+$/, '');

          const newNode = {
            id: `scene-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            type: 'sceneNode' as const,
            position: {
              x: position.x + (files.indexOf(file) * 50),
              y: position.y + (files.indexOf(file) * 50),
            },
            data: {
              label: fileName || `${fileType === 'image' ? '图片' : '视频'}场景`,
              type: fileType,
              content: file.name,
              duration: fileType === 'video' ? 10 : 5,
              prompt: '',
              generatedContent: dataUrl,
              settings: {
                style: project.settings.defaultStyle,
                mood: '',
                camera: '',
                lighting: '',
              },
              status: 'completed' as const,
              progress: 100,
            },
          };

          addNode(newNode);
        } catch (error) {
          console.error('读取文件失败:', error);
        }
      }

      setIsDraggingFile(false);
    },
    [project, addNode]
  );

  const onDrop = useCallback(
    (event: React.DragEvent) => {
      event.preventDefault();

      // 处理文件拖放
      if (hasFiles(event)) {
        handleFileDrop(event);
        return;
      }

      // 处理内部节点拖放
      if (!project) return;

      const type = event.dataTransfer.getData('application/reactflow');
      if (!type) return;

      const position = {
        x: event.clientX - 200,
        y: event.clientY - 100,
      };

      const newNode = {
        id: `scene-${Date.now()}`,
        type: 'sceneNode' as const,
        position,
        data: {
          label: `新场景 ${project.nodes.length + 1}`,
          type: type as any,
          content: '',
          duration: 5,
          prompt: '',
          settings: {
            style: project.settings.defaultStyle,
            mood: '',
            camera: '',
            lighting: '',
          },
          status: 'idle' as const,
          progress: 0,
        },
      };

      addNode(newNode);
    },
    [project, addNode, handleFileDrop]
  );

  // 处理连接结束事件（拖拽到空白区域才弹出菜单）
  const onConnectEnd: OnConnectEnd = useCallback(
    (event, connectionState) => {
      // 如果连接成功，不处理
      if (connectionState.isValid) return;

      // 获取拖拽起始节点
      const sourceNodeId = connectionState.fromNode?.id;
      if (!sourceNodeId) return;

      // 获取鼠标位置
      const clientX = 'clientX' in event ? event.clientX : (event as TouchEvent).touches?.[0]?.clientX;
      const clientY = 'clientY' in event ? event.clientY : (event as TouchEvent).touches?.[0]?.clientY;

      if (clientX === undefined || clientY === undefined) return;

      // 检查鼠标是否在某个节点上（如果是，则不弹出菜单，让 React Flow 处理连接）
      const nodes = getNodes();
      const mousePos = screenToFlowPosition({ x: clientX, y: clientY });

      const isOverNode = nodes.some(node => {
        const nodeWidth = 320; // 节点宽度
        const nodeHeight = 200; // 节点高度（大约）
        const nodeX = node.position.x;
        const nodeY = node.position.y;

        return (
          mousePos.x >= nodeX &&
          mousePos.x <= nodeX + nodeWidth &&
          mousePos.y >= nodeY &&
          mousePos.y <= nodeY + nodeHeight
        );
      });

      // 如果鼠标在节点上，不弹出菜单（让 React Flow 处理连接）
      if (isOverNode) {
        console.log('鼠标在节点上，不弹出生成菜单');
        return;
      }

      // 只有在空白区域才弹出生成菜单
      const position = screenToFlowPosition({
        x: clientX,
        y: clientY,
      });

      setGenerationSourceNode(sourceNodeId);
      setGenerationPosition(position);
      setShowGenerationModal(true);
    },
    [screenToFlowPosition, getNodes]
  );

  // 处理普通连接（支持批量连接）
  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!project) return;

      const sourceId = connection.source;
      const targetId = connection.target;

      // 如果有多个节点被选中，且源节点是选中的节点之一，则批量连接
      if (selectedNodeIds.length > 1 && selectedNodeIds.includes(sourceId!)) {
        console.log('批量连接:', selectedNodeIds, '->', targetId);

        // 为所有选中的节点创建连接
        const newEdges: Edge[] = selectedNodeIds
          .filter(nodeId => nodeId !== targetId) // 排除目标节点自身
          .map(nodeId => ({
            id: `edge-${nodeId}-${targetId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            source: nodeId,
            target: targetId!,
            type: 'smoothstep',
            animated: true,
            style: { stroke: '#8b5cf6', strokeWidth: 2 },
          }));

        // 批量添加边
        onEdgesChange(
          newEdges.map(edge => ({
            type: 'add' as const,
            item: edge,
          }))
        );
      } else {
        // 单个连接
        onConnect(connection);
      }
    },
    [project, selectedNodeIds, onConnect, onEdgesChange]
  );

  // 处理生成类型选择
  const handleGenerationSelect = useCallback(
    (type: 'video' | 'image' | 'img2img', settings: GenerationSettings) => {
      if (!generationSourceNode || !project) return;

      // 调用 store 中的生成方法
      startGenerationWithType(generationSourceNode, type, settings, generationPosition);

      setShowGenerationModal(false);
      setGenerationSourceNode(null);
    },
    [generationSourceNode, generationPosition, project, startGenerationWithType]
  );

  // 打开去水印弹窗
  const handleOpenWatermarkModal = useCallback((sourceUrl?: string, sourceType?: 'image' | 'video') => {
    setWatermarkSourceUrl(sourceUrl || '');
    setWatermarkSourceType(sourceType || 'image');
    setShowWatermarkModal(true);
  }, []);

  // 处理画布点击（取消选中）
  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
  }, [setSelectedNode]);

  // 切换框选模式
  const toggleSelectionMode = useCallback(() => {
    setIsSelectionMode((prev) => !prev);
  }, []);

  // 获取源节点的图片（用于图生图）
  const getSourceImageUrl = useCallback(() => {
    if (!generationSourceNode || !project) return undefined;
    const node = project.nodes.find(n => n.id === generationSourceNode);
    if (node && node.data.type === 'image' && node.data.generatedContent) {
      return node.data.generatedContent;
    }
    return undefined;
  }, [generationSourceNode, project]);

  if (!project) return null;

  return (
    <div
      ref={reactFlowWrapper}
      className="w-full h-full relative"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
    >
      {/* 工具按钮区域 */}
      <div className="absolute top-20 right-4 z-50 flex flex-col gap-2">
        {/* 框选模式切换按钮 */}
        <button
          onClick={toggleSelectionMode}
          className={`
            flex items-center gap-2 px-3 py-2 rounded-lg
            text-xs font-medium transition-all
            ${isSelectionMode
              ? 'bg-primary-600 text-white shadow-lg shadow-primary-500/30'
              : 'bg-dark-800/90 text-dark-300 hover:text-white border border-dark-600/50'
            }
          `}
          title={isSelectionMode ? '点击切换为拖拽模式' : '点击切换为框选模式'}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="3 2"
          >
            <rect x="2" y="2" width="12" height="12" rx="1" />
          </svg>
          {isSelectionMode ? '框选模式' : '拖拽模式'}
        </button>

        {/* 去水印按钮 */}
        <button
          onClick={() => handleOpenWatermarkModal()}
          className="flex items-center gap-2 px-3 py-2 rounded-lg
            text-xs font-medium transition-all
            bg-dark-800/90 text-dark-300 hover:text-white border border-dark-600/50
            hover:border-cyan-500/50 hover:bg-cyan-500/10"
          title="去除水印"
        >
          <Droplets className="w-4 h-4" />
          去水印
        </button>
      </div>

      {/* 提示信息 */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="absolute bottom-16 left-1/2 -translate-x-1/2 z-40"
      >
        <div className="bg-dark-800/90 backdrop-blur-xl rounded-full px-4 py-2
          border border-dark-600/50 shadow-xl">
          <div className="flex items-center gap-2 text-xs text-dark-400">
            <Wand2 className="w-3 h-3 text-primary-400" />
            <span>从节点连接点拖拽到空白处可选择生成类型</span>
          </div>
        </div>
      </motion.div>

      {/* 文件拖放提示层 */}
      <AnimatePresence>
        {isDraggingFile && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-0 z-[100] pointer-events-none"
          >
            <div className="absolute inset-4 border-2 border-dashed border-primary-500 rounded-2xl
              bg-primary-500/10 backdrop-blur-sm flex items-center justify-center">
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

      {/* 选中节点数量提示 */}
      {selectedNodeIds.length > 1 && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="absolute top-4 left-1/2 -translate-x-1/2 z-50"
        >
          <div className="bg-primary-600/90 backdrop-blur-xl rounded-full px-4 py-2
            border border-primary-400/50 shadow-xl flex items-center gap-2">
            <Link2 className="w-4 h-4 text-white" />
            <span className="text-sm text-white font-medium">
              已选中 {selectedNodeIds.length} 个节点 - 拖拽连接可批量连接
            </span>
          </div>
        </motion.div>
      )}

      <ReactFlow
        nodes={project.nodes}
        edges={project.edges}
        onNodesChange={onNodesChange}
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
        defaultEdgeOptions={{
          type: 'smoothstep',
          animated: true,
          style: { stroke: '#8b5cf6', strokeWidth: 2 },
        }}
        className="bg-dark-950"
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={24}
          size={1.5}
          color="#334155"
        />

        <Controls
          className="!bg-dark-800 !border-dark-600 !rounded-xl !shadow-xl"
          showInteractive={false}
        />

        <MiniMap
          style={minimapStyle}
          nodeColor={(node) => {
            const colors: Record<string, string> = {
              text: '#3b82f6',
              image: '#a855f7',
              video: '#f97316',
              audio: '#22c55e',
              transition: '#eab308',
            };
            return colors[node.data?.type as string] || '#64748b';
          }}
          maskColor="rgba(0, 0, 0, 0.7)"
          pannable
          zoomable
        />
      </ReactFlow>

      {/* 生成类型选择弹窗 */}
      <GenerationModal
        isOpen={showGenerationModal}
        onClose={() => {
          setShowGenerationModal(false);
          setGenerationSourceNode(null);
        }}
        onSelect={handleGenerationSelect}
        sourceImageUrl={getSourceImageUrl()}
        sourceNodeType={project.nodes.find(n => n.id === generationSourceNode)?.data.type}
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
