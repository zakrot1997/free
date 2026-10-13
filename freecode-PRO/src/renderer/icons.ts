// أيقونات خطية بسيطة (SVG ثابتة من عندنا، لا محتوى خارجي).
const PATHS: Record<string, string> = {
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  check: '<path d="M5 12l5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  undo: '<path d="M9 14L4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/>',
  chevron: '<path d="M9 6l6 6-6 6"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/>',
  mic: '<path d="M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3z"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  terminal: '<path d="M4 6l6 6-6 6"/><path d="M12 18h8"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4-4"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>',
  shield: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>',
  bolt: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  compass: '<circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5z"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17h.01"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  paperclip: '<path d="M20 11l-8 8a5 5 0 0 1-7-7l9-9a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M4 18l5-5 4 4 3-2 4 4"/>',
};

export function icon(name: keyof typeof PATHS | string, size = 16): SVGSVGElement {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATHS[name] ?? ''}</svg>`;
  return wrap.firstElementChild as SVGSVGElement;
}

/** أيقونة وتسمية لكل أداة */
export const TOOL_META: Record<string, { icon: string; label: string }> = {
  list_dir: { icon: 'folder', label: 'عرض مجلد' },
  read_file: { icon: 'file', label: 'قراءة' },
  glob: { icon: 'search', label: 'بحث عن ملفات' },
  search: { icon: 'search', label: 'بحث في الكود' },
  write_file: { icon: 'edit', label: 'كتابة ملف' },
  edit_file: { icon: 'edit', label: 'تعديل' },
  run_command: { icon: 'terminal', label: 'أمر' },
  web_fetch: { icon: 'globe', label: 'جلب صفحة' },
  todo_write: { icon: 'list', label: 'تحديث الخطة' },
  task: { icon: 'compass', label: 'وكيل فرعي' },
};

/** أدوات MCP تأتي بالاسم mcp__server__tool */
export function toolMeta(name: string): { icon: string; label: string } {
  if (TOOL_META[name]) return TOOL_META[name];
  const m = /^mcp__(.+?)__(.+)$/.exec(name);
  if (m) return { icon: 'bolt', label: `${m[1]} › ${m[2]}` };
  return { icon: 'bolt', label: name };
}

export function toolSummary(name: string, args: any): string {
  if (!args || typeof args !== 'object') return '';
  switch (name) {
    case 'run_command':
      return String(args.command ?? '');
    case 'search':
      return `${args.pattern ?? ''}${args.include ? `  (${args.include})` : ''}`;
    case 'glob':
      return String(args.pattern ?? '');
    case 'web_fetch':
      return String(args.url ?? '');
    case 'todo_write':
      return Array.isArray(args.todos) ? `${args.todos.length} خطوات` : '';
    case 'task':
      return String(args.description ?? args.prompt ?? '').replace(/\s+/g, ' ').slice(0, 120);
    case 'read_file':
      return `${args.path ?? ''}${args.start_line ? `:${args.start_line}-${args.end_line ?? ''}` : ''}`;
    default:
      if (name.startsWith('mcp__')) return JSON.stringify(args).slice(0, 120);
      return String(args.path ?? '');
  }
}
