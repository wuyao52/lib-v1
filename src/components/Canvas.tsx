import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  SelectionMode,
  ConnectionLineType,
  useReactFlow,
  ViewportPortal,
} from '@xyflow/react';
import type { NodeTypes, OnConnectStart, OnConnectEnd, Connection, OnNodeDrag } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import useProjectStore from '@/store/useProjectStore';
import SceneNodeComponent from './SceneNode';
import GenerationModal, { GenerationSettings } from './GenerationModal';
import RemoveWatermarkModal from './RemoveWatermarkModal';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, Image, Video, Droplets, Wand2, Plus, Wallet, GitMerge } from 'lucide-react';
import { useAuth } from '@/auth/AuthContext';
import { ApiError, apiRequest } from '@/services/apiClient';
import { uploadAssetFile } from '@/services/assetService';
import { alignNode, type AlignmentGuide, type AlignmentNode } from '@/utils/alignmentGuides';
import type { SceneNode } from '@/types';

const MAX_FILES_PER_DROP = 20;
const UPLOAD_CONCURRENCY = 4;
const NODE_CONNECTION_TOLERANCE_PX = 36;
const ALIGNMENT_TOLERANCE_PX = 8;
const DEFAULT_NODE_WIDTH = 320;
const DEFAULT_NODE_HEIGHT = 240;

const wait = (milliseconds: number) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));

const shouldRetryUpload = (error: unknown) => {
  const status = error instanceof ApiError ? error.status : Number((error as { status?: unknown })?.status || 0);
  return !status || status === 408 || status === 429 || status >= 500;
};

