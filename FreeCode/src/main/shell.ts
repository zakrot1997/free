// تشغيل أوامر shell بطريقة موثوقة: يُغلق stdin (فلا تعلق الأوامر التفاعلية)،
// وعند المهلة أو الإيقاف تُقتل شجرة العمليات كاملة (وليس الـ shell وحده).
import { spawn, execFile, type ChildProcess } from 'node:child_process';

export interface ShellOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  /** نص يُرسل إلى stdin ثم يُغلق (مثلاً JSON للـ hooks) */
  input?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onOutput?: (chunk: string) => void;
}

export interface ShellResult {
  code: number | null;
  output: string;
  timedOut: boolean;
  aborted: boolean;
}

/** العمليات الجارية الآن، حتى نقتلها كلها عند إغلاق التطبيق فلا تبقى عمليات يتيمة */
const active = new Set<ChildProcess>();

export function activeShellCount(): number {
  return active.size;
}

/** يقتل كل العمليات الجارية (يُستدعى عند الخروج) */
export function killAllShells(): number {
  const n = active.size;
  for (const child of [...active]) killTree(child);
  return n;
}

/** يقتل العملية وكل أبنائها */
export function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL'); // مجموعة العمليات (نشغّلها detached)
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* انتهت أصلاً */
    }
  }
}

export function runShell(command: string, o: ShellOptions): Promise<ShellResult> {
  return new Promise((resolve) => {
    let out = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const child = spawn(command, {
      cwd: o.cwd,
      shell: true,
      env: o.env ?? process.env,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    active.add(child);

    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      active.delete(child);
      clearTimeout(timer);
      clearTimeout(fallback);
      o.signal?.removeEventListener('abort', onAbort);
      resolve({ code, output: out, timedOut, aborted });
    };

    const push = (b: Buffer) => {
      const s = b.toString('utf8');
      out += s;
      if (out.length > 200_000) out = out.slice(-100_000);
      o.onOutput?.(s);
    };
    child.stdout.on('data', push);
    child.stderr.on('data', push);
    child.stdin.on('error', () => {});
    child.stdin.end(o.input ?? '');

    let fallback: NodeJS.Timeout | undefined;
    // بعد القتل ننتظر إغلاق الأنابيب قليلاً ثم نُنهي حتى لو بقي حامل لها
    const kill = () => {
      killTree(child);
      fallback = setTimeout(() => finish(null), 2000);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, o.timeoutMs);

    const onAbort = () => {
      aborted = true;
      kill();
    };
    if (o.signal?.aborted) onAbort();
    else o.signal?.addEventListener('abort', onAbort, { once: true });

    child.on('error', (e) => {
      out += `خطأ في التشغيل: ${e.message}`;
      finish(null);
    });
    child.on('close', (code) => finish(code));
  });
}


// ---------- العمليات الخلفية (خوادم تطوير، مراقبات، أوامر طويلة) ----------
//
// run_command له مهلة 120 ثانية، فلا يصلح لخادم تطوير يعمل باستمرار. هنا نحتفظ بعمليات
// حيّة بمعرّف، ونقرأ مخرجاتها عند الطلب، ونوقفها صراحة أو عند إغلاق التطبيق.

export interface ManagedProcess {
  id: string;
  command: string;
  pid: number | undefined;
  startedAt: number;
  code: number | null;
  output: string;
}

const processes = new Map<string, ManagedProcess>();
const children = new Map<string, ChildProcess>();
let processSeq = 0;

const MAX_BUFFER = 80_000;

export function startManagedProcess(command: string, opts: { cwd: string; env?: NodeJS.ProcessEnv }): ManagedProcess {
  const id = `p${++processSeq}`;
  const child = spawn(command, {
    cwd: opts.cwd,
    shell: true,
    env: opts.env ?? process.env,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  active.add(child);
  const proc: ManagedProcess = { id, command, pid: child.pid, startedAt: Date.now(), code: null, output: '' };
  processes.set(id, proc);
  children.set(id, child);

  const push = (b: Buffer) => {
    proc.output += b.toString('utf8');
    if (proc.output.length > MAX_BUFFER) proc.output = proc.output.slice(-MAX_BUFFER / 2);
  };
  child.stdout?.on('data', push);
  child.stderr?.on('data', push);
  child.on('error', (e) => {
    proc.code = -1;
    proc.output += `\n[تعذّر التشغيل: ${e.message}]`;
  });
  child.on('close', (code) => {
    proc.code = code ?? -1;
    proc.output += `\n[انتهت العملية بالرمز ${code ?? '؟'}]`;
    active.delete(child);
    children.delete(id);
  });
  return proc;
}

export function managedProcess(id: string): ManagedProcess | undefined {
  return processes.get(id);
}

export function listManagedProcesses(): ManagedProcess[] {
  return [...processes.values()];
}

export function stopManagedProcess(id: string): boolean {
  const child = children.get(id);
  if (!child) return false;
  killTree(child);
  children.delete(id);
  return true;
}

export function stopAllManagedProcesses(): number {
  let n = 0;
  for (const [, child] of [...children]) {
    killTree(child);
    n++;
  }
  children.clear();
  return n;
}
