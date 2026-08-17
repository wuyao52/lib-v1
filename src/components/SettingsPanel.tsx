import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Monitor, Film, Palette } from 'lucide-react';
import useProjectStore from '@/store/useProjectStore';

export default function SettingsPanel() {
  const { showSettings, toggleSettings, project, updateProjectSettings } = useProjectStore();

  if (!project) return null;

  return (
    <AnimatePresence>
      {showSettings && (
        <motion.div
          initial={{ x: 300, opacity: 0 }}
          animate={{ x: 0, opacity: 1 }}
          exit={{ x: 300, opacity: 0 }}
          className="absolute right-0 top-0 bottom-0 w-80 z-50"
        >
          <div className="h-full bg-dark-800/95 backdrop-blur-xl border-l border-dark-600/50">
            {/* Header */}
            <div className="flex items-center justify-between p-4 border-b border-dark-600/50">
              <h2 className="text-lg font-semibold text-white flex items-center gap-2">
                <Monitor className="w-5 h-5 text-primary-400" />
                项目设置
              </h2>
              <button
                onClick={toggleSettings}
                className="p-2 hover:bg-dark-700 rounded-lg transition-colors"
              >
                <X className="w-4 h-4 text-dark-400" />
              </button>
            </div>

            {/* Content */}
            <div className="p-4 space-y-6 overflow-y-auto h-[calc(100%-60px)]">
              {/* 分辨率设置 */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-dark-200 flex items-center gap-2">
                  <Monitor className="w-4 h-4 text-primary-400" />
                  分辨率
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-dark-400">宽度</label>
                    <input
                      type="number"
                      value={project.settings.resolution.width}
                      onChange={(e) =>
                        updateProjectSettings({
                          resolution: {
                            ...project.settings.resolution,
                            width: Number(e.target.value),
                          },
                        })
                      }
                      className="w-full mt-1 px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg
                        text-white text-sm focus:outline-none focus:border-primary-500"
                    />
                  </div>
                  <div>
                    <label className="text-xs text-dark-400">高度</label>
                    <input
                      type="number"
                      value={project.settings.resolution.height}
                      onChange={(e) =>
                        updateProjectSettings({
                          resolution: {
                            ...project.settings.resolution,
                            height: Number(e.target.value),
                          },
                        })
                      }
                      className="w-full mt-1 px-3 py-2 bg-dark-700 border border-dark-600 rounded-lg
                        text-white text-sm focus:outline-none focus:border-primary-500"
                    />
                  </div>
                </div>
              </div>

              {/* 帧率设置 */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-dark-200 flex items-center gap-2">
                  <Film className="w-4 h-4 text-primary-400" />
                  帧率
                </h3>
                <div className="flex gap-2">
                  {[24, 25, 30, 60].map((fps) => (
                    <button
                      key={fps}
                      onClick={() => updateProjectSettings({ fps })}
                      className={`
                        flex-1 py-2 rounded-lg text-sm font-medium transition-colors
                        ${project.settings.fps === fps
                          ? 'bg-primary-600 text-white'
                          : 'bg-dark-700 text-dark-300 hover:bg-dark-600'
                        }
                      `}
                    >
                      {fps}fps
                    </button>
                  ))}
                </div>
              </div>

              {/* 画面比例 */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-dark-200">画面比例</h3>
                <div className="flex gap-2">
                  {['16:9', '9:16', '1:1', '4:3'].map((ratio) => (
                    <button
                      key={ratio}
                      onClick={() => updateProjectSettings({ aspectRatio: ratio })}
                      aria-pressed={project.settings.aspectRatio === ratio}
                      className={`
                        flex-1 py-2 rounded-lg text-sm font-medium transition-colors
                        ${project.settings.aspectRatio === ratio
                          ? 'bg-primary-600 text-white'
                          : 'bg-dark-700 text-dark-300 hover:bg-dark-600'
                        }
                      `}
                    >
                      {ratio}
                    </button>
                  ))}
                </div>
              </div>

              {/* 默认风格 */}
              <div className="space-y-3">
                <h3 className="text-sm font-medium text-dark-200 flex items-center gap-2">
                  <Palette className="w-4 h-4 text-primary-400" />
                  默认风格
                </h3>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { id: 'cinematic', label: '电影感' },
                    { id: 'anime', label: '动漫风' },
                    { id: 'realistic', label: '写实风' },
                    { id: 'artistic', label: '艺术风' },
                    { id: 'vintage', label: '复古风' },
                    { id: 'modern', label: '现代风' },
                  ].map((style) => (
                    <button
                      key={style.id}
                      onClick={() => updateProjectSettings({ defaultStyle: style.id })}
                      className={`
                        py-2 rounded-lg text-xs font-medium transition-colors
                        ${project.settings.defaultStyle === style.id
                          ? 'bg-primary-600 text-white'
                          : 'bg-dark-700 text-dark-300 hover:bg-dark-600'
                        }
                      `}
                    >
                      {style.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