async function uploadFileWithRetry(file: File): Promise<string> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await uploadAssetFile(file);
    } catch (error) {
      lastError = error;
      if (!shouldRetryUpload(error) || attempt === 2) throw error;
      await wait(500 * (attempt + 1));
    }
  }
  throw lastError;
}

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
  const { user } = useAuth();
  const { screenToFlowPosition, getZoom } = useReactFlow();
  const {
    project,
    onNodesChange,
    onEdgesChange,
    onConnect,
    setSelectedNode,
    addNode,
    addNodes,
    startGenerationWithType,
    pushToHistory,
  } = useProjectStore();

  const reactFlowWrapper = useRef<HTMLDivElement>(null);
  const generationSourceNodeIdsRef = useRef<string[]>([]);
  const connectionSourceNodeIdsRef = useRef<string[]>([]);
  const batchConnectionSourceIdsRef = useRef<string[]>([]);
  const generationPositionRef = useRef({ x: 0, y: 0 });
  const uploadInFlightRef = useRef(false);
  const uploadStatusTimerRef = useRef<number | null>(null);

  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [isDraggingFile, setIsDraggingFile] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<string | null>(null);
  const [showGenerationModal, setShowGenerationModal] = useState(false);
  const [showWatermarkModal, setShowWatermarkModal] = useState(false);
  const [watermarkSourceUrl, setWatermarkSourceUrl] = useState('');
  const [watermarkSourceType, setWatermarkSourceType] = useState<'image' | 'video'>('image');
  const [balanceCents, setBalanceCents] = useState(user?.balanceCents || 0);
  const [batchConnection, setBatchConnection] = useState<{ start: { x: number; y: number }; current: { x: number; y: number }; targetId: string | null } | null>(null);
  const [alignmentGuides, setAlignmentGuides] = useState<AlignmentGuide[]>([]);

  useEffect(() => {
    let active = true;
    const refreshBalance = () => {
      if (user?.role === 'system' || document.visibilityState === 'hidden') return;
      void apiRequest<{ balanceCents: number }>('/api/billing/balance').then((result) => { if (active) setBalanceCents(result.balanceCents); }).catch(() => undefined);
    };
    setBalanceCents(user?.balanceCents || 0);
    refreshBalance();
    const timer = window.setInterval(refreshBalance, 30_000);
    window.addEventListener('focus', refreshBalance);
    window.addEventListener('billing:changed', refreshBalance);
    return () => {
      active = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', refreshBalance);
      window.removeEventListener('billing:changed', refreshBalance);
    };
  }, [user?.id, user?.role]);

  useEffect(() => () => {
    if (uploadStatusTimerRef.current) window.clearTimeout(uploadStatusTimerRef.current);
  }, []);

  // 检查是否有弹窗打开
  const hasModalOpen = showGenerationModal || showWatermarkModal;

  const largeGraph = project.nodes.length > 120 || project.edges.length > 180;
  const renderedEdges = useMemo(() => project.edges.map((edge) => ({
    ...edge,
    type: 'default',
    animated: edge.animated ?? !largeGraph,
  })), [project.edges, largeGraph]);

  const hasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes('Files');

  const getFileType = (file: File): 'image' | 'video' | null => {
    if (file.type.startsWith('image/')) return 'image';
    if (file.type.startsWith('video/')) return 'video';
    return null;
  };

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
    if (!project || hasModalOpen || uploadInFlightRef.current) return;
    uploadInFlightRef.current = true;
    if (uploadStatusTimerRef.current) {
      window.clearTimeout(uploadStatusTimerRef.current);
      uploadStatusTimerRef.current = null;
    }
    const supportedFiles = Array.from(event.dataTransfer.files).filter((file) => getFileType(file));
    const files = supportedFiles.slice(0, MAX_FILES_PER_DROP);
    const dropPosition = screenToFlowPosition({ x: event.clientX, y: event.clientY });

    if (!files.length) {
      setIsDraggingFile(false);
      setUploadStatus('没有可上传的图片或视频文件');
      uploadInFlightRef.current = false;
      uploadStatusTimerRef.current = window.setTimeout(() => setUploadStatus(null), 4000);
      return;
    }

    let completedCount = 0;
    const results: Array<{ index: number; node?: Parameters<typeof addNodes>[0][number]; error?: unknown }> = [];
    setUploadStatus(`正在上传 0/${files.length}`);
    try {
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < files.length) {
          const fileIndex = nextIndex++;
          const file = files[fileIndex];
          const fileType = getFileType(file)!;
          try {
            const storedUrl = await uploadFileWithRetry(file);
            const fileName = file.name.replace(/\.[^/.]+$/, '');
            const column = fileIndex % 4;
            const row = Math.floor(fileIndex / 4);
            results.push({
              index: fileIndex,
              node: {
                id: `scene-${Date.now()}-${fileIndex}-${Math.random().toString(36).substring(2, 8)}`,
                type: 'sceneNode',
                position: { x: dropPosition.x - 100 + column * 240, y: dropPosition.y - 60 + row * 190 },
                data: {
                  label: fileName || `${fileType === 'image' ? '图片' : '视频'}场景`,
                  type: fileType,
                  content: file.name,
                  duration: fileType === 'video' ? 10 : 5,
                  prompt: '',
                  generatedContent: storedUrl,
                  mediaSource: 'uploaded',
                  settings: { style: project.settings.defaultStyle, mood: '', camera: '', lighting: '' },
                  status: 'completed',
                  progress: 100,
                },
              },
            });
          } catch (error) {
            console.error('素材上传失败:', file.name, error);
            results.push({ index: fileIndex, error });
          } finally {
            completedCount += 1;
            setUploadStatus(`正在上传 ${completedCount}/${files.length}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, files.length) }, worker));
      const uploadedNodes = results.sort((a, b) => a.index - b.index).flatMap((result) => result.node ? [result.node] : []);
      addNodes(uploadedNodes);
      const failedCount = files.length - uploadedNodes.length;
      const omittedCount = Math.max(0, supportedFiles.length - files.length);
      setUploadStatus(failedCount || omittedCount
        ? `已上传 ${uploadedNodes.length}/${files.length}，失败 ${failedCount}${omittedCount ? `，另有 ${omittedCount} 个超过单批限制` : ''}`
        : `已上传 ${uploadedNodes.length}/${files.length}`);
    } finally {
      uploadInFlightRef.current = false;
      setIsDraggingFile(false);
      uploadStatusTimerRef.current = window.setTimeout(() => setUploadStatus(null), 5000);
    }
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
  const onConnectStart: OnConnectStart = (_event, params) => {
    const sourceNodeId = params.nodeId;
    if (!sourceNodeId) return;
    const selectedNodeIds = project?.nodes.filter((node) => node.selected).map((node) => node.id) || [];
    connectionSourceNodeIdsRef.current = selectedNodeIds.length > 1 && selectedNodeIds.includes(sourceNodeId)
      ? [sourceNodeId, ...selectedNodeIds.filter((id) => id !== sourceNodeId)]
      : [sourceNodeId];
  };

  const onConnectEnd: OnConnectEnd = (event, connectionState) => {
    if (connectionState.isValid) {
      connectionSourceNodeIdsRef.current = [];
      return;
    }
    const sourceNodeId = connectionState.fromNode?.id;
    if (!sourceNodeId) return;

    const clientX = 'clientX' in event ? event.clientX : (event as TouchEvent).touches?.[0]?.clientX;
    const clientY = 'clientY' in event ? event.clientY : (event as TouchEvent).touches?.[0]?.clientY;
    if (clientX === undefined || clientY === undefined) return;

    const wrapper = reactFlowWrapper.current;
    if (!wrapper) return;

    const sourceIds = connectionSourceNodeIdsRef.current.includes(sourceNodeId)
      ? connectionSourceNodeIdsRef.current
      : [sourceNodeId];
    const nearbyTargetId = targetNodeAt(clientX, clientY, sourceIds);
    if (nearbyTargetId) {
      connectSourcesToTarget(sourceIds, nearbyTargetId);
      connectionSourceNodeIdsRef.current = [];
      return;
    }
    generationSourceNodeIdsRef.current = sourceIds;
    connectionSourceNodeIdsRef.current = [];
    generationPositionRef.current = screenToFlowPosition({ x: clientX, y: clientY });
    setShowGenerationModal(true);
  };

  const connectSourcesToTarget = (sourceIds: string[], targetId: string) => {
    [...new Set(sourceIds)].filter((sourceId) => sourceId !== targetId).forEach((sourceId) => {
      if (!project?.edges.some((edge) => edge.source === sourceId && edge.target === targetId)) {
        onConnect({ source: sourceId, target: targetId, sourceHandle: null, targetHandle: null });
      }
    });
  };

  const handleConnect = (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    const groupedSources = connectionSourceNodeIdsRef.current.includes(connection.source)
      ? connectionSourceNodeIdsRef.current
      : [connection.source];
    connectSourcesToTarget(groupedSources, connection.target);
  };

  const handleGenerationSelect = (type: 'video' | 'image' | 'img2img', settings: GenerationSettings) => {
    const sourceNode = generationSourceNodeIdsRef.current[0];
    if (!sourceNode || !project) return;
    startGenerationWithType(sourceNode, type, {
      ...settings,
      referenceNodeIds: generationSourceNodeIdsRef.current,
    }, generationPositionRef.current);
    setShowGenerationModal(false);
    generationSourceNodeIdsRef.current = [];
  };

  const onPaneClick = () => setSelectedNode(null);

  const alignmentNode = (node: SceneNode): AlignmentNode => ({
    id: node.id,
    position: node.position,
    width: node.measured?.width || node.width || DEFAULT_NODE_WIDTH,
    height: node.measured?.height || node.height || DEFAULT_NODE_HEIGHT,
  });

  const handleNodeDrag: OnNodeDrag = (_event, node, draggedNodes) => {
    if (node.data.type !== 'image' || draggedNodes.length !== 1) {
      setAlignmentGuides([]);
      return;
    }
    const otherImages = project.nodes.filter((candidate) => candidate.id !== node.id && candidate.data.type === 'image');
    if (!otherImages.length) {
      setAlignmentGuides([]);
      return;
    }
    const aligned = alignNode(alignmentNode(node as SceneNode), otherImages.map(alignmentNode), ALIGNMENT_TOLERANCE_PX / getZoom());
    setAlignmentGuides(aligned.guides);
    if (aligned.position.x !== node.position.x || aligned.position.y !== node.position.y) {
      onNodesChange([{ id: node.id, type: 'position', position: aligned.position, dragging: true }]);
    }
  };

  const handleNodeDragStop: OnNodeDrag = () => {
    setAlignmentGuides([]);
    pushToHistory();
  };

  if (!project) return null;

  const generationSourceNodes = generationSourceNodeIdsRef.current
    .map((id) => project.nodes.find((node) => node.id === id))
    .filter((node): node is NonNullable<typeof node> => Boolean(node));
  const sourceNode = generationSourceNodes[0];
  const sourceImageNode = generationSourceNodes.find((node) => node.data.type === 'image' && node.data.generatedContent);
  const generationMentionableNodes = generationSourceNodes.map((node) => ({
    id: node.id, label: node.data.label, type: node.data.type,
    imageUrl: node.data.type === 'image' ? node.data.generatedContent : undefined,
  }));
  const configuredVideoModel = project.settings.multiModel?.videoModel || project.settings.aiModel;
  const selectedNodes = project.nodes.filter((node) => node.selected);
  const targetNodeAt = (clientX: number, clientY: number, sourceIds: string[]) => {
    const candidates = Array.from(reactFlowWrapper.current?.querySelectorAll<HTMLElement>('.react-flow__node') || [])
      .filter((element) => element.dataset.id && !sourceIds.includes(element.dataset.id));
    let nearest: { id: string; distance: number } | null = null;
    for (const element of candidates) {
      const rect = element.getBoundingClientRect();
      const dx = Math.max(rect.left - clientX, 0, clientX - rect.right);
      const dy = Math.max(rect.top - clientY, 0, clientY - rect.bottom);
      const distance = Math.hypot(dx, dy);
      if (distance <= NODE_CONNECTION_TOLERANCE_PX && (!nearest || distance < nearest.distance)) {
        nearest = { id: element.dataset.id!, distance };
      }
    }
    return nearest?.id || null;
  };

  const startBatchConnection = (event: React.PointerEvent<HTMLButtonElement>) => {
    const sourceIds = selectedNodes.map((node) => node.id);
    if (sourceIds.length < 2) return;
    event.preventDefault();
    event.stopPropagation();
    batchConnectionSourceIdsRef.current = sourceIds;
    const start = { x: event.clientX, y: event.clientY };
    setBatchConnection({ start, current: start, targetId: null });
    const move = (event: PointerEvent) => {
      const sourceIds = batchConnectionSourceIdsRef.current;
      const current = { x: event.clientX, y: event.clientY };
      setBatchConnection((active) => active ? { ...active, current, targetId: targetNodeAt(current.x, current.y, sourceIds) } : null);
    };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    const finish = (event: PointerEvent) => {
      const sourceIds = batchConnectionSourceIdsRef.current;
      const targetId = targetNodeAt(event.clientX, event.clientY, sourceIds);
      if (targetId) connectSourcesToTarget(sourceIds, targetId);
      batchConnectionSourceIdsRef.current = [];
      setBatchConnection(null);
      cleanup();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  };

  const batchLine = batchConnection && reactFlowWrapper.current ? (() => {
    const rect = reactFlowWrapper.current!.getBoundingClientRect();
    const start = { x: batchConnection.start.x - rect.left, y: batchConnection.start.y - rect.top };
    const current = { x: batchConnection.current.x - rect.left, y: batchConnection.current.y - rect.top };
    const bend = Math.max(60, Math.abs(current.x - start.x) * 0.45);
    return { current, path: `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${current.x - bend} ${current.y}, ${current.x} ${current.y}` };
  })() : null;
  const createBatchNode = () => {
    if (selectedNodes.length < 2) return;
    const right = Math.max(...selectedNodes.map((node) => node.position.x + 240));
    const top = selectedNodes.reduce((sum, node) => sum + node.position.y, 0) / selectedNodes.length;
    const id = `scene-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    addNode({ id, type: 'sceneNode', position: { x: right + 120, y: top }, data: {
      label: `批量视频 ${project.nodes.length + 1}`, type: 'video', content: '', duration: 5,
      prompt: selectedNodes.map((node) => `@[${node.data.label}](${node.id})`).join(' '),
      referenceNodeIds: selectedNodes.map((node) => node.id),
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
      <div className="absolute bottom-16 right-52 z-50 flex items-center gap-2 rounded-lg border border-green-500/30 bg-dark-800/95 px-3 py-2 text-xs text-dark-200 shadow-xl backdrop-blur" title="余额每 10 秒及生成结束后自动刷新">
        <Wallet className="h-4 w-4 text-green-400" />
        <span>{user?.role === 'system' ? '系统账户' : `余额 ¥${(balanceCents / 100).toFixed(2)}`}</span>
      </div>
      <div className="absolute top-36 right-4 z-50 flex flex-col gap-2">
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

      {uploadStatus && <div className="absolute left-1/2 top-20 z-[70] -translate-x-1/2 rounded-md border border-cyan-500/40 bg-dark-900/95 px-4 py-2 text-sm text-cyan-200 shadow-xl">{uploadStatus}</div>}

      <ReactFlow
        nodes={project.nodes}
        edges={renderedEdges}
        onNodesChange={onNodesChange}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onEdgesChange={onEdgesChange}
        onConnect={handleConnect}
        onConnectStart={onConnectStart}
        onConnectEnd={onConnectEnd}
        onPaneClick={onPaneClick}
        onDragOver={onDragOver}
        onDrop={onDrop}
        nodeTypes={nodeTypes}
        fitView
        onlyRenderVisibleElements
        snapToGrid
        snapGrid={[16, 16]}
        selectionOnDrag={isSelectionMode}
        panOnDrag={!isSelectionMode}
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode="Shift"
        selectionKeyCode={null}
        connectionLineType={ConnectionLineType.Bezier}
        defaultEdgeOptions={{ type: 'default', animated: !largeGraph, style: { stroke: '#8b5cf6', strokeWidth: 2 } }}
        minZoom={0.1}
        maxZoom={3}
        fitViewOptions={{ padding: 0.2, minZoom: 0.1, maxZoom: 1.2 }}
        className="bg-dark-950"
      >
        <Background variant={BackgroundVariant.Dots} gap={24} size={1.5} color="#334155" />
        <ViewportPortal>
          {alignmentGuides.map((guide) => guide.axis === 'x' ? (
            <div
              key={`x-${guide.coordinate}`}
              data-testid="alignment-guide-x"
              className="pointer-events-none absolute z-[100] border-l border-dashed border-cyan-300"
              style={{ left: guide.coordinate, top: guide.start, height: Math.max(1, guide.end - guide.start) }}
            />
          ) : (
            <div
              key={`y-${guide.coordinate}`}
              data-testid="alignment-guide-y"
              className="pointer-events-none absolute z-[100] border-t border-dashed border-cyan-300"
              style={{ left: guide.start, top: guide.coordinate, width: Math.max(1, guide.end - guide.start) }}
            />
          ))}
        </ViewportPortal>
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
          <button
            type="button"
            onPointerDown={startBatchConnection}
            title="拖动连线到现有组件，将所有选中组件一起连接"
            className="flex cursor-crosshair items-center gap-1 rounded-lg border border-cyan-500/50 bg-cyan-500/10 px-3 py-1.5 text-xs text-cyan-200 hover:bg-cyan-500/20"
            data-testid="batch-connect-handle"
          >
            <GitMerge className="h-4 w-4" /> 拖线到现有组件
          </button>
        </div>
      )}

      {batchLine && (
        <svg className="pointer-events-none absolute inset-0 z-[80] h-full w-full overflow-visible" aria-hidden="true" data-testid="batch-connection-line">
          <path d={batchLine.path} fill="none" stroke={batchConnection?.targetId ? '#22d3ee' : '#8b5cf6'} strokeWidth="3" strokeDasharray="8 5" />
          <circle cx={batchLine.current.x} cy={batchLine.current.y} r="7" fill={batchConnection?.targetId ? '#22d3ee' : '#8b5cf6'} stroke="#0f172a" strokeWidth="3" />
        </svg>
      )}

      {/* 生成弹窗 */}
      <GenerationModal
        isOpen={showGenerationModal}
        onClose={() => {
          setShowGenerationModal(false);
          generationSourceNodeIdsRef.current = [];
        }}
        onSelect={handleGenerationSelect}
        sourceImageUrl={sourceImageNode?.data?.generatedContent}
        sourceNodeType={sourceNode?.data?.type}
        initialReferences={generationSourceNodes.map((node) => ({ id: node.id, label: node.data.label, type: node.data.type, imageUrl: node.data.type === 'image' ? node.data.generatedContent : undefined }))}
        mentionableNodes={generationMentionableNodes}
        durationRules={{ managed: configuredVideoModel.managed, minDurationSec: configuredVideoModel.minDurationSec, maxDurationSec: configuredVideoModel.maxDurationSec, allowedDurationsSec: configuredVideoModel.allowedDurationsSec }}
        maxReferenceImages={Number.isInteger(configuredVideoModel.maxReferenceImages) ? configuredVideoModel.maxReferenceImages : 4}
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
