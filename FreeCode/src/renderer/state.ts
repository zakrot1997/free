// حالة مشتركة وخطافات بين الوحدات (تجنباً للاستيراد الدائري).
export const S = {
  settings: null as Settings | null,
  busy: false,
  stick: true, // هل المستخدم قرب أسفل المحادثة؟ إن لا، لا نسحبه للأسفل أثناء البث
  hasMessages: false,
};

export const hooks = {
  newChat: async (): Promise<void> => {},
  openSettings: (_focus?: 'model' | 'key'): void => {},
  fillInput: (_text: string): void => {},
  pickWorkspace: async (): Promise<void> => {},
  refreshSessions: async (): Promise<void> => {},
  openFile: async (_rel: string): Promise<void> => {},
  applySettings: (_s: Settings): void => {},
  sendMessage: async (_text: string): Promise<void> => {},
  notice: (_text: string, _kind: '' | 'err' = ''): void => {},
  showAgentDiff: (_label: string, _text: string): void => {},
};

/** نفس منطق التطبيع في العملية الرئيسية، لعرض العنوان الفعلي أثناء الكتابة */
export function normalizeEndpoint(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (!u) return '';
  if (!/^https?:\/\//i.test(u)) u = `http://${u}`;
  if (!/\/v\d+$/i.test(u)) u += '/v1';
  return u;
}
