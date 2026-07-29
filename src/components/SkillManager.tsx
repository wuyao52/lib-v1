import { ChangeEvent, useEffect, useState } from 'react';
import { FileUp, Loader2, Plus, Save, Trash2, X } from 'lucide-react';
import { apiRequest } from '@/services/apiClient';
import type { UserSkill } from '@/types/skill';

interface SkillManagerProps {
  isOpen: boolean;
  onClose: () => void;
}

const emptyDraft = { id: '', name: '', description: '', tags: '', instructions: '' };

export default function SkillManager({ isOpen, onClose }: SkillManagerProps) {
  const [skills, setSkills] = useState<UserSkill[]>([]);
  const [draft, setDraft] = useState(emptyDraft);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');

  const loadSkills = async () => {
    setIsLoading(true);
    try {
      const result = await apiRequest<{ skills: UserSkill[] }>('/api/skills');
      setSkills(result.skills);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : 'Skill 加载失败');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) loadSkills();
  }, [isOpen]);

  if (!isOpen) return null;

  const selectSkill = (skill: UserSkill) => setDraft({ ...skill, tags: skill.tags.join(', ') });
  const saveSkill = async () => {
    setError('');
    setIsSaving(true);
    try {
      const payload = { name: draft.name, description: draft.description, instructions: draft.instructions, tags: draft.tags.split(',').map((tag) => tag.trim()).filter(Boolean) };
      const result = draft.id
        ? await apiRequest<{ skill: UserSkill }>(`/api/skills/${draft.id}`, { method: 'PUT', body: JSON.stringify(payload) })
        : await apiRequest<{ skill: UserSkill }>('/api/skills', { method: 'POST', body: JSON.stringify(payload) });
      await loadSkills();
      selectSkill(result.skill);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : 'Skill 保存失败');
    } finally {
      setIsSaving(false);
    }
  };

  const importMarkdown = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setError('');
    try {
      const markdown = await file.text();
      const result = await apiRequest<{ skill: UserSkill }>('/api/skills', { method: 'POST', body: JSON.stringify({ markdown }) });
      await loadSkills();
      selectSkill(result.skill);
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : 'Skill 导入失败');
    } finally {
      event.target.value = '';
    }
  };

  const deleteSkill = async () => {
    if (!draft.id || !confirm(`删除 Skill“${draft.name}”？`)) return;
    try {
      await apiRequest<void>(`/api/skills/${draft.id}`, { method: 'DELETE' });
      setDraft(emptyDraft);
      await loadSkills();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : 'Skill 删除失败');
    }
  };

  return (
    <div className="fixed inset-0 z-[330] bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="w-full max-w-5xl h-[82vh] bg-dark-900 border border-dark-600 rounded-lg shadow-2xl overflow-hidden flex flex-col">
        <header className="h-16 px-5 border-b border-dark-700 flex items-center justify-between"><div><h2 className="font-semibold">Skill 工作区</h2><p className="text-xs text-dark-400">{skills.length} 个账户 Skill</p></div><button onClick={onClose} className="p-2 rounded-lg hover:bg-dark-700" title="关闭"><X className="w-5 h-5" /></button></header>
        <div className="flex-1 min-h-0 grid md:grid-cols-[280px_1fr]">
          <aside className="border-r border-dark-700 p-4 overflow-y-auto">
            <div className="grid grid-cols-2 gap-2 mb-4">
              <button onClick={() => setDraft(emptyDraft)} className="h-9 rounded-lg bg-primary-600 hover:bg-primary-500 text-sm flex items-center justify-center gap-1"><Plus className="w-4 h-4" />新建</button>
              <label className="h-9 rounded-lg bg-dark-700 hover:bg-dark-600 text-sm flex items-center justify-center gap-1 cursor-pointer"><FileUp className="w-4 h-4" />导入<input type="file" accept=".md,text/markdown,text/plain" onChange={importMarkdown} className="hidden" /></label>
            </div>
            {isLoading ? <Loader2 className="w-5 h-5 animate-spin text-dark-400 mx-auto mt-8" /> : <div className="space-y-2">{skills.map((skill) => <button key={skill.id} onClick={() => selectSkill(skill)} className={`w-full text-left p-3 rounded-lg border ${draft.id === skill.id ? 'border-primary-500 bg-primary-500/10' : 'border-dark-700 bg-dark-800 hover:border-dark-500'}`}><p className="text-sm font-medium truncate">{skill.name}</p><p className="text-xs text-dark-500 truncate mt-1">{skill.description || skill.tags.join(' · ')}</p></button>)}</div>}
          </aside>
          <section className="p-5 overflow-y-auto space-y-4">
            <div className="grid sm:grid-cols-2 gap-4"><label><span className="text-xs text-dark-300">名称</span><input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className="mt-2 w-full h-10 px-3 bg-dark-950 border border-dark-700 rounded-lg outline-none focus:border-primary-500" /></label><label><span className="text-xs text-dark-300">标签（逗号分隔）</span><input value={draft.tags} onChange={(e) => setDraft({ ...draft, tags: e.target.value })} className="mt-2 w-full h-10 px-3 bg-dark-950 border border-dark-700 rounded-lg outline-none focus:border-primary-500" /></label></div>
            <label className="block"><span className="text-xs text-dark-300">描述</span><input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} className="mt-2 w-full h-10 px-3 bg-dark-950 border border-dark-700 rounded-lg outline-none focus:border-primary-500" /></label>
            <label className="block"><span className="text-xs text-dark-300">创作指令</span><textarea value={draft.instructions} onChange={(e) => setDraft({ ...draft, instructions: e.target.value })} rows={18} className="mt-2 w-full p-3 bg-dark-950 border border-dark-700 rounded-lg outline-none focus:border-primary-500 resize-none font-mono text-sm leading-relaxed" /></label>
            {error && <p className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-lg p-3">{error}</p>}
            <div className="flex justify-between"><button onClick={deleteSkill} disabled={!draft.id} className="h-10 px-3 rounded-lg text-red-300 hover:bg-red-500/10 disabled:opacity-30 flex items-center gap-2"><Trash2 className="w-4 h-4" />删除</button><button onClick={saveSkill} disabled={isSaving || draft.name.trim().length < 2 || draft.instructions.trim().length < 10} className="h-10 px-4 bg-primary-600 hover:bg-primary-500 disabled:opacity-40 rounded-lg flex items-center gap-2">{isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}保存 Skill</button></div>
          </section>
        </div>
      </div>
    </div>
  );
}
