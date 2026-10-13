import { $, clear } from './util';
import { icon } from './icons';
import { S, hooks } from './state';
import { addNotice, addUser, clearChat, handleChatEvent, initChat, loadItems, renderWelcome, showAgentDiff } from './chat';
import { fillInput, focusInput, initComposer, loadCustomCommands, loadSkills, setBusy, setUsage, syncComposer } from './composer';
import { initPanels, openFile, refreshAgents, refreshSessions, refreshTree, setChanges, setTodos, setWorkspaceName } from './panels';
import { initSettings, openSettings, refreshBridgeUi, setConnection, testConnection } from './settings';
import { clearPendingImages, pendingImages } from './attach';
import { initVoice } from './voice';

function setTitle(text: string): void {
  $('title').textContent = text || 'محادثة جديدة';
}

function applySettings(s: Settings): void {
  const wsChanged = S.settings?.workspace !== s.workspace;
  const keyChanged = S.settings?.hasKey !== s.hasKey;
  S.settings = s;
  setWorkspaceName(s.workspace);
  syncComposer(s);
  if (wsChanged) {
    void loadCustomCommands();
    void loadSkills();
    void refreshAgents();
  }
  // الشاشة الافتتاحية تعكس حالة الإعداد، لكن لا نلمس محادثة جارية
  if (!S.hasMessages && (wsChanged || keyChanged)) renderWelcome();
}

async function pickWorkspace(): Promise<void> {
  const s = await window.api.pickWorkspace();
  if (!s) return;
  applySettings(s);
  await hooks.newChat();
  await refreshTree();
}

async function newChat(): Promise<void> {
  if (S.busy) return;
  await window.api.newSession();
  clearChat();
  setTodos([]);
  setChanges([], 0);
  setUsage(0, S.settings?.tokenBudget ?? 28000);
  setTitle('');
  renderWelcome();
  await refreshSessionList();
  focusInput();
}

async function openSession(id: string): Promise<void> {
  if (S.busy) return;
  const res = await window.api.loadSession(id);
  if (!res) return;
  applySettings(res.settings);
  loadItems(res.items);
  setTodos(res.todos);
  setChanges([], 0);
  const first = res.items.find((i) => i.type === 'user');
  setTitle(first && first.type === 'user' ? first.text.slice(0, 60) : '');
  await Promise.all([refreshTree(), refreshSessionList()]);
}

function refreshSessionList(): Promise<void> {
  return refreshSessions((id) => void openSession(id));
}

async function sendMessage(text: string): Promise<void> {
  if (S.busy) return;
  const images = pendingImages();
  if (!S.hasMessages) setTitle(text.slice(0, 60));
  addUser(text, [], images);
  clearPendingImages();
  setBusy(true);
  await window.api.send(text, images);
}

function onEvent(e: AgentEvent): void {
  switch (e.type) {
    case 'todos':
      setTodos(e.todos);
      break;
    case 'changes':
      setChanges(e.changes, e.undoDepth);
      break;
    case 'usage':
      setUsage(e.tokens, e.budget);
      break;
    case 'sessions_changed':
      void refreshSessionList();
      break;
    case 'sweep':
      addNotice(`${e.ok ? '✅' : '⚠️'} جرد دوري تلقائي: ${e.note}`, e.ok ? '' : 'err');
      break;
    case 'bridge':
      void refreshBridgeUi(); // نافذة الإعدادات مفتوحة؟ نحدّث حالة الجسر فوراً
      break;
    case 'done':
      handleChatEvent(e);
      setBusy(false);
      void refreshTree(); // الوكيل قد يكون أنشأ ملفات
      break;
    default:
      handleChatEvent(e);
  }
}

async function boot(): Promise<void> {
  for (const el of document.querySelectorAll<HTMLElement>('[data-icon]')) {
    el.prepend(icon(el.dataset.icon!, Number(el.dataset.size ?? 16)));
  }

  hooks.newChat = newChat;
  hooks.openSettings = openSettings;
  hooks.fillInput = fillInput;
  hooks.pickWorkspace = pickWorkspace;
  hooks.refreshSessions = refreshSessionList;
  hooks.openFile = openFile;
  hooks.applySettings = applySettings;
  hooks.sendMessage = sendMessage;
  hooks.notice = (text: string, kind: '' | 'err' = '') => addNotice(text, kind);
  hooks.showAgentDiff = showAgentDiff;

  initChat();
  initPanels();
  initVoice();
  initComposer();
  initSettings();

  window.api.onEvent(onEvent);

  const s = await window.api.getSettings();
  applySettings(s);
  setUsage(0, s.tokenBudget);
  clear($('chat'));
  renderWelcome();
  await Promise.all([refreshTree(), refreshSessionList()]);
  focusInput();

  if (s.hasKey) void testConnection();
  else setConnection('');
}

void boot();
