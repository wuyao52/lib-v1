// 生成唯一 ID
export const generateId = () => `id-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;

// 格式化日期
export const formatDate = (dateString: string) => {
  const date = new Date(dateString);
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

// 格式化时间
export const formatTime = (time: string | null) => {
  if (!time) return '';
  return new Date(time).toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

// 读取文件为 Data URL
export const readFileAsDataURL = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

// 获取文件类型
export const getFileType = (file: File): 'image' | 'video' | null => {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return null;
};

// 检测是否包含文件
export const hasFiles = (event: React.DragEvent) =>
  event.dataTransfer.types.includes('Files');

// 为节点生成简短名称
export const getShortName = (nodeType: string, index: number): string => {
  const typeNames: Record<string, string> = {
    text: '文本',
    image: '图片',
    video: '视频',
    audio: '音频',
    transition: '转场',
  };
  return `${typeNames[nodeType] || '场景'}${index + 1}`;
};

// 风格中文名称映射
export const styleLabels: Record<string, string> = {
  cinematic: '电影感',
  anime: '动漫风',
  realistic: '写实风',
  artistic: '艺术风',
  vintage: '复古风',
  modern: '现代风',
  watercolor: '水彩风',
  'oil-painting': '油画风',
};

// 节点类型中文名称
export const typeLabels: Record<string, string> = {
  text: '文本',
  image: '图片',
  video: '视频',
  audio: '音频',
  transition: '转场',
};

// 节点类型颜色
export const typeColors: Record<string, string> = {
  text: 'from-blue-500 to-cyan-500',
  image: 'from-purple-500 to-pink-500',
  video: 'from-orange-500 to-red-500',
  audio: 'from-green-500 to-emerald-500',
  transition: 'from-yellow-500 to-amber-500',
};

// 防抖函数
export const debounce = <T extends (...args: any[]) => any>(
  func: T,
  wait: number
): ((...args: Parameters<T>) => void) => {
  let timeout: ReturnType<typeof setTimeout>;
  return (...args: Parameters<T>) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => func(...args), wait);
  };
};
