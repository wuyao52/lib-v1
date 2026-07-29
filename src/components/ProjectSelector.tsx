import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Plus,
  Film,
  Trash2,
  ExternalLink,
  Clock,
  Layers,
  FolderOpen,
  LogOut,
} from 'lucide-react';
import useProjectStore from '@/store/useProjectStore';
import { useAuth } from '@/auth/AuthContext';

export default function ProjectSelector() {
  const { projects, createProject, openProject, deleteProject, refreshProjects } = useProjectStore();
  const { user, logout } = useAuth();
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDescription, setNewDescription] = useState('');

  useEffect(() => {
    refreshProjects();
  }, [refreshProjects]);

  const handleCreate = () => {
    if (newTitle.trim()) {
      createProject(newTitle.trim(), newDescription.trim());
      setNewTitle('');
      setNewDescription('');
      setShowCreateDialog(false);
    }
  };

  const handleDelete = (e: React.MouseEvent, projectId: string) => {
    e.stopPropagation();
    if (confirm('确定要删除这个项目吗？此操作不可撤销。')) {
      deleteProject(projectId);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  return (
    <div className="w-screen h-screen bg-dark-950 flex flex-col overflow-hidden">
      {/* 背景装饰 */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary-600/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-purple-600/10 rounded-full blur-3xl" />
      </div>

      {/* 头部 */}
      <motion.header
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        className="relative z-10 h-16 flex items-center justify-between px-8
          bg-dark-900/80 backdrop-blur-xl border-b border-dark-700/50"
      >
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary-500 to-primary-700
            flex items-center justify-center shadow-lg shadow-primary-500/20">
            <Film className="w-6 h-6 text-white" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">AI Drama Studio</h1>
            <p className="text-xs text-dark-400">AI 短剧生成工作台</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="text-right hidden sm:block"><p className="text-sm text-dark-200">{user?.name}</p><p className="text-[10px] text-dark-500">{user?.email}</p></div>
          <button onClick={() => logout()} className="p-2 rounded-lg text-dark-400 hover:text-white hover:bg-dark-700" title="退出登录"><LogOut className="w-4 h-4" /></button>
        </div>
      </motion.header>

      {/* 主内容 */}
      <div className="flex-1 relative z-10 overflow-y-auto p-8">
        <div className="max-w-6xl mx-auto">
          {/* 标题区域 */}
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            className="text-center mb-12"
          >
            <h2 className="text-4xl font-bold text-white mb-4">
              欢迎使用 <span className="text-primary-400">AI Drama Studio</span>
            </h2>
            <p className="text-lg text-dark-300">
              选择一个项目开始创作，或创建一个新项目
            </p>
          </motion.div>

          {/* 新建项目按钮 */}
          <motion.div
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            transition={{ delay: 0.1 }}
            className="mb-8"
          >
            <button
              onClick={() => setShowCreateDialog(true)}
              className="w-full max-w-md mx-auto flex items-center justify-center gap-3 p-6
                bg-gradient-to-r from-primary-600 to-primary-500 hover:from-primary-500 hover:to-primary-400
                rounded-2xl text-white font-medium text-lg
                shadow-lg shadow-primary-500/20 hover:shadow-xl hover:shadow-primary-500/30
                transition-all active:scale-[0.98]"
            >
              <Plus className="w-6 h-6" />
              创建新项目
            </button>
          </motion.div>

          {/* 项目列表 */}
          {projects.length > 0 && (
            <motion.div
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.2 }}
            >
              <h3 className="text-xl font-semibold text-white mb-6 flex items-center gap-2">
                <FolderOpen className="w-5 h-5 text-primary-400" />
                我的项目
              </h3>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {projects.map((project, index) => (
                  <motion.div
                    key={project.id}
                    initial={{ y: 20, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    transition={{ delay: 0.1 * index }}
                    onClick={() => openProject(project.id)}
                    className="group cursor-pointer"
                  >
                    <div className="bg-dark-800/80 backdrop-blur-xl rounded-2xl border border-dark-600/50
                      hover:border-primary-500/50 hover:shadow-lg hover:shadow-primary-500/10
                      transition-all overflow-hidden">
                      {/* 项目预览图 */}
                      <div className="h-40 bg-gradient-to-br from-dark-700 to-dark-800 relative overflow-hidden">
                        <div className="absolute inset-0 flex items-center justify-center">
                          <Film className="w-16 h-16 text-dark-600" />
                        </div>
                        <div className="absolute inset-0 bg-gradient-to-t from-dark-800 to-transparent" />

                        {/* 悬停效果 */}
                        <div className="absolute inset-0 bg-primary-600/0 group-hover:bg-primary-600/10 transition-colors" />
                        <div className="absolute inset-0 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                          <div className="px-4 py-2 bg-primary-600 rounded-lg text-white text-sm font-medium flex items-center gap-2">
                            <ExternalLink className="w-4 h-4" />
                            打开项目
                          </div>
                        </div>
                      </div>

                      {/* 项目信息 */}
                      <div className="p-4">
                        <h4 className="text-lg font-semibold text-white mb-1 truncate">
                          {project.title}
                        </h4>
                        {project.description && (
                          <p className="text-sm text-dark-400 mb-3 line-clamp-2">
                            {project.description}
                          </p>
                        )}

                        <div className="flex items-center justify-between text-xs text-dark-400">
                          <div className="flex items-center gap-4">
                            <span className="flex items-center gap-1">
                              <Layers className="w-3 h-3" />
                              {project.sceneCount} 个场景
                            </span>
                            <span className="flex items-center gap-1">
                              <Clock className="w-3 h-3" />
                              {formatDate(project.updatedAt)}
                            </span>
                          </div>

                          <button
                            onClick={(e) => handleDelete(e, project.id)}
                            className="p-1 hover:bg-red-500/20 rounded transition-colors opacity-0 group-hover:opacity-100"
                          >
                            <Trash2 className="w-4 h-4 text-red-400" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            </motion.div>
          )}

          {/* 空状态 */}
          {projects.length === 0 && (
            <motion.div
              initial={{ y: 20, opacity: 0 }}
              animate={{ y: 0, opacity: 1 }}
              transition={{ delay: 0.3 }}
              className="text-center py-16"
            >
              <div className="w-24 h-24 mx-auto mb-6 rounded-2xl bg-dark-800/50 flex items-center justify-center">
                <Film className="w-12 h-12 text-dark-600" />
              </div>
              <h3 className="text-xl font-medium text-dark-300 mb-2">
                还没有项目
              </h3>
              <p className="text-dark-400">
                点击上方按钮创建你的第一个 AI 短剧项目
              </p>
            </motion.div>
          )}
        </div>
      </div>

      {/* 创建项目对话框 */}
      <AnimatePresence>
        {showCreateDialog && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
          >
            {/* 背景遮罩 */}
            <div
              className="absolute inset-0 bg-black/60 backdrop-blur-sm"
              onClick={() => setShowCreateDialog(false)}
            />

            {/* 对话框 */}
            <motion.div
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="relative w-full max-w-md bg-dark-800 rounded-2xl border border-dark-600/50
                shadow-2xl overflow-hidden"
            >
              {/* 头部 */}
              <div className="p-6 border-b border-dark-600/50">
                <h3 className="text-xl font-semibold text-white flex items-center gap-2">
                  <Plus className="w-5 h-5 text-primary-400" />
                  创建新项目
                </h3>
              </div>

              {/* 内容 */}
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-2">
                    项目名称 *
                  </label>
                  <input
                    type="text"
                    value={newTitle}
                    onChange={(e) => setNewTitle(e.target.value)}
                    placeholder="输入项目名称"
                    className="w-full px-4 py-3 bg-dark-700 border border-dark-600 rounded-xl
                      text-white placeholder:text-dark-500
                      focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                    autoFocus
                    onKeyDown={(e) => e.key === 'Enter' && handleCreate()}
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-dark-300 mb-2">
                    项目描述
                  </label>
                  <textarea
                    value={newDescription}
                    onChange={(e) => setNewDescription(e.target.value)}
                    placeholder="输入项目描述（可选）"
                    rows={3}
                    className="w-full px-4 py-3 bg-dark-700 border border-dark-600 rounded-xl
                      text-white placeholder:text-dark-500 resize-none
                      focus:outline-none focus:border-primary-500 focus:ring-1 focus:ring-primary-500"
                  />
                </div>
              </div>

              {/* 底部按钮 */}
              <div className="p-6 border-t border-dark-600/50 flex justify-end gap-3">
                <button
                  onClick={() => setShowCreateDialog(false)}
                  className="px-6 py-2.5 rounded-xl text-dark-300 hover:text-white
                    hover:bg-dark-700 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleCreate}
                  disabled={!newTitle.trim()}
                  className={`
                    px-6 py-2.5 rounded-xl font-medium transition-all
                    ${newTitle.trim()
                      ? 'bg-primary-600 hover:bg-primary-500 text-white shadow-lg shadow-primary-500/20'
                      : 'bg-dark-700 text-dark-500 cursor-not-allowed'
                    }
                  `}
                >
                  创建
                </button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
