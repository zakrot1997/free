// preload اللوحة الخارجية: أصغر واجهة ممكنة تُعرض لصفحة الموقع غير الموثوقة.
// لا وصول لـNode ولا للملفات — فقط: تنفيذ أمر (يمرّ ببوابة الموافقة في العملية
// الرئيسية) وضغط Enter. وكل ما يعود من الموقع يُعامَل كغير موثوق.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('fcBridge', {
  version: 1,
  /** يرسل نص الأمر كما كتبه الموقع ويعيد نص النتيجة ليلصقه في خانة الدردشة */
  call: (raw: string): Promise<string> => ipcRenderer.invoke('extbridge:call', String(raw ?? '')),
  /** ضغط Enter حقيقي (للمواقع التي لا زرّ إرسال فيها) */
  enter: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('extbridge:enter'),
  hello: (): Promise<{ ok: boolean; version: number }> => ipcRenderer.invoke('extbridge:hello'),
});
