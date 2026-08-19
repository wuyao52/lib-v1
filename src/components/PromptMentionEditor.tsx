import { useEffect, useMemo, useRef, useState } from 'react';
import { AtSign, Image as ImageIcon } from 'lucide-react';
import { getSignedAssetUrl, needsResolvedMediaUrl } from '@/services/assetService';

export interface PromptMentionNode {
  id: string;
  label: string;
  type: string;
  imageUrl?: string;
}

const MENTION_PATTERN = /@\[([^\]]+)\]\(([^)]+)\)/g;

function applyMentionImage(token: HTMLSpanElement, source: string) {
  const showImage = (imageSource: string) => {
    const image = document.createElement('img');
    image.src = imageSource;
    image.alt = '';
    image.className = 'h-full w-full object-cover';
    image.onerror = () => {
      image.remove();
      if (token.isConnected) token.innerHTML = '<span aria-hidden="true" class="text-primary-300">@</span>';
    };
    token.replaceChildren(image);
  };

  if (!needsResolvedMediaUrl(source)) {
    showImage(source);
    return;
  }

  void getSignedAssetUrl(source)
    .then((imageSource) => {
      if (token.isConnected) showImage(imageSource);
    })
    .catch(() => {
      if (token.isConnected) token.innerHTML = '<span aria-hidden="true" class="text-primary-300">@</span>';
    });
}

function MentionThumbnail({ source, alt = '' }: { source: string; alt?: string }) {
  const [resolvedSource, setResolvedSource] = useState(() => (
    needsResolvedMediaUrl(source) ? '' : source
  ));
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setResolvedSource(needsResolvedMediaUrl(source) ? '' : source);
    if (needsResolvedMediaUrl(source)) {
      void getSignedAssetUrl(source, controller.signal, retry > 0)
        .then((url) => {
          if (!controller.signal.aborted) setResolvedSource(url);
        })
        .catch(() => {
          if (!controller.signal.aborted) setResolvedSource('');
        });
    }
    return () => controller.abort();
  }, [source, retry]);

  if (!resolvedSource) return <ImageIcon className="h-4 w-4 text-dark-400" aria-label="图片缩略图加载中" />;
  return <img src={resolvedSource} alt={alt} className="h-full w-full object-cover" onError={() => {
    if (retry === 0 && needsResolvedMediaUrl(source)) setRetry(1);
    else setResolvedSource('');
  }} />;
}

function createMentionToken(node: PromptMentionNode) {
  const token = document.createElement('span');
  token.contentEditable = 'false';
  token.dataset.mentionId = node.id;
  token.dataset.mentionLabel = node.label;
  token.setAttribute('aria-label', node.type === 'image' ? '图片引用' : '组件引用');
  token.className = 'mx-0.5 inline-flex h-7 w-9 select-none items-center justify-center overflow-hidden rounded border border-primary-500/50 bg-primary-500/15 align-middle';
  if (node.type === 'image' && node.imageUrl) {
    token.innerHTML = '<span aria-hidden="true" class="text-primary-300">@</span>';
    applyMentionImage(token, node.imageUrl);
  } else {
    token.innerHTML = '<span aria-hidden="true" class="text-primary-300">@</span>';
  }
  return token;
}

function serializeEditor(root: HTMLElement): string {
  const serializeNode = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent || '';
    if (!(node instanceof HTMLElement)) return '';
    if (node.dataset.mentionId) {
      return `@[${node.dataset.mentionLabel || ''}](${node.dataset.mentionId})`;
    }
    if (node.tagName === 'BR') return '\n';
    const content = [...node.childNodes].map(serializeNode).join('');
    return node !== root && node.tagName === 'DIV' ? `${content}\n` : content;
  };
  return [...root.childNodes].map(serializeNode).join('').replace(/\n$/, '');
}

function renderEditorValue(root: HTMLElement, value: string, nodes: PromptMentionNode[]) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  root.replaceChildren();
  let lastIndex = 0;
  for (const match of value.matchAll(MENTION_PATTERN)) {
    if (match.index! > lastIndex) root.appendChild(document.createTextNode(value.slice(lastIndex, match.index)));
    const referenced = nodeById.get(match[2]) || { id: match[2], label: match[1], type: 'unknown' };
    root.appendChild(createMentionToken(referenced));
    lastIndex = match.index! + match[0].length;
  }
  if (lastIndex < value.length) root.appendChild(document.createTextNode(value.slice(lastIndex)));
}

export function PromptMentionContent({ value, nodes, className = '' }: { value: string; nodes: PromptMentionNode[]; className?: string }) {
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  for (const match of value.matchAll(MENTION_PATTERN)) {
    if (match.index! > lastIndex) parts.push(value.slice(lastIndex, match.index));
    const node = nodeById.get(match[2]);
    parts.push(
      <span key={`${match.index}-${match[2]}`} aria-label={node?.type === 'image' ? '图片引用' : '组件引用'} className="mx-0.5 inline-flex h-7 w-9 items-center justify-center overflow-hidden rounded border border-primary-500/50 bg-primary-500/15 align-middle">
        {node?.type === 'image' && node.imageUrl
          ? <MentionThumbnail source={node.imageUrl} />
          : <AtSign className="h-3.5 w-3.5 text-primary-300" />}
      </span>,
    );
    lastIndex = match.index! + match[0].length;
  }
  if (lastIndex < value.length) parts.push(value.slice(lastIndex));
  return <span className={`whitespace-pre-wrap ${className}`}>{parts}</span>;
}

interface PromptMentionEditorProps {
  value: string;
  onChange: (value: string) => void;
  nodes: PromptMentionNode[];
  placeholder?: string;
  minHeightClass?: string;
}

export default function PromptMentionEditor({ value, onChange, nodes, placeholder = '输入提示词，输入 @ 引用图片', minHeightClass = 'min-h-24' }: PromptMentionEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null);
  const rangeRef = useRef<Range | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [activeMentionIndex, setActiveMentionIndex] = useState(0);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || (document.activeElement === editor && serializeEditor(editor) === value)) return;
    renderEditorValue(editor, value, nodes);
  }, [value, nodes]);

  const closeMentionMenu = () => {
    setMentionQuery(null);
    setMenuPosition(null);
    setActiveMentionIndex(0);
  };

  const saveRangeAndQuery = () => {
    const editor = editorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection?.rangeCount) return closeMentionMenu();
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer)) return closeMentionMenu();
    rangeRef.current = range.cloneRange();
    const beforeRange = range.cloneRange();
    beforeRange.selectNodeContents(editor);
    beforeRange.setEnd(range.startContainer, range.startOffset);
    const before = beforeRange.toString();
    const lastAt = before.lastIndexOf('@');
    const query = lastAt >= 0 ? before.slice(lastAt + 1) : '';
    if (lastAt < 0 || /[\s\n]/.test(query)) return closeMentionMenu();
    const rect = range.getBoundingClientRect();
    const editorRect = editor.getBoundingClientRect();
    setMentionQuery(query);
    setActiveMentionIndex(0);
    setMenuPosition({
      left: Math.max(0, rect.left - editorRect.left),
      top: Math.max(0, rect.bottom - editorRect.top + 4),
    });
  };

  const handleInput = () => {
    const editor = editorRef.current;
    if (!editor) return;
    onChange(serializeEditor(editor));
    saveRangeAndQuery();
  };

  const insertMention = (node: PromptMentionNode) => {
    const editor = editorRef.current;
    const range = rangeRef.current;
    if (!editor || !range) return;
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      const textNode = range.startContainer as Text;
      const before = textNode.data.slice(0, range.startOffset);
      const lastAt = before.lastIndexOf('@');
      if (lastAt >= 0) {
        textNode.deleteData(lastAt, range.startOffset - lastAt);
        range.setStart(textNode, lastAt);
        range.collapse(true);
      }
    }
    const token = createMentionToken(node);
    const spacer = document.createTextNode(' ');
    range.insertNode(spacer);
    range.insertNode(token);
    range.setStartAfter(spacer);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    editor.focus();
    closeMentionMenu();
    onChange(serializeEditor(editor));
  };

  const filteredNodes = nodes.filter((node) => !mentionQuery || node.label.toLowerCase().includes(mentionQuery.toLowerCase()));
  const selectActiveMention = () => {
    const node = filteredNodes[activeMentionIndex];
    if (node) insertMention(node);
  };

  return (
    <div className="relative">
      {!value && <span className="pointer-events-none absolute left-3 top-2.5 text-sm text-dark-500">{placeholder}</span>}
      <div
        ref={editorRef}
        role="textbox"
        aria-label="提示词"
        aria-multiline="true"
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        onMouseUp={saveRangeAndQuery}
        onKeyDown={(event) => {
          if (mentionQuery === null) {
            if (event.key === 'Escape') closeMentionMenu();
            return;
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            closeMentionMenu();
          } else if (event.key === 'ArrowDown' && filteredNodes.length) {
            event.preventDefault();
            setActiveMentionIndex((index) => (index + 1) % filteredNodes.length);
          } else if (event.key === 'ArrowUp' && filteredNodes.length) {
            event.preventDefault();
            setActiveMentionIndex((index) => (index - 1 + filteredNodes.length) % filteredNodes.length);
          } else if ((event.key === 'Enter' || event.key === 'Tab') && filteredNodes.length) {
            event.preventDefault();
            selectActiveMention();
          }
        }}
        className={`${minHeightClass} w-full overflow-y-auto whitespace-pre-wrap rounded-lg border border-dark-600 bg-dark-700 px-3 py-2 text-sm text-white outline-none focus:border-primary-500`}
      />
      {mentionQuery !== null && menuPosition && (
        <div
          className="absolute z-50 max-h-44 min-w-56 max-w-[min(20rem,calc(100%-0.5rem))] overflow-y-auto rounded-lg border border-dark-600 bg-dark-900 p-1 shadow-xl"
          style={{ left: menuPosition.left, top: menuPosition.top }}
          data-testid="mention-menu"
        >
          {filteredNodes.length ? filteredNodes.map((node) => (
            <button
              key={node.id}
              type="button"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => insertMention(node)}
              className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs ${filteredNodes[activeMentionIndex]?.id === node.id ? 'bg-primary-600/30 text-white' : 'text-dark-200 hover:bg-primary-600/20 hover:text-white'}`}
              aria-selected={filteredNodes[activeMentionIndex]?.id === node.id}
              data-testid={`mention-option-${node.id}`}
            >
              <span className="flex h-8 w-10 shrink-0 items-center justify-center overflow-hidden rounded border border-dark-600 bg-dark-800">
                {node.type === 'image' && node.imageUrl ? <MentionThumbnail source={node.imageUrl} /> : <ImageIcon className="h-4 w-4 text-dark-400" />}
              </span>
              <span className="truncate">{node.label}</span>
            </button>
          )) : <div className="px-2 py-3 text-center text-xs text-dark-500">没有匹配的画布目标</div>}
        </div>
      )}
    </div>
  );
}
